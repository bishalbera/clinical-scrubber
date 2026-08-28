/**
 * Runs ingest, scrub and analysis, then asks the agent to release the report. That
 * call is gated, so the turn pauses and this prints the review packet: both
 * agent-authored scripts in full, the aggregate results, and what would be released.
 * Approve and it proceeds; deny with a reason and the agent revises and comes back.
 */

import { createInterface } from 'node:readline/promises';

import { assertBoundaryHolds } from '../lib/boundary.js';
import { assertHarnessReachable, createClient, readRunConfig } from '../lib/client.js';
import { EventIndex, type IndexedEvent } from '../lib/event-index.js';
import { formatGuardResult } from '../lib/pii-guard.js';
import { SANDBOX_WORK_DIR } from '../lib/sandbox.js';
import { releasedReports, startReportServer } from '../mcp/report-server.js';
import {
  formatReviewPacket,
  runApprovalLoop,
  type ReviewDecision,
  type ReviewPacket,
} from '../pipeline/approval.js';
import { runIngest } from '../pipeline/ingest.js';
import { runScrubAndAnalyze } from '../pipeline/scrub-analyze.js';

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
      { onStep: step },
      runConfig,
      client,
    );

    heading('Requesting release (this will pause for the CMO)');
    const index = new EventIndex();
    const stream = await client.sessions.createTurnStream(ingest.sessionId, {
      input: [
        {
          type: 'user.message',
          content:
            'Draft the final research summary from the aggregate results only, then call ' +
            `${'`generate_final_report`'} to release it. Do not include any participant-level ` +
            'value. Keep the summary under 1500 characters.',
        },
      ],
    });
    for await (const { data: event, id } of stream.withMetadata()) {
      index.add(event as unknown as IndexedEvent, id);
    }

    const outcome = await runApprovalLoop(
      index,
      (pending) => ({
        scrubScript: stage.scrubScript,
        analyzeScript: stage.analyzeScript,
        analysis: stage.analysis,
        proposed: pending,
      }),
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
        }
        return resumed;
      },
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

    heading('Boundary check across the whole run');
    const guard = await assertBoundaryHolds(client, ingest.sessionId, index, ingest.canaries, {
      stage: 'report release',
      dataPaths: [`${SANDBOX_WORK_DIR}/trial_raw.csv`, `${SANDBOX_WORK_DIR}/scrubbed.csv`],
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
