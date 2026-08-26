/**
 * Offline tests for the event index.
 *
 * These run without a harness: they feed hand-built event objects shaped like the
 * ones documented in the TrueForge OpenAPI spec. The coverage that matters is
 * `allModelVisibleText()` — it is the sole input to the leak proof, so a gap here is
 * a gap in the safety claim, not just a rendering bug.
 */

import { describe, expect, it } from 'vitest';

import {
  EventIndex,
  MAIN_THREAD,
  TURN_LEVEL_THREAD,
  extractText,
  modelVisibleTextOf,
  type IndexedEvent,
} from '../src/lib/event-index.js';

function modelMessage(
  id: string,
  threadId: string,
  content: string | null,
  extra: Partial<IndexedEvent> = {},
): IndexedEvent {
  return { type: 'model.message', id, threadId, content, ...extra };
}

function delta(id: string, threadId: string, content: string): IndexedEvent {
  return { type: 'model.message.delta', id, threadId, content };
}

function toolResponse(id: string, threadId: string, content: string): IndexedEvent {
  return { type: 'tool.response', id, threadId, toolCallId: `call-${id}`, content };
}

describe('extractText', () => {
  it('passes strings through', () => {
    expect(extractText('hello')).toBe('hello');
  });

  it('returns empty for null and undefined', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
  });

  it('joins content parts', () => {
    expect(
      extractText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });

  it('serialises unknown object shapes rather than dropping them', () => {
    // A value buried in an unrecognised payload must still reach the scanner.
    expect(extractText({ rows: [{ ssn: '900-73-1893' }] })).toContain('900-73-1893');
  });

  it('handles nested arrays of mixed shapes', () => {
    expect(extractText(['a', { text: 'b' }, 42])).toBe('a\nb\n42');
  });
});

describe('EventIndex delta merging', () => {
  it('merges deltas into their base message', () => {
    const index = new EventIndex();
    index.add(modelMessage('m1', MAIN_THREAD, 'Hello'));
    index.add(delta('m1', MAIN_THREAD, ', '));
    index.add(delta('m1', MAIN_THREAD, 'world.'));

    expect(index.getMainText()).toBe('Hello, world.');
    expect(index.size()).toBe(1);
  });

  it('treats an orphan delta as its own base so joined-mid-stream text is not lost', () => {
    // This is the resume-after-disconnect case: we subscribe with
    // afterSequenceNumber and the first thing we see is a delta whose base event
    // was emitted before we reconnected.
    const index = new EventIndex();
    index.add(delta('m9', MAIN_THREAD, 'tail of a message'));

    expect(index.getMainText()).toContain('tail of a message');
  });

  it('does not double-count delta text in model-visible output', () => {
    const index = new EventIndex();
    index.add(modelMessage('m1', MAIN_THREAD, 'abc'));
    index.add(delta('m1', MAIN_THREAD, 'def'));

    expect(index.allModelVisibleText()).toBe('abcdef');
  });
});

