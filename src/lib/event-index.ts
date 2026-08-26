/**
 * Per-thread event index over a TrueForge turn stream.
 *
 * Model output arrives as a base `model.message` plus a run of `model.message.delta`
 * fragments sharing its `id`, so deltas must be merged to recover the full text.
 * Events are bucketed by `threadId`: `'main'` for the root agent, a generated id per
 * subagent, `null` for turn-level.
 *
 * {@link EventIndex.allModelVisibleText} is the important part: it reconstructs
 * everything the model could have seen as one string, which is the sole input to the
 * PII guard and the basis of the leak proof.
 */

import { isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

/**
 * Structural view of a streamed event. The SDK's generated union is wide and shifts
 * between releases, so the index works against the fields it actually needs.
 */
export interface IndexedEvent {
  type: string;
  id: string;
  threadId?: string | null;
  content?: unknown;
  [key: string]: unknown;
}

/** Turn-level events (`threadId === null`) are filed under this synthetic key. */
export const TURN_LEVEL_THREAD = '__turn__';

/** The root agent's thread id, per the TrueForge docs. */
export const MAIN_THREAD = 'main';

/**
 * Event types whose textual content the model can observe. Deltas are excluded
 * because they are merged into their base `model.message`.
 */
const MODEL_VISIBLE_EVENT_TYPES = new Set(['model.message', 'tool.response']);

/**
 * Flatten an event's `content` into plain text. Anything not a string or recognised
 * part is serialised whole: over-inclusion is the safe failure mode.
 */
export function extractText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);

  if (Array.isArray(content)) {
    return content.map(extractText).filter(Boolean).join('\n');
  }

  if (typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    // Unknown shape: serialise it rather than let a nested value slip past.
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  return String(content);
}

/**
 * All model-visible text carried by a single event.
 *
 * For a `tool.response` that is just the tool's output string. For a `model.message`
 * it is deliberately broader than `content`: the harness also carries the model's
 * `reasoning_content` and the JSON `arguments` of any tool calls it requested. Both
 * are part of the model's context on the next iteration, and both are plausible
 * leak sites — an agent that read a value and then passed it as a tool argument has
 * leaked it just as surely as one that printed it. Returns `''` for event types the
 * model never sees.
 */
export function modelVisibleTextOf(event: IndexedEvent): string {
  if (!MODEL_VISIBLE_EVENT_TYPES.has(event.type)) return '';

  const parts: string[] = [extractText(event.content)];

  if (typeof event.reasoning_content === 'string') parts.push(event.reasoning_content);
  if (typeof event.reasoningContent === 'string') parts.push(event.reasoningContent);

  const toolCalls = event.toolCalls ?? event.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (call == null || typeof call !== 'object') continue;
      const fn = (call as Record<string, unknown>).function;
      if (fn != null && typeof fn === 'object') {
        const args = (fn as Record<string, unknown>).arguments;
        if (typeof args === 'string') parts.push(args);
      }
    }
  }

  return parts.filter((part) => part.length > 0).join('\n');
}

/** A single thread's merged events, in arrival order. */
export interface ThreadBucket {
  threadId: string;
  events: Map<string, IndexedEvent>;
  /** Insertion order of event ids, so replay preserves the sequence. */
  order: string[];
  /** Set once a `thread.done` event has been seen for this thread. */
  done: boolean;
}

/**
 * Accumulates a turn's events, merging deltas and bucketing by thread.
 *
 * Unlike the doc's example, finished threads are *retained* rather than deleted on
 * `thread.done`. The leak proof runs after the turn ends and must be able to scan a
 * subagent's entire transcript; dropping the bucket when the subagent finishes would
 * discard exactly the evidence the proof depends on.
 */
export class EventIndex {
  private readonly threads = new Map<string, ThreadBucket>();

  /** Highest SSE sequence number seen, for resuming an interrupted stream. */
  lastSequenceNumber = 0;

  /** Turn id, captured from `turn.created`. */
  turnId: string | undefined;

  /** Sandbox id, captured from `sandbox.created`. Undefined if no sandbox ran. */
  sandboxId: string | undefined;

  /**
   * Ingest one event.
   *
   * @param event    The streamed event.
   * @param sequence The SSE event id, when the transport supplied one.
   */
  add(event: IndexedEvent, sequence?: string | number | null): void {
    if (sequence != null) {
      const parsed = Number(sequence);
      if (Number.isFinite(parsed) && parsed > this.lastSequenceNumber) {
        this.lastSequenceNumber = parsed;
      }
    }

    if (event.type === 'turn.created' && typeof event.turnId === 'string') {
      this.turnId = event.turnId;
    }
    if (event.type === 'sandbox.created' && typeof event.sandboxId === 'string') {
      this.sandboxId = event.sandboxId;
    }

    const bucket = this.bucketFor(event.threadId);

    if (isEventDelta(event as never)) {
      const base = bucket.events.get(event.id);
      if (base) {
        mergeEventDelta(base as never, event as never);
      } else {
        // A delta with no base means the stream was joined mid-message (a resume
        // after disconnect). Treat it as the base so its text is not lost.
        bucket.events.set(event.id, { ...event, type: event.type.replace(/\.delta$/, '') });
        bucket.order.push(event.id);
      }
      return;
    }

    if (!bucket.events.has(event.id)) bucket.order.push(event.id);
    bucket.events.set(event.id, event);

    if (event.type === 'thread.done') bucket.done = true;
  }

  private bucketFor(threadId: string | null | undefined): ThreadBucket {
    const key = threadId ?? TURN_LEVEL_THREAD;
    let bucket = this.threads.get(key);
    if (!bucket) {
      bucket = { threadId: key, events: new Map(), order: [], done: false };
      this.threads.set(key, bucket);
    }
    return bucket;
  }

  /** All thread ids seen, including the synthetic turn-level bucket. */
  threadIds(): string[] {
    return [...this.threads.keys()];
  }

  /** Subagent thread ids — everything that is neither `main` nor turn-level. */
  subagentThreadIds(): string[] {
    return this.threadIds().filter((id) => id !== MAIN_THREAD && id !== TURN_LEVEL_THREAD);
  }

  /** Events for one thread, in arrival order. */
  eventsFor(threadId: string): IndexedEvent[] {
    const bucket = this.threads.get(threadId);
    if (!bucket) return [];
    return bucket.order
      .map((id) => bucket.events.get(id))
      .filter((event): event is IndexedEvent => event !== undefined);
  }

  /** Every event across every thread, ordered by thread then arrival. */
  allEvents(): IndexedEvent[] {
    return this.threadIds().flatMap((threadId) => this.eventsFor(threadId));
  }

  /**
   * The root agent's assistant text — what a user reading the chat would see.
   * Subagent output is excluded; it reaches the user only via the root's summary.
   */
  getMainText(): string {
    return this.eventsFor(MAIN_THREAD)
      .filter((event) => event.type === 'model.message')
      .map((event) => extractText(event.content))
      .filter((text) => text.length > 0)
      .join('\n');
  }

  /**
   * Everything the model could have seen, across every thread.
   *
   * This is the leak detector's input. It deliberately spans subagent threads as
   * well as `main`: a subagent that printed a patient record has leaked it into *a*
   * model's context, and the invariant is about the model, not about the user.
   */
  allModelVisibleText(): string {
    return this.allEvents()
      .map(modelVisibleTextOf)
      .filter((text) => text.length > 0)
      .join('\n');
  }

  /** Number of merged (non-delta) events held. */
  size(): number {
    let total = 0;
    for (const bucket of this.threads.values()) total += bucket.events.size;
    return total;
  }
}
