/**
 * These parsers sit between the sandbox and the verdict the pipeline acts on. A
 * mis-parse here surfaces as a confusing "no verdict found" rather than a wrong
 * answer, but the brace matcher is hand-rolled and its edge cases are worth pinning.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  describeExecFailure,
  execResults,
  extractJsonObjects,
  fileAttachment,
  SANDBOX_UPLOAD_DIR,
  SANDBOX_WORK_DIR,
} from '../src/lib/sandbox.js';
import type { IndexedEvent } from '../src/lib/event-index.js';

function toolResponse(id: string, payload: unknown): IndexedEvent {
  return { type: 'tool.response', id, content: JSON.stringify(payload) };
}

describe('extractJsonObjects', () => {
  it('finds a single object', () => {
    expect(extractJsonObjects('{"a":1}')).toEqual([{ a: 1 }]);
  });

  it('finds several objects in one stream', () => {
    expect(extractJsonObjects('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('ignores braces inside string values', () => {
    expect(extractJsonObjects('{"a":"}{"}')).toEqual([{ a: '}{' }]);
  });

  it('handles escaped quotes', () => {
    expect(extractJsonObjects('{"a":"say \\"hi\\""}')).toEqual([{ a: 'say "hi"' }]);
  });

  it('handles a trailing backslash inside a string', () => {
    expect(extractJsonObjects('{"p":"C:\\\\"}')).toEqual([{ p: 'C:\\' }]);
  });

  it('keeps nested objects whole', () => {
    expect(extractJsonObjects('{"a":{"b":{"c":1}}}')).toEqual([{ a: { b: { c: 1 } } }]);
  });

  it('skips surrounding shell output', () => {
    // The real case: gen_data.py echoes progress before classify.py prints JSON.
    expect(extractJsonObjects('wrote /work/x\n{"a":1}\nDone.')).toEqual([{ a: 1 }]);
  });

  it('returns nothing for an unterminated object', () => {
    expect(extractJsonObjects('{"a":1')).toEqual([]);
  });

  it('recovers from a stray closing brace', () => {
    expect(extractJsonObjects('}{"a":1}')).toEqual([{ a: 1 }]);
  });

  it('returns nothing for empty input', () => {
    expect(extractJsonObjects('')).toEqual([]);
  });
});

describe('execResults', () => {
  it('reads a successful exec', () => {
    const events = [toolResponse('1', { success: true, response: { exitCode: 0, result: 'out' } })];
    expect(execResults(events)).toEqual([{ success: true, exitCode: 0, output: 'out' }]);
  });

  it('reports a non-zero exit', () => {
    const events = [
      toolResponse('1', { success: true, response: { exitCode: 1, result: 'boom' } }),
    ];
    expect(execResults(events)[0]).toMatchObject({ exitCode: 1, output: 'boom' });
  });

  it('marks a failed call unsuccessful even with no response body', () => {
    // The pipeline treats this as a failure; it must not read as a silent success.
    expect(execResults([toolResponse('1', { success: false })])[0]).toMatchObject({
      success: false,
      output: '',
    });
  });

  it('skips tool responses that are not exec payloads', () => {
    const events: IndexedEvent[] = [{ type: 'tool.response', id: '1', content: 'not json' }];
    expect(execResults(events)).toEqual([]);
  });

  it('ignores events that are not tool responses', () => {
    const events: IndexedEvent[] = [{ type: 'model.message', id: '1', content: 'hello' }];
    expect(execResults(events)).toEqual([]);
  });

  it('preserves order across several execs', () => {
    const events = [
      toolResponse('1', { success: true, response: { exitCode: 0, result: 'first' } }),
      toolResponse('2', { success: true, response: { exitCode: 0, result: 'second' } }),
    ];
    expect(execResults(events).map((r) => r.output)).toEqual(['first', 'second']);
  });
});

describe('fileAttachment', () => {
  const here = new URL('../python/classify.py', import.meta.url).pathname;

  it('encodes the file as a data URI under its basename', () => {
    const part = fileAttachment(here);
    expect(part.type).toBe('file');
    expect(part.name).toBe('classify.py');
    expect(part.data.startsWith('data:text/x-python;base64,')).toBe(true);
  });

  it('round-trips the file byte for byte', () => {
    // The whole reason attachments replaced writing files via shell commands.
    const part = fileAttachment(here);
    const decoded = Buffer.from(part.data.split(',')[1]!, 'base64');
    expect(decoded.equals(readFileSync(here))).toBe(true);
  });

  it('throws on a missing file rather than sending an empty attachment', () => {
    expect(() => fileAttachment('/nonexistent/nope.py')).toThrow();
  });
});

describe('sandbox paths', () => {
  it('separates the upload directory from the working directory', () => {
    // The harness owns the upload dir; the pipeline writes its output elsewhere.
    expect(SANDBOX_UPLOAD_DIR).not.toBe(SANDBOX_WORK_DIR);
  });
});

describe('describeExecFailure', () => {
  it('never quotes what the command printed', () => {
    // The command most likely to fail is one that printed something it should not have,
    // and error text reaches a terminal and shell history.
    const result = {
      success: false,
      exitCode: 1,
      output: 'STUDY-0042,Marcus Okonkwo,900-11-2222,MRN497357',
    };
    const described = describeExecFailure(result);

    for (const value of ['Marcus Okonkwo', '900-11-2222', 'MRN497357', 'STUDY-0042']) {
      expect(described).not.toContain(value);
    }
  });

  it('still says enough to diagnose', () => {
    const described = describeExecFailure({ success: false, exitCode: 2, output: 'x'.repeat(500) });
    expect(described).toContain('exit 2');
    expect(described).toContain('500');
  });

  it('handles a missing exit code', () => {
    expect(describeExecFailure({ success: false, exitCode: undefined, output: '' })).toContain(
      'unknown',
    );
  });

  it('handles no command at all', () => {
    expect(describeExecFailure(undefined)).toContain('no sandbox command');
  });
});