describe('EventIndex thread bucketing', () => {
  it('separates main, subagent, and turn-level events', () => {
    const index = new EventIndex();
    index.add({ type: 'turn.created', id: 't1', threadId: null, turnId: 'turn-1' });
    index.add(modelMessage('m1', MAIN_THREAD, 'root'));
    index.add({ type: 'thread.created', id: 'th1', threadId: 'sub-a', title: 'Compliance' });
    index.add(modelMessage('m2', 'sub-a', 'subagent'));

    expect(index.turnId).toBe('turn-1');
    expect(index.threadIds().sort()).toEqual([TURN_LEVEL_THREAD, MAIN_THREAD, 'sub-a'].sort());
    expect(index.subagentThreadIds()).toEqual(['sub-a']);
    expect(index.getMainText()).toBe('root');
  });

  it('keeps a subagent thread after thread.done so the proof can still scan it', () => {
    // The docs' example deletes the bucket on thread.done. We must not: the leak
    // proof runs after the turn ends and needs the finished subagent's transcript.
    const index = new EventIndex();
    index.add(modelMessage('m1', 'sub-a', 'subagent said something'));
    index.add({ type: 'thread.done', id: 'td1', threadId: 'sub-a' });

    expect(index.subagentThreadIds()).toEqual(['sub-a']);
    expect(index.allModelVisibleText()).toContain('subagent said something');
  });

  it('preserves arrival order within a thread', () => {
    const index = new EventIndex();
    index.add(modelMessage('m1', MAIN_THREAD, 'first'));
    index.add(modelMessage('m2', MAIN_THREAD, 'second'));
    index.add(modelMessage('m3', MAIN_THREAD, 'third'));

    expect(index.eventsFor(MAIN_THREAD).map((event) => event.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('records the sandbox id from sandbox.created', () => {
    const index = new EventIndex();
    index.add({ type: 'sandbox.created', id: 's1', threadId: null, sandboxId: 'sbx-42' });

    expect(index.sandboxId).toBe('sbx-42');
  });
});

describe('EventIndex.allModelVisibleText', () => {
  it('includes tool responses, which is where sandbox output enters context', () => {
    const index = new EventIndex();
    index.add(toolResponse('r1', MAIN_THREAD, '{"columns": ["ssn"], "match_rate": 0.98}'));

    expect(index.allModelVisibleText()).toContain('match_rate');
  });

  it('spans every thread, not just main', () => {
    const index = new EventIndex();
    index.add(modelMessage('m1', MAIN_THREAD, 'root text'));
    index.add(toolResponse('r1', 'sub-a', 'compliance tool output'));
    index.add(toolResponse('r2', 'sub-b', 'biostat tool output'));

    const visible = index.allModelVisibleText();
    expect(visible).toContain('root text');
    expect(visible).toContain('compliance tool output');
    expect(visible).toContain('biostat tool output');
  });

  it('includes tool-call arguments, a leak path that content alone would miss', () => {
    const index = new EventIndex();
    index.add(
      modelMessage('m1', MAIN_THREAD, 'Running the scrubber.', {
        toolCalls: [
          {
            id: 'c1',
            function: {
              name: 'run_python',
              arguments: '{"code": "df.query(\'ssn == 900-73-1893\')"}',
            },
          },
        ],
      }),
    );

    expect(index.allModelVisibleText()).toContain('900-73-1893');
  });

  it('includes reasoning content', () => {
    const index = new EventIndex();
    index.add(
      modelMessage('m1', MAIN_THREAD, 'ok', { reasoning_content: 'thinking about 900-73-1893' }),
    );

    expect(index.allModelVisibleText()).toContain('900-73-1893');
  });

  it('excludes lifecycle events the model never reads', () => {
    const index = new EventIndex();
    index.add({ type: 'turn.created', id: 't1', threadId: null, turnId: 'turn-1' });
    index.add({ type: 'sandbox.created', id: 's1', threadId: null, sandboxId: 'sbx-1' });
    index.add({ type: 'thread.created', id: 'th1', threadId: 'sub-a', title: 'Bio-Stat' });

    expect(index.allModelVisibleText()).toBe('');
  });

  it('is empty for an empty index', () => {
    expect(new EventIndex().allModelVisibleText()).toBe('');
  });
});

describe('modelVisibleTextOf', () => {
  it('returns empty for non-visible event types', () => {
    expect(modelVisibleTextOf({ type: 'turn.done', id: 'x', threadId: null })).toBe('');
  });

  it('tolerates a model.message with null content', () => {
    expect(modelVisibleTextOf(modelMessage('m1', MAIN_THREAD, null))).toBe('');
  });
});

describe('EventIndex sequence tracking', () => {
  it('tracks the highest sequence number for resume', () => {
    const index = new EventIndex();
    index.add(modelMessage('m1', MAIN_THREAD, 'a'), '5');
    index.add(modelMessage('m2', MAIN_THREAD, 'b'), '9');
    index.add(modelMessage('m3', MAIN_THREAD, 'c'), '7');

    expect(index.lastSequenceNumber).toBe(9);
  });

  it('ignores missing sequence ids', () => {
    const index = new EventIndex();
    index.add(modelMessage('m1', MAIN_THREAD, 'a'), null);

    expect(index.lastSequenceNumber).toBe(0);
  });
});

describe('never losing indexed text', () => {
  it('keeps orphan-delta text when the base event arrives afterwards', () => {
    // Losing text here would shrink the guard's only input and turn a real leak
    // into a passing run.
    const index = new EventIndex();
    index.add({
      type: 'model.message.delta',
      id: 'm1',
      threadId: 'main',
      content: 'PLANTED-900-73-1893',
    });
    index.add({ type: 'model.message', id: 'm1', threadId: 'main', content: 'preamble' });

    const visible = index.allModelVisibleText();
    expect(visible).toContain('PLANTED-900-73-1893');
    expect(visible).toContain('preamble');
  });

  it('does not duplicate text when the base repeats what a delta already held', () => {
    const index = new EventIndex();
    index.add({ type: 'model.message.delta', id: 'm2', threadId: 'main', content: 'hello' });
    index.add({ type: 'model.message', id: 'm2', threadId: 'main', content: 'hello world' });

    expect(index.allModelVisibleText()).toBe('hello world');
  });

  it('leaves the ordinary base-then-delta path unchanged', () => {
    const index = new EventIndex();
    index.add({ type: 'model.message', id: 'm3', threadId: 'main', content: 'Hello' });
    index.add({ type: 'model.message.delta', id: 'm3', threadId: 'main', content: ' world' });

    expect(index.allModelVisibleText()).toBe('Hello world');
  });

  it('does not add a duplicate entry to the thread order', () => {
    const index = new EventIndex();
    index.add({ type: 'model.message.delta', id: 'm4', threadId: 'main', content: 'a' });
    index.add({ type: 'model.message', id: 'm4', threadId: 'main', content: 'b' });

    expect(index.eventsFor('main')).toHaveLength(1);
  });
});
