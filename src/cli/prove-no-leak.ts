/** `pnpm prove` — run the pipeline, then prove no patient value reached the model. */
import { canaryRecord } from '../lib/canary.js';
import { adjudicateCandidates, checkTextAgainstData, sessionVisibleText } from '../lib/boundary.js';
import { assertHarnessReachable, createClient, readRunConfig } from '../lib/client.js';
import { patternCandidates, scanModelVisibleText } from '../lib/pii-guard.js';
import { SANDBOX_WORK_DIR } from '../lib/sandbox.js';
import { runIngest } from '../pipeline/ingest.js';
import { runScrubAndAnalyze } from '../pipeline/scrub-analyze.js';

function rule(): string {
  return '━'.repeat(74);
}

async function main(): Promise<void> {
  const runConfig = readRunConfig();
  await assertHarnessReachable(runConfig);
  const client = createClient(runConfig);

  const started = Date.now();
  const step = (m: string): void =>
    console.log(`  · [${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

  console.log('Running the full pipeline, then checking every byte the model could see.\n');

  // Always a fresh session: the claim is about one clean end-to-end run.
  const ingest = await runIngest({ fresh: true, onStep: step }, runConfig, client);
  const stage = await runScrubAndAnalyze(
    ingest.sessionId,
    ingest.verdict,
    ingest.canaries,
    ingest.runId,
    { onStep: step },
    runConfig,
    client,
  );

  step('collecting every event from every turn and thread');
  // strict: this command claims a complete scan, so it must fail rather than quietly
  // narrow to a single turn if the session history cannot be retrieved.
  const scanned = await sessionVisibleText(client, ingest.sessionId, stage.index, true);
  const guard = scanModelVisibleText(scanned, { canaries: canaryRecord(ingest.canaries) });

  // An identifier-shaped string is not proof of anything by itself: the agent writes
  // code containing example dates and formats. Ask the sandbox whether any of them
  // actually occur in the data.
  const candidates = patternCandidates(guard);
  let adjudicated = 0;
  if (candidates.length > 0) {
    step(`adjudicating ${candidates.length} identifier-shaped strings against the data`);
    adjudicated = await adjudicateCandidates(client, ingest.sessionId, candidates, [
      `${SANDBOX_WORK_DIR}/trial_raw.csv`,
      `${SANDBOX_WORK_DIR}/scrubbed.csv`,
    ]);
  }

  // Shapes are not enough. A patient name and a study id match no pattern, so the
  // whole transcript is compared against every value in the identifier columns —
  // inside the sandbox, with only counts coming back.
  step('comparing the transcript against every identifier value in the dataset');
  const valueCheck = await checkTextAgainstData(
    client,
    ingest.sessionId,
    scanned,
    ingest.verdict.pii_columns,
  );

  const canaryHits = guard.hits.filter((h) => h.severity === 'canary').length;
  const passed = canaryHits === 0 && adjudicated === 0 && !valueCheck.leaked;

  console.log(`\n${rule()}`);
  console.log('  PII BOUNDARY PROOF');
  console.log(rule());
  console.log(`  Canary SSN            ${ingest.canaries.ssn}`);
  console.log(`  Canary name           ${ingest.canaries.name}`);
  console.log(
    `  Planted in            row ${ingest.canaries.rowIndex} (${ingest.canaries.subjectId})`,
  );
  console.log(`  Minted                inside the sandbox, never printed, never told to the model`);
  console.log('');
  console.log(`  Rows of patient data  ${ingest.verdict.row_count}`);
  console.log(`  Identifier columns    ${ingest.verdict.pii_columns.length}`);
  console.log(`  Subagent threads      ${stage.subagentThreadIds.length}`);
  console.log(`  Model-visible text    ${scanned.length.toLocaleString()} characters scanned`);
  console.log('');
  console.log(
    `  Canary in model context:            ${canaryHits === 0 ? 'NO' : `YES (${canaryHits})`}`,
  );
  console.log(
    `  Identifier-shaped lookalikes:       ${
      candidates.length === 0
        ? 'none'
        : `${candidates.length} checked against the data, ${adjudicated} were real`
    }`,
  );
  console.log(
    `  Raw patient values in model context: ${
      valueCheck.leaked
        ? `FOUND in ${valueCheck.matches.map((m) => m.column).join(', ')}`
        : `NONE (${valueCheck.valuesCompared.toLocaleString()} identifier values compared)`
    }`,
  );
  console.log(rule());
  console.log(
    `  ${passed ? 'PASS — the boundary held.' : 'FAIL — patient data crossed the boundary.'}`,
  );
  console.log(`${rule()}\n`);

  if (!passed) {
    console.error('Every hit, with values masked:');
    for (const hit of guard.hits) {
      console.error(`  [${hit.severity}] ${hit.label} @${hit.index}  ${hit.excerpt}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
