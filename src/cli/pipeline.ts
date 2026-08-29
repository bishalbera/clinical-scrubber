/**
 * `pnpm pipeline` — ingest, classify, scrub, analyse, and check the boundary across
 * every turn of the run.
 */

import { assertBoundaryHolds } from '../lib/boundary.js';
import { assertHarnessReachable, createClient, readRunConfig } from '../lib/client.js';
import { formatGuardResult } from '../lib/pii-guard.js';
import { SANDBOX_WORK_DIR } from '../lib/sandbox.js';
import { runIngest } from '../pipeline/ingest.js';
import { runScrubAndAnalyze } from '../pipeline/scrub-analyze.js';

function heading(text: string): void {
  console.log(`\n${text}\n${'─'.repeat(text.length)}`);
}

async function main(): Promise<void> {
  const runConfig = readRunConfig();
  const client = createClient(runConfig);
  console.log(`harness  ${runConfig.baseUrl}`);
  console.log(`model    ${runConfig.model}\n`);

  await assertHarnessReachable(runConfig);

  const started = Date.now();
  const at = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const step = (message: string): void => console.log(`  · [${at()}] ${message}`);

  const ingest = await runIngest(
    { fresh: process.argv.includes('--fresh'), onStep: step },
    runConfig,
    client,
  );

  heading('Classification (schema only)');
  for (const column of ingest.verdict.columns) {
    console.log(
      `  ${column.name.padEnd(18)}${(column.pii_type ?? '—').padEnd(12)}${column.match_rate.toFixed(2)}`,
    );
  }

  const stage = await runScrubAndAnalyze(
    ingest.sessionId,
    ingest.verdict,
    ingest.canaries,
    ingest.runId,
    { onStep: step },
    runConfig,
    client,
  );

  heading('Scrub verification (run inside the sandbox)');
  console.log(`  columns kept   ${stage.verification.columns.join(', ')}`);
  console.log(`  rows           ${stage.verification.rowCount}`);
  console.log(`  identifiers    ${stage.verification.survivingIdentifierColumns.length} surviving`);
  console.log(`  canary present ${String(stage.verification.canaryPresent)}`);
  console.log(`  passed         ${stage.verification.passed}`);

  heading('Aggregate results');
  console.log(JSON.stringify(stage.analysis, null, 2).slice(0, 1600));

  heading('Agent-authored methodology (Phase 4 reviews this)');
  console.log(`  scrub.py    ${stage.scrubScript.split('\n').length} lines`);
  console.log(`  analyze.py  ${stage.analyzeScript.split('\n').length} lines`);
  console.log(`  subagent threads: ${stage.subagentThreadIds.length}`);

  // Adjudicated, not merely reported: identifier-shaped strings get checked against
  // the real data inside the sandbox, so the headline is a verdict rather than a
  // list for someone to eyeball.
  heading('Boundary check across the whole run');
  const guard = await assertBoundaryHolds(client, ingest.sessionId, stage.index, ingest.canaries, {
    stage: 'full run',
    dataPaths: [`${SANDBOX_WORK_DIR}/trial_raw.csv`, `${SANDBOX_WORK_DIR}/scrubbed.csv`],
    identifierColumns: ingest.verdict.pii_columns,
    onStep: step,
  });
  console.log(formatGuardResult(guard));
  if (guard.hits.some((h) => h.severity === 'pattern')) {
    console.log('\nThose were checked against the raw data inside the sandbox and none occur');
    console.log('there, so they are agent-authored text, not patient values. A run where any');
    console.log('of them did occur would have thrown before reaching this line.');
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
