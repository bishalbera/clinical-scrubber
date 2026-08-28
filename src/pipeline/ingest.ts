/**
 * Phase 2: materialise the raw dataset inside the sandbox and classify its columns
 * without any value crossing back.
 *
 * The verdict is read from the tool response rather than the model's summary of it,
 * the canary comes back over the file-download endpoint, and the guard runs over the
 * whole transcript before this returns.
 */

import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rootAgentSpec } from '../agents/root.js';
import { CANARY_FILENAME, parseCanaryFile, type CanarySet } from '../lib/canary.js';
import { assertBoundaryHolds } from '../lib/boundary.js';
import { createClient, readRunConfig, type RunConfig } from '../lib/client.js';
import { EventIndex, type IndexedEvent } from '../lib/event-index.js';
import type { GuardResult } from '../lib/pii-guard.js';
import {
  downloadSandboxText,
  execResults,
  extractJsonObjects,
  fileAttachment,
  SANDBOX_UPLOAD_DIR,
  SANDBOX_WORK_DIR,
} from '../lib/sandbox.js';
import { readStoredSession, writeStoredSession } from '../lib/session-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = resolve(HERE, '../../python');

const RAW_CSV = `${SANDBOX_WORK_DIR}/trial_raw.csv`;
const CANARY_PATH = `${SANDBOX_WORK_DIR}/${CANARY_FILENAME}`;

/** One column's verdict, as produced by `classify.py`. */
export interface ColumnVerdict {
  readonly name: string;
  readonly dtype: string;
  readonly populated: number;
  readonly blank: number;
  readonly pii_type: string | null;
  readonly match_rate: number;
  /** Always null by construction. */
  readonly example: null;
}

export interface Verdict {
  readonly schema_version: number;
  readonly run_id?: string | null;
  readonly row_count: number;
  readonly column_count: number;
  readonly pii_columns: readonly string[];
  readonly columns: readonly ColumnVerdict[];
}

export interface IngestResult {
  readonly sessionId: string;
  /** Binds this run's sandbox artifacts; later stages must quote it back. */
  readonly runId: string;
  readonly turnId: string;
  readonly sandboxId: string | undefined;
  readonly verdict: Verdict;
  readonly canaries: CanarySet;
  readonly guard: GuardResult;
  readonly index: EventIndex;
  readonly rows: number;
}

export interface IngestOptions {
  readonly rows?: number;
  readonly seed?: number;
  /** Force a new session and sandbox. Use for the demo, where the transcript should be clean. */
  readonly fresh?: boolean;
  /** Attach the approval-gated report tool to the agent. */
  readonly reportGate?: boolean;
  /** Called with each streamed model token, for CLI progress output. */
  readonly onDelta?: (text: string) => void;
  readonly onStep?: (message: string) => void;
  /** Called with every streamed event, for tracing a run that misbehaves. */
  readonly onEvent?: (event: IndexedEvent) => void;
}

/** The scripts the sandbox needs, attached to the turn rather than typed into it. */
const PIPELINE_SCRIPTS = ['gen_data.py', 'classify.py'] as const;

/** Reuse the remembered session if it still exists, otherwise start one. */
async function resolveSession(
  client: TrueForge,
  runConfig: RunConfig,
  options: IngestOptions,
): Promise<{ sessionId: string; priorTurnId: string | undefined; reused: boolean }> {
  const { fresh = false, onStep } = options;
  const stored = fresh ? undefined : readStoredSession();

  if (stored !== undefined && stored.model !== runConfig.model) {
    onStep?.(`stored session ran ${stored.model}; starting a new one for ${runConfig.model}`);
  } else if (stored !== undefined) {
    try {
      await client.sessions.get(stored.sessionId);
      onStep?.(`reusing session ${stored.sessionId}`);
      return { sessionId: stored.sessionId, priorTurnId: stored.lastTurnId, reused: true };
    } catch {
      onStep?.('remembered session is gone; starting a new one');
    }
  }

  const { data: session } = await client.sessions.create({
    agent: {
      spec: rootAgentSpec(runConfig, {
        subagents: true,
        reportGate: options.reportGate ?? false,
      }),
    },
  });
  writeStoredSession({ sessionId: session.id, model: runConfig.model });
  onStep?.(`new session ${session.id}`);
  return { sessionId: session.id, priorTurnId: undefined, reused: false };
}

function isVerdict(value: unknown): value is Verdict {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.schema_version === 'number' && Array.isArray(record.columns);
}

/**
 * The single command the sandbox runs. Deterministic rather than planned by the
 * model: nothing here needs judgement, and an improvised step could improvise a `head`.
 */
