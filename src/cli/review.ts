/** `pnpm review` — the full pipeline, pausing for CMO approval. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { assertBoundaryHolds, checkTextAgainstData } from '../lib/boundary.js';
import { canaryRecord } from '../lib/canary.js';
import { assertHarnessReachable, createClient, readRunConfig } from '../lib/client.js';
import { EventIndex, type IndexedEvent } from '../lib/event-index.js';
import { formatGuardResult, scanModelVisibleText } from '../lib/pii-guard.js';
import { downloadSandboxText, SANDBOX_WORK_DIR } from '../lib/sandbox.js';
import { releasedReports, startReportServer } from '../mcp/report-server.js';
import {
  formatReviewPacket,
  runApprovalLoop,
  type ReviewDecision,
  type ReviewPacket,
} from '../pipeline/approval.js';
import { runIngest } from '../pipeline/ingest.js';
import { runScrubAndAnalyze } from '../pipeline/scrub-analyze.js';

/**
 * The methodology as it stands right now, not as it stood before the first denial.
 *
 * Falls back to what the scrub/analyse stage returned if a re-read fails, so a
 * transient download error shows slightly stale text rather than aborting the review.
 */
async function currentMethodology(
  client: ReturnType<typeof createClient>,
  sessionId: string,
  turnId: string,
  stage: { scrubScript: string; analyzeScript: string; analysis: Record<string, unknown> },
): Promise<{ scrubScript: string; analyzeScript: string; analysis: Record<string, unknown> }> {
  try {
    const [scrubScript, analyzeScript, analysisRaw] = await Promise.all([
      downloadSandboxText(client, sessionId, turnId, `${SANDBOX_WORK_DIR}/scrub.py`),
      downloadSandboxText(client, sessionId, turnId, `${SANDBOX_WORK_DIR}/analyze.py`),
      downloadSandboxText(client, sessionId, turnId, `${SANDBOX_WORK_DIR}/analysis.json`),
    ]);
    return {
      scrubScript,
      analyzeScript,
      analysis: JSON.parse(analysisRaw) as Record<string, unknown>,
    };
  } catch {
    return {
      scrubScript: stage.scrubScript,
      analyzeScript: stage.analyzeScript,
      analysis: stage.analysis,
    };
  }
}

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../out');

function heading(text: string): void {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
}

