/** Compliance and Bio-Stat subagents: scrub, verify, analyse. */
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertBoundaryHolds } from '../lib/boundary.js';
import { canaryRecord, type CanarySet } from '../lib/canary.js';
import { createClient, readRunConfig, type RunConfig } from '../lib/client.js';
import { EventIndex, MAIN_THREAD, type IndexedEvent } from '../lib/event-index.js';
import { formatGuardResult, scanModelVisibleText, type GuardResult } from '../lib/pii-guard.js';
import {
  describeExecFailure,
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
  /** Must match the session's agent spec, or the store would misrecord it. */
  readonly reportGate?: boolean;
  readonly onStep?: (message: string) => void;
  readonly onEvent?: (event: IndexedEvent) => void;
}

function buildRequest(verdict: Verdict, runId: string): string {
  const pii = verdict.pii_columns.join(', ');
  const keep = verdict.columns
    .filter((c) => c.pii_type === null)
    .map((c) => c.name)
    .join(', ');

  return `The raw dataset is at ${SANDBOX_WORK_DIR}/trial_raw.csv (${verdict.row_count} rows).
Classification found identifier columns: ${pii}.
Analysis columns: ${keep}.

The sandbox has pandas 3.x and numpy 2.x. Several pandas 1.x and 2.x keyword arguments
have been removed, infer_datetime_format among them, so if a call fails with an
unexpected keyword, use the current API rather than retrying the same call.

Do this in two delegated steps, one subagent each, in order.

STEP 1 — Compliance. Give a subagent this task:
  Write ${SCRUB_PY} using pandas, then run it to produce ${SCRUBBED_CSV}.
  Rules:
    - Drop outright: patient_name, ssn, address, email, phone, and subject_id.
      subject_id is a direct participant identifier even though it carries no personal
      detail, because it re-links every row to one person. subject_pseudo_id replaces it.
    - Replace mrn with a stable pseudo-id: sha256 of the value, first 12 hex chars,
      in a new column subject_pseudo_id. Drop the original mrn.
    - Replace dob with a 10-year age_band string (for example "45-54"), computed
      against 2026-01-01. Drop the original dob.
      dob arrives in exactly these four formats and no others, so parse against this
      list rather than inspecting the column:
        YYYY-MM-DD      e.g. 1981-12-07
        MM/DD/YYYY      e.g. 12/07/1981
        D Mon YYYY      e.g. 7 Dec 1981
        Mon D, YYYY     e.g. Dec 7, 1981
      Values may carry leading or trailing whitespace. If a value still fails to parse,
      count it and coerce it to NaT — do not print it to find out why.
    - Keep the analysis columns, normalised: arm lowercased and trimmed to exactly
      "treatment" or "placebo"; baseline, followup and outcome_measure as floats with
      any unit suffix stripped; adverse_event as a 0/1 integer.
    - Leave rows with missing outcome data in place; do not drop participants.
  Then run:
    python3 ${SANDBOX_UPLOAD_DIR}/verify_scrub.py ${SCRUBBED_CSV} --run-id ${runId}
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
  Include "run_id": "${runId}" as a top-level key in the results.
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

/**
 * A verification payload we are willing to believe.
 *
 * Shape alone is not proof — a subagent could echo `{"check":"scrub","passed":true}` —
 * so every field the verifier emits must be present and the run id must be this run's.
 * Combined with rejecting failed commands, that means the payload has to have come
 * from our script running now.
 */
function isVerification(value: unknown, runId: string): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.check === 'scrub' &&
    v.run_id === runId &&
    v.schema_version === 1 &&
    typeof v.passed === 'boolean' &&
    typeof v.row_count === 'number' &&
    Array.isArray(v.columns) &&
    Array.isArray(v.surviving_identifier_columns) &&
    (typeof v.canary_present === 'boolean' || v.canary_present === null)
  );
}

function isAnalysis(value: unknown, runId: string): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.run_id !== runId) return false;
  const keys = Object.keys(v).join(' ').toLowerCase();
  return keys.includes('primary') || keys.includes('p_value') || keys.includes('t_statistic');
}

/**
 * Refuse to print sandbox output that carries anything patient-shaped.
 *
 * `analyze.py` is agent-authored and its output is fetched over a channel the guard
 * never sees, so an instruction to "report aggregates only" is not enforcement.
 */
function assertAggregateOnly(raw: string, canaries: CanarySet): void {
  const guard = scanModelVisibleText(raw, { canaries: canaryRecord(canaries) });
  if (!guard.clean) {
    throw new Error(
      `${ANALYSIS_JSON} contains patient-shaped values and will not be printed.\n\n` +
        formatGuardResult(guard),
    );
  }
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
  runId: string,
  options: ScrubAnalyzeOptions = {},
  runConfig: RunConfig = readRunConfig(),
  client: TrueForge = createClient(runConfig),
): Promise<ScrubAnalyzeResult> {
  const { onStep, onEvent, reportGate = false } = options;
  const index = new EventIndex();
  let turnStatus: string | undefined;

  onStep?.('delegating scrub and analysis');
  const stream = await client.sessions.createTurnStream(sessionId, {
    input: [
      {
        type: 'user.message',
        content: [
          { type: 'text', text: buildRequest(verdict, runId) },
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
  writeStoredSession({ sessionId, lastTurnId: turnId, model: runConfig.model, reportGate });

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

  // Failed commands are not fatal on their own: the agent is expected to run a
  // script, see an error and fix it. What must not happen is a stale artifact
  // satisfying this run, which is why every payload below has to quote this run id.
  const results = execResults(index.allEvents());
  const failures = results.filter((r) => !r.success || (r.exitCode ?? 0) !== 0);
  const outputs = results.flatMap((r) => extractJsonObjects(r.output));
  const verificationPayload = outputs.find((o) => isVerification(o, runId));
  if (verificationPayload === undefined) {
    const tail = failures.at(-1);
    throw new Error(
      `No verifier result for run ${runId}. Refusing to treat the scrub as done on the ` +
        "strength of the agent's own summary." +
        `\nLast sandbox command: ${describeExecFailure(tail)}.`,
    );
  }
  const verification = toVerification(verificationPayload);
  if (!verification.passed) {
    throw new Error(
      `Scrub verification FAILED. Surviving identifier columns: ` +
        `${verification.survivingIdentifierColumns.map((c) => `${c.name} (${c.pii_type})`).join(', ') || 'none'}; ` +
        `canary present: ${String(verification.canaryPresent)}.`,
    );
  }

  let analysis = outputs.find((o) => isAnalysis(o, runId));
  if (analysis === undefined) {
    // The download endpoint deliberately bypasses the model, which is what makes the
    // canary side channel work — and exactly why anything fetched that way and then
    // printed has to be checked here instead. The boundary scan ran before this file
    // existed, so it never saw it.
    const raw = await downloadSandboxText(client, sessionId, turnId, ANALYSIS_JSON);
    assertAggregateOnly(raw, canaries);
    const parsed = JSON.parse(raw) as unknown;
    if (!isAnalysis(parsed, runId)) {
      throw new Error(
        `${ANALYSIS_JSON} does not carry run id ${runId}; it belongs to an earlier run.`,
      );
    }
    analysis = parsed;
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