function buildIngestCommand(rows: number, seed: number, runId: string): string {
  return [
    `python3 ${SANDBOX_UPLOAD_DIR}/gen_data.py --out-dir ${SANDBOX_WORK_DIR} --rows ${rows} --seed ${seed} --run-id ${runId}`,
    `python3 ${SANDBOX_UPLOAD_DIR}/classify.py ${RAW_CSV} --run-id ${runId}`,
  ].join(' && ');
}

function buildRequest(command: string): string {
  return `Set up the trial dataset and classify its columns.

Run this command in the sandbox, exactly as written, as a single command:

${command}

Then report, in prose: how many rows the dataset has, and which columns were flagged
with which identifier type. Report only what the command printed.`;
}

/** Run the ingest turn. Throws if the canary reached model context. */
export async function runIngest(
  options: IngestOptions = {},
  runConfig: RunConfig = readRunConfig(),
  client: TrueForge = createClient(runConfig),
): Promise<IngestResult> {
  const { rows = 300, seed = 20260822, onDelta, onStep, onEvent } = options;

  // Binds every artifact this turn produces to this run. Without it, a warm sandbox
  // lets an agent that skipped generation classify the previous run's CSV and return
  // a valid-looking verdict and canary.
  const runId = randomUUID();

  const { sessionId } = await resolveSession(client, runConfig, options);

  const index = new EventIndex();
  let turnStatus: string | undefined;

  onStep?.('running turn');
  const stream = await client.sessions.createTurnStream(sessionId, {
    input: [
      {
        type: 'user.message',
        content: [
          { type: 'text', text: buildRequest(buildIngestCommand(rows, seed, runId)) },
          // Re-sent every turn: the bytes are input, not model output, so this
          // costs nothing and the sandbox always runs what is in `python/` now.
          ...PIPELINE_SCRIPTS.map((name) => fileAttachment(resolve(PYTHON_DIR, name))),
        ],
      },
    ],
  });

  for await (const { data: event, id } of stream.withMetadata()) {
    const typed = event as unknown as IndexedEvent;
    index.add(typed, id);
    onEvent?.(typed);

    if (typed.type === 'sandbox.created') onStep?.(`sandbox ${String(typed.sandboxId ?? '')}`);
    if (typed.type === 'model.message.delta' && typeof typed.content === 'string') {
      onDelta?.(typed.content);
    }
    if (typed.type === 'turn.done') {
      turnStatus = (typed as { state?: { status?: string } }).state?.status;
    }
  }

  if (turnStatus !== 'done') {
    throw new Error(
      `Ingest turn ended with status "${turnStatus ?? 'unknown'}" (expected "done").`,
    );
  }

  const turnId = index.turnId;
  if (turnId === undefined) {
    throw new Error('No turn id was captured; cannot reach the sandbox side channel.');
  }

  // The download endpoint is addressed by turn, so the next run needs this.
  writeStoredSession({ sessionId, lastTurnId: turnId, model: runConfig.model });

  // --- verdict ---

  const results = execResults(index.allEvents());
  const failed = results.find((result) => !result.success || (result.exitCode ?? 0) !== 0);
  if (failed !== undefined) {
    throw new Error(`Sandbox command failed (exit ${failed.exitCode ?? '?'}):\n${failed.output}`);
  }

  const verdict = results.flatMap((result) => extractJsonObjects(result.output)).find(isVerdict);

  if (verdict === undefined) {
    throw new Error(
      'No classification verdict found in the sandbox output. ' +
        'The classifier prints JSON; something else ran instead.',
    );
  }

  if (verdict.run_id !== runId) {
    throw new Error(
      `Verdict belongs to run ${String(verdict.run_id)}, not ${runId}. ` +
        'The sandbox returned artifacts from an earlier run; refusing to accept them.',
    );
  }

  // --- canary ---

  onStep?.('retrieving canary via file-download endpoint');
  const canaryFile = await downloadSandboxText(client, sessionId, turnId, CANARY_PATH);
  const canaries = parseCanaryFile(canaryFile);
  const canaryRunId = (JSON.parse(canaryFile) as { run_id?: unknown }).run_id;
  if (canaryRunId !== runId) {
    throw new Error(
      `Canary belongs to run ${String(canaryRunId)}, not ${runId}. ` +
        'Refusing to prove a boundary against a stale canary.',
    );
  }

  // --- boundary check ---

  const guard = await assertBoundaryHolds(client, sessionId, index, canaries, {
    stage: 'ingest',
    onStep,
  });

  return {
    sessionId,
    runId,
    turnId,
    sandboxId: index.sandboxId,
    verdict,
    canaries,
    guard,
    index,
    rows,
  };
}
