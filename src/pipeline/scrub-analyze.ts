/**
 * Phase 3: two subagents, both working only through the sandbox.
 *
 * Compliance authors `scrub.py` from the column verdict and produces `scrubbed.csv`.
 * Bio-Stat authors `analyze.py` and reports aggregates. Neither returns a patient
 * value, and the scripts they write are pulled back over the file endpoint rather
 * than scraped out of the transcript, so what the CMO reviews in Phase 4 is the exact
 * text that ran.
 */

import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertBoundaryHolds } from '../lib/boundary.js';
import type { CanarySet } from '../lib/canary.js';
import { createClient, readRunConfig, type RunConfig } from '../lib/client.js';
import { EventIndex, MAIN_THREAD, type IndexedEvent } from '../lib/event-index.js';
import type { GuardResult } from '../lib/pii-guard.js';
import {
  downloadSandboxText,
  execResults,
  extractJsonObjects,
  fileAttachment,
  SANDBOX_UPLOAD_DIR,
  SANDBOX_WORK_DIR,
} from '../lib/sandbox.js';
import { writeStoredSession } from '../lib/session-store.js';
import type { Verdict } from './ingest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = resolve(HERE, '../../python');

const SCRUB_PY = `${SANDBOX_WORK_DIR}/scrub.py`;
const ANALYZE_PY = `${SANDBOX_WORK_DIR}/analyze.py`;
const SCRUBBED_CSV = `${SANDBOX_WORK_DIR}/scrubbed.csv`;
const ANALYSIS_JSON = `${SANDBOX_WORK_DIR}/analysis.json`;

export interface ScrubVerification {
  readonly passed: boolean;
  readonly canaryPresent: boolean | null;
  readonly survivingIdentifierColumns: ReadonlyArray<{ name: string; pii_type: string }>;
  readonly columns: readonly string[];
  readonly rowCount: number;
}

export interface ScrubAnalyzeResult {
  readonly turnId: string;
  /** Exact text of the agent-authored scripts, for CMO review in Phase 4. */
  readonly scrubScript: string;
  readonly analyzeScript: string;
  readonly verification: ScrubVerification;
  readonly analysis: Record<string, unknown>;
  readonly subagentThreadIds: readonly string[];
  readonly guard: GuardResult;
  readonly index: EventIndex;
}

export interface ScrubAnalyzeOptions {
  readonly onStep?: (message: string) => void;
  readonly onEvent?: (event: IndexedEvent) => void;
}

function buildRequest(verdict: Verdict): string {
  const pii = verdict.pii_columns.join(', ');
  const keep = verdict.columns
    .filter((c) => c.pii_type === null)
    .map((c) => c.name)
    .join(', ');

  return `The raw dataset is at ${SANDBOX_WORK_DIR}/trial_raw.csv (${verdict.row_count} rows).
Classification found identifier columns: ${pii}.
Analysis columns: ${keep}.

Do this in two delegated steps, one subagent each, in order.

STEP 1 — Compliance. Give a subagent this task:
  Write ${SCRUB_PY} using pandas, then run it to produce ${SCRUBBED_CSV}.
  Rules:
    - Drop outright: patient_name, ssn, address, email, phone.
    - Replace mrn with a stable pseudo-id: sha256 of the value, first 12 hex chars,
      in a new column subject_pseudo_id. Drop the original mrn.
    - Replace dob with a 10-year age_band string (for example "45-54"), computed
      against 2026-01-01. Drop the original dob. Dates arrive in four formats, so
      parse defensively.
    - Keep the analysis columns, normalised: arm lowercased and trimmed to exactly
      "treatment" or "placebo"; baseline, followup and outcome_measure as floats with
      any unit suffix stripped; adverse_event as a 0/1 integer.
    - Leave rows with missing outcome data in place; do not drop participants.
  Then run:
    python3 ${SANDBOX_UPLOAD_DIR}/verify_scrub.py ${SCRUBBED_CSV} --canary ${SANDBOX_WORK_DIR}/.canary.json
  Report the verifier's JSON verbatim, plus how many columns were dropped, hashed and
  coarsened. Report counts only, never a value from any column.

STEP 2 — Bio-Stat. Only after step 1 reports passed=true, give a second subagent this:
  Run: pip install --quiet scipy
  Write ${ANALYZE_PY} using pandas and scipy, then run it against ${SCRUBBED_CSV}.
  Primary endpoint: outcome_measure, treatment vs placebo, Welch's t-test
  (scipy.stats.ttest_ind with equal_var=False). Report per arm n, mean and SD; the
  mean difference; a 95% confidence interval for the difference; the t statistic; the
  p-value; and Cohen's d.
  Safety endpoint: adverse_event by arm, chi-square test of independence
  (scipy.stats.chi2_contingency), reporting the contingency counts, chi-square, and p.
  Write the results as JSON to ${ANALYSIS_JSON} and print that JSON.
  Report the aggregate numbers only. Never print a participant row.

Then summarise: what the scrub removed, and the headline statistics.`;
}

