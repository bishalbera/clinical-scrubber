/**
 * Every malformed-input case must throw rather than yield empty canary values: an
 * empty canary matches nothing and would turn the leak proof's PASS into a tautology.
 */

import { describe, expect, it } from 'vitest';

import { canaryRecord, parseCanaryFile } from '../src/lib/canary.js';

const VALID = JSON.stringify({
  ssn: '984-42-0266',
  name: 'Barnabas Ashdown-Vance',
  row_index: 126,
  subject_id: 'STUDY-0127',
});

describe('parseCanaryFile', () => {
  it('reads what gen_data.py writes', () => {
    expect(parseCanaryFile(VALID)).toEqual({
      ssn: '984-42-0266',
      name: 'Barnabas Ashdown-Vance',
      rowIndex: 126,
      subjectId: 'STUDY-0127',
    });
  });

  it('tolerates a missing row index without losing the canary values', () => {
    const parsed = parseCanaryFile(JSON.stringify({ ssn: '900-11-2222', name: 'A B' }));
    expect(parsed.ssn).toBe('900-11-2222');
    expect(parsed.rowIndex).toBe(-1);
    expect(parsed.subjectId).toBe('unknown');
  });

  it.each([
    ['malformed JSON', 'not json at all'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
  ])('throws on %s', (_label, contents) => {
    expect(() => parseCanaryFile(contents)).toThrow();
  });

  it.each([
    ['a missing ssn', { name: 'A B' }],
    ['a missing name', { ssn: '900-11-2222' }],
    ['an empty ssn', { ssn: '', name: 'A B' }],
    ['an empty name', { ssn: '900-11-2222', name: '' }],
    ['a non-string ssn', { ssn: 900112222, name: 'A B' }],
  ])('throws on %s rather than hunting for nothing', (_label, payload) => {
    expect(() => parseCanaryFile(JSON.stringify(payload))).toThrow(/ssn|name/);
  });
});

describe('canaryRecord', () => {
  it('produces the shape the guard takes', () => {
    expect(canaryRecord(parseCanaryFile(VALID))).toEqual({
      ssn: '984-42-0266',
      name: 'Barnabas Ashdown-Vance',
    });
  });
});