/** Ask the operator to act as the CMO. `--auto-approve` skips the prompt for the demo. */
async function askCmo(packet: ReviewPacket): Promise<ReviewDecision> {
  console.log(formatReviewPacket(packet));

  if (process.argv.includes('--auto-approve')) {
    console.log('--auto-approve: approving without prompting.\n');
    return { allow: true };
  }
  if (process.argv.includes('--auto-deny')) {
    const reason = 'Use a two-sided Welch t-test and report the confidence interval.';
    console.log(`--auto-deny: denying with "${reason}"\n`);
    return { allow: false, reason };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Approve release? [y]es / [n]o: ')).trim().toLowerCase();
    if (answer.startsWith('y')) return { allow: true };
    const reason = (await rl.question('Reason for denial: ')).trim();
    return { allow: false, reason: reason || 'No reason given.' };
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const runConfig = readRunConfig();
  console.log(`harness  ${runConfig.baseUrl}`);
  console.log(`model    ${runConfig.model}\n`);
  await assertHarnessReachable(runConfig);

  const stopServer = await startReportServer();
  const client = createClient(runConfig);
  const started = Date.now();
  const step = (m: string): void =>
    console.log(`  · [${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

  try {
    const ingest = await runIngest(
      { fresh: process.argv.includes('--fresh'), reportGate: true, onStep: step },
      runConfig,
      client,
    );
    const stage = await runScrubAndAnalyze(
      ingest.sessionId,
      ingest.verdict,
      ingest.canaries,
      ingest.runId,
      { onStep: step, reportGate: true },
      runConfig,
      client,
    );

    // Run-unique: a fixed path in a reused sandbox lets a previous run's report satisfy
    // this one if the agent skips the write but still calls the release tool.
    const reportMd = `${SANDBOX_WORK_DIR}/report-${ingest.runId}.md`;

    heading('Requesting release (this will pause for the CMO)');
    const index = new EventIndex();
    // Accumulates every turn of the approval loop. `sessionVisibleText` falls back to
    // the index it is given when the session listing fails, so that index has to hold
    // the revision rounds too — a leak during round three must not be invisible.
    const wholeRun = new EventIndex();
    const stream = await client.sessions.createTurnStream(ingest.sessionId, {
      input: [
        {
          type: 'user.message',
          content:
            `Write an FDA-style research summary to ${reportMd} using the aggregate ` +
            'results only. Structure it as: Study design; Participants and disposition; ' +
            'Methods (de-identification and statistical); Results (with p-values and ' +
            'confidence intervals); Safety; Limitations. Every number must come from the ' +
            'analysis output — invent nothing, and include no participant-level value.\n\n' +
            `Then call ${'`generate_final_report`'} with a title and a summary under 1500 ` +
            'characters drawn from that document.',
        },
      ],
    });
    for await (const { data: event, id } of stream.withMetadata()) {
      index.add(event as unknown as IndexedEvent, id);
      wholeRun.add(event as unknown as IndexedEvent, id);
    }

    const releasedBefore = releasedReports().length;

    const outcome = await runApprovalLoop(
      index,
      async (pending) => {
        // Re-read rather than reuse: a denial makes the agent revise these, and the
        // reviewer must see the methodology that would actually be released.
        const current = await currentMethodology(
          client,
          ingest.sessionId,
          wholeRun.turnId ?? ingest.turnId,
          stage,
        );
        return { ...current, proposed: pending };
      },
      askCmo,
      async (threadId, toolCallId, decision) => {
        const resumed = new EventIndex();
        const s = await client.sessions.createTurnStream(ingest.sessionId, {
          input: [
            {
              type: 'user.tool_approval',
              threadId,
              toolCallId,
              approval: decision.allow
                ? { status: 'allow' }
                : { status: 'deny', reason: decision.reason },
            },
          ],
        });
        for await (const { data: event, id } of s.withMetadata()) {
          resumed.add(event as unknown as IndexedEvent, id);
          wholeRun.add(event as unknown as IndexedEvent, id);
        }
        return resumed;
      },
      // #3: an allow is only a release if the tool actually ran.
      () => releasedReports().length > releasedBefore,
    );

    heading('CMO decision');
    console.log(`  approved   ${outcome.approved}`);
    console.log(`  rounds     ${outcome.rounds}`);
    for (const [i, reason] of outcome.denials.entries()) {
      console.log(`  denial ${i + 1}   ${reason}`);
    }

    const released = releasedReports();
    console.log(`  released   ${released.length} report(s)`);
    if (!outcome.approved && released.length > 0) {
      throw new Error('A report was released without approval. That must never happen.');
    }
    if (released.at(-1)) console.log(`  title      ${released.at(-1)?.title}`);

    if (outcome.approved) {
      heading('Report artifact');
      const raw = await downloadSandboxText(
        client,
        ingest.sessionId,
        wholeRun.turnId ?? ingest.turnId,
        reportMd,
      );

      // Fetched over the download channel, which the guard never sees. Anything printed
      // or written to disk from there has to be checked here instead.
      // Canary hits are proof and fail immediately. Identifier-shaped hits are not:
      // the report legitimately cites the age-band reference date. Those are settled by
      // the value comparison below, against the real data.
      const reportGuard = scanModelVisibleText(raw, { canaries: canaryRecord(ingest.canaries) });
      if (!reportGuard.canaryClean) {
        throw new Error(
          `${reportMd} contains patient-shaped values and will not be written.\n\n` +
            formatGuardResult(reportGuard),
        );
      }

      // Shapes alone would miss a patient name, which matches no pattern. Compare the
      // draft against the real identifier values inside the sandbox before writing it.
      const valueCheck = await checkTextAgainstData(
        client,
        ingest.sessionId,
        raw,
        ingest.verdict.pii_columns,
      );
      if (valueCheck.leaked) {
        throw new Error(
          `${reportMd} contains real identifier values from ` +
            `${valueCheck.matches.map((m) => m.column).join(', ')} and will not be written.`,
        );
      }
      console.log(`  ${valueCheck.valuesCompared} identifier values compared, none present`);

      mkdirSync(OUT_DIR, { recursive: true });
      const outPath = resolve(OUT_DIR, 'report.md');
      writeFileSync(outPath, raw, 'utf8');
      console.log(`  ${raw.split('\n').length} lines written to ${outPath}`);
    }

    heading('Boundary check across the whole run');
    const guard = await assertBoundaryHolds(client, ingest.sessionId, wholeRun, ingest.canaries, {
      stage: 'report release',
      dataPaths: [`${SANDBOX_WORK_DIR}/trial_raw.csv`, `${SANDBOX_WORK_DIR}/scrubbed.csv`],
      identifierColumns: ingest.verdict.pii_columns,
      onStep: step,
    });
    console.log(formatGuardResult(guard));
  } finally {
    await stopServer();
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