function toVerification(payload: Record<string, unknown>): ScrubVerification {
  const survivors = Array.isArray(payload.surviving_identifier_columns)
    ? (payload.surviving_identifier_columns as Array<{ name: string; pii_type: string }>)
    : [];
  return {
    passed: payload.passed === true,
    canaryPresent: typeof payload.canary_present === 'boolean' ? payload.canary_present : null,
    survivingIdentifierColumns: survivors,
    columns: Array.isArray(payload.columns) ? (payload.columns as string[]) : [],
    rowCount: typeof payload.row_count === 'number' ? payload.row_count : -1,
  };
}

function isVerification(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).check === 'scrub'
  );
}

function isAnalysis(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const keys = Object.keys(value as Record<string, unknown>)
    .join(' ')
    .toLowerCase();
  return keys.includes('p_value') || keys.includes('primary') || keys.includes('t_statistic');
}

/**
 * Run the scrub-and-analyse turn.
 *
 * Throws if the canary reached model context, if the scrub verifier failed, or if the
 * agent-authored scripts are missing — any of which means the run cannot be trusted.
 */
export async function runScrubAndAnalyze(
  sessionId: string,
  verdict: Verdict,
  canaries: CanarySet,
  options: ScrubAnalyzeOptions = {},
  runConfig: RunConfig = readRunConfig(),
  client: TrueForge = createClient(runConfig),
): Promise<ScrubAnalyzeResult> {
  const { onStep, onEvent } = options;
  const index = new EventIndex();
  let turnStatus: string | undefined;

  onStep?.('delegating scrub and analysis');
  const stream = await client.sessions.createTurnStream(sessionId, {
    input: [
      {
        type: 'user.message',
        content: [
          { type: 'text', text: buildRequest(verdict) },
          fileAttachment(resolve(PYTHON_DIR, 'verify_scrub.py')),
          fileAttachment(resolve(PYTHON_DIR, 'classify.py')),
        ],
      },
    ],
  });

  for await (const { data: event, id } of stream.withMetadata()) {
    const typed = event as unknown as IndexedEvent;
    index.add(typed, id);
    onEvent?.(typed);

    if (typed.type === 'thread.created')
      onStep?.(`subagent thread ${String(typed.threadId ?? '')}`);
    if (typed.type === 'turn.done') {
      turnStatus = (typed as { state?: { status?: string } }).state?.status;
    }
  }

  if (turnStatus !== 'done') {
    throw new Error(`Scrub/analyse turn ended with status "${turnStatus ?? 'unknown'}".`);
  }

  const turnId = index.turnId;
  if (turnId === undefined) throw new Error('No turn id captured for the scrub/analyse turn.');
  writeStoredSession({ sessionId, lastTurnId: turnId, model: runConfig.model });

  const guard = await assertBoundaryHolds(client, sessionId, index, canaries, {
    stage: 'scrub/analyse',
    // Both files exist by now, and the scrubbed one is what the analysis read.
    dataPaths: [`${SANDBOX_WORK_DIR}/trial_raw.csv`, SCRUBBED_CSV],
    onStep,
  });

  onStep?.('retrieving agent-authored scripts');
  const [scrubScript, analyzeScript] = await Promise.all([
    downloadSandboxText(client, sessionId, turnId, SCRUB_PY),
    downloadSandboxText(client, sessionId, turnId, ANALYZE_PY),
  ]);

  const outputs = execResults(index.allEvents()).flatMap((r) => extractJsonObjects(r.output));
  const verificationPayload = outputs.find(isVerification);
  if (verificationPayload === undefined) {
    throw new Error('The scrub verifier did not report. Refusing to treat the scrub as done.');
  }
  const verification = toVerification(verificationPayload);
  if (!verification.passed) {
    throw new Error(
      `Scrub verification FAILED. Surviving identifier columns: ` +
        `${verification.survivingIdentifierColumns.map((c) => `${c.name} (${c.pii_type})`).join(', ') || 'none'}; ` +
        `canary present: ${String(verification.canaryPresent)}.`,
    );
  }

  let analysis = outputs.find(isAnalysis) ?? {};
  if (Object.keys(analysis).length === 0) {
    analysis = JSON.parse(
      await downloadSandboxText(client, sessionId, turnId, ANALYSIS_JSON),
    ) as Record<string, unknown>;
  }

  return {
    turnId,
    scrubScript,
    analyzeScript,
    verification,
    analysis,
    subagentThreadIds: index.threadIds().filter((t) => t !== MAIN_THREAD && !t.startsWith('__')),
    guard,
    index,
  };
}
