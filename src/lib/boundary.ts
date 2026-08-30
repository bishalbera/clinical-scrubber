/** The boundary check: session-wide scan, canary proof, in-sandbox value comparison. */
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canaryRecord, type CanarySet } from './canary.js';
import { EventIndex, type IndexedEvent } from './event-index.js';
import {
  formatGuardResult,
  patternCandidates,
  scanModelVisibleText,
  type GuardResult,
} from './pii-guard.js';
import {
  describeExecFailure,
  execResults,
  extractJsonObjects,
  fileAttachment,
  SANDBOX_UPLOAD_DIR,
  SANDBOX_WORK_DIR,
} from './sandbox.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = resolve(HERE, '../../python');

/** Guards against an unbounded walk; exceeding it fails rather than scanning partially. */
const MAX_SESSION_EVENTS = 20000;

/**
 * Everything the model could have seen in this session.
 *
 * Falls back to the turn's own index if the session listing is unavailable, so a
 * transport failure narrows the check rather than removing it.
 */
export async function sessionVisibleText(
  client: TrueForge,
  sessionId: string,
  fallback: EventIndex,
  strict = false,
): Promise<string> {
  try {
    const whole = new EventIndex();
    let seen = 0;

    // listEvents is paginated and newest-first. Reading only the first page would
    // silently exclude older turns of a reused session — exactly the turns the
    // session-wide scan exists to cover.
    let page = await client.sessions.listEvents(sessionId);
    for (;;) {
      for (const entry of page.data as Array<{ event?: unknown }>) {
        if (entry.event != null) {
          whole.add(entry.event as IndexedEvent);
          seen += 1;
        }
      }
      if (seen >= MAX_SESSION_EVENTS || !page.hasNextPage()) break;
      page = await page.getNextPage();
    }

    if (seen >= MAX_SESSION_EVENTS) {
      throw new Error(
        `Session has more than ${MAX_SESSION_EVENTS} events; refusing to claim a ` +
          'complete scan of a session this large.',
      );
    }

    const text = whole.allModelVisibleText();
    return text.length > 0 ? text : fallback.allModelVisibleText();
  } catch (error) {
    if (error instanceof Error && error.message.includes('refusing to claim')) throw error;
    if (strict) {
      // `prove` claims a complete scan of the session. Silently narrowing to one turn
      // would let it report a clean run it never performed.
      throw new Error(
        'Could not retrieve the full session event history, so a complete scan cannot ' +
          `be claimed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return fallback.allModelVisibleText();
  }
}

/** How many of `candidates` actually occur in the sandbox's data files. */
export async function adjudicateCandidates(
  client: TrueForge,
  sessionId: string,
  candidates: readonly string[],
  dataPaths: readonly string[],
): Promise<number> {
  // Fresh path per call, and deliberately not a dotfile: the agent is instructed never
  // to read those, and would refuse to write this one.
  const listPath = `${SANDBOX_WORK_DIR}/candidates-${randomUUID()}.json`;
  const index = new EventIndex();

  const stream = await client.sessions.createTurnStream(sessionId, {
    input: [
      {
        type: 'user.message',
        content: [
          {
            type: 'text',
            text:
              `Write this JSON to ${listPath}, then run the command below and paste its ` +
              'output verbatim. Run it now even if you ran a similar command earlier in ' +
              'this conversation: the answer must come from this execution, not from ' +
              `memory. Do not print the data files.\n\n` +
              `${JSON.stringify(candidates)}\n\n` +
              `python3 ${SANDBOX_UPLOAD_DIR}/adjudicate.py ${listPath} ${dataPaths.join(' ')}`,
          },
          fileAttachment(resolve(PYTHON_DIR, 'adjudicate.py')),
        ],
      },
    ],
  });
  for await (const { data: event, id } of stream.withMetadata()) {
    index.add(event as unknown as IndexedEvent, id);
  }

  const payload = execResults(index.allEvents())
    .flatMap((r) => extractJsonObjects(r.output))
    .find(
      (o): o is Record<string, unknown> =>
        o !== null &&
        typeof o === 'object' &&
        (o as Record<string, unknown>).check === 'adjudicate',
    );

  if (payload === undefined) {
    // Unable to decide. A boundary check that fails open is not a boundary check.
    const results = execResults(index.allEvents());
    throw new Error(
      'Could not adjudicate identifier-shaped strings against the dataset. ' +
        'Refusing to report a clean run without that answer.\n' +
        `Sandbox commands seen: ${results.length}; last ${describeExecFailure(results.at(-1))}.`,
    );
  }

  const findings = Array.isArray(payload.findings)
    ? (payload.findings as Array<{ occurrences?: number }>)
    : [];
  return findings.filter((f) => (f.occurrences ?? 0) > 0).length;
}

export interface BoundaryCheckOptions {
  /** Named in the failure message, so a breach says which stage produced it. */
  readonly stage: string;
  readonly dataPaths?: readonly string[] | undefined;
  /**
   * Classified identifier columns. When given, the whole transcript is compared
   * against every value in them, not just against identifier *shapes* — a patient
   * name and a study id match no pattern. Pass these wherever the run makes a claim
   * about the boundary holding; omit them for a cheap per-stage check.
   */
  readonly identifierColumns?: readonly string[] | undefined;
  readonly onStep?: ((message: string) => void) | undefined;
}

/**
 * Assert that no patient value reached model context. Throws if one did.
 *
 * Callers get a `GuardResult` only from a run that passed, because the only safe
 * thing to do with a breached result is refuse to use it.
 */
export async function assertBoundaryHolds(
  client: TrueForge,
  sessionId: string,
  index: EventIndex,
  canaries: CanarySet,
  options: BoundaryCheckOptions,
): Promise<GuardResult> {
  const {
    stage,
    dataPaths = [`${SANDBOX_WORK_DIR}/trial_raw.csv`],
    identifierColumns = [],
    onStep,
  } = options;

  const scanned = await sessionVisibleText(client, sessionId, index);
  const guard = scanModelVisibleText(scanned, { canaries: canaryRecord(canaries) });

  if (!guard.canaryClean) {
    throw new Error(
      `PII BOUNDARY BREACHED during ${stage}.\n\n${formatGuardResult(guard)}\n\n` +
        'A canary minted inside the sandbox reached model-visible context. ' +
        'The only way that happens is if something read the raw data.',
    );
  }

  const candidates = patternCandidates(guard);
  if (candidates.length > 0) {
    onStep?.(`adjudicating ${candidates.length} identifier-shaped strings`);
    const leaked = await adjudicateCandidates(client, sessionId, candidates, dataPaths);
    if (leaked > 0) {
      throw new Error(
        `PII BOUNDARY BREACHED during ${stage}.\n\n${formatGuardResult(guard)}\n\n` +
          `${leaked} of ${candidates.length} identifier-shaped strings in model-visible ` +
          'context were found in the data. They are patient values, not examples.',
      );
    }
    onStep?.('none of them appear in the data');
  }

  if (identifierColumns.length > 0) {
    onStep?.('comparing the transcript against every identifier value in the dataset');
    const values = await checkTextAgainstData(
      client,
      sessionId,
      scanned,
      identifierColumns,
      dataPaths[0],
    );
    if (values.leaked) {
      throw new Error(
        `PII BOUNDARY BREACHED during ${stage}.\n\n` +
          'Values from ' +
          `${values.matches.map((m) => m.column).join(', ')} appear in model-visible ` +
          'context. These are real patient values, not identifier-shaped lookalikes.',
      );
    }
    onStep?.(`${values.valuesCompared} identifier values compared, none present`);
  }

  return guard;
}

export interface DataLeakCheck {
  readonly leaked: boolean;
  readonly matches: ReadonlyArray<{ column: string; distinct_values_found: number }>;
  readonly valuesCompared: number;
}

/**
 * Compare arbitrary text against every value in the dataset's identifier columns.
 *
 * The shape-based guard cannot see a leaked patient *name*: it matches no pattern.
 * Only a comparison against the actual values can, and those live in the sandbox — so
 * the text goes in rather than the data coming out. It travels as a file attachment,
 * which the harness places without the model ever seeing it, and only counts come back.
 *
 * Throws rather than returning a verdict it could not establish.
 */
export async function checkTextAgainstData(
  client: TrueForge,
  sessionId: string,
  text: string,
  identifierColumns: readonly string[],
  dataPath = `${SANDBOX_WORK_DIR}/trial_raw.csv`,
): Promise<DataLeakCheck> {
  if (identifierColumns.length === 0) {
    return { leaked: false, matches: [], valuesCompared: 0 };
  }

  const stamp = randomUUID();
  const textPath = `${SANDBOX_UPLOAD_DIR}/subject-${stamp}.txt`;
  const localText = join(tmpdir(), `subject-${stamp}.txt`);
  writeFileSync(localText, text, 'utf8');

  const index = new EventIndex();
  try {
    const stream = await client.sessions.createTurnStream(sessionId, {
      input: [
        {
          type: 'user.message',
          content: [
            {
              type: 'text',
              text:
                'A text file is attached. Run the command below exactly and paste its ' +
                'output verbatim. Run it now even if you ran something similar earlier: ' +
                'the answer must come from this execution. Do not print either file.\n\n' +
                `python3 ${SANDBOX_UPLOAD_DIR}/scan_transcript.py ${textPath} ${dataPath} ` +
                `--columns ${identifierColumns.join(',')} --run-id ${stamp}`,
            },
            fileAttachment(resolve(PYTHON_DIR, 'scan_transcript.py')),
            fileAttachment(localText, 'text/plain'),
          ],
        },
      ],
    });
    for await (const { data: event, id } of stream.withMetadata()) {
      index.add(event as unknown as IndexedEvent, id);
    }
  } finally {
    rmSync(localText, { force: true });
  }

  const payload = execResults(index.allEvents())
    .flatMap((r) => extractJsonObjects(r.output))
    .find(
      (o): o is Record<string, unknown> =>
        o !== null &&
        typeof o === 'object' &&
        (o as Record<string, unknown>).check === 'transcript' &&
        (o as Record<string, unknown>).run_id === stamp,
    );

  if (payload === undefined) {
    throw new Error(
      `Could not compare text against the dataset (run ${stamp}). Refusing to report a ` +
        'clean result without that answer. Output withheld.',
    );
  }

  // Every field must be present and the right type. A partial payload previously read
  // as `leaked: false`, which is the one interpretation this must never default to:
  // callers waive real pattern hits on the strength of this result.
  if (
    typeof payload.leaked !== 'boolean' ||
    !Array.isArray(payload.matches) ||
    typeof payload.values_compared !== 'number' ||
    !Array.isArray(payload.columns_checked)
  ) {
    throw new Error(
      `The dataset comparison for run ${stamp} returned an incomplete result. ` +
        'Refusing to treat that as clean.',
    );
  }

  if (payload.values_compared === 0 && identifierColumns.length > 0) {
    throw new Error(
      `The dataset comparison for run ${stamp} compared no values, so it establishes ` +
        'nothing. Refusing to treat that as clean.',
    );
  }

  return {
    leaked: payload.leaked,
    matches: payload.matches as Array<{ column: string; distinct_values_found: number }>,
    valuesCompared: payload.values_compared,
  };
}
