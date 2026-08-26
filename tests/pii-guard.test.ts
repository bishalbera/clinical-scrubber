/**
 * The guard's two failure modes are both bad: a missed leak makes the claim false,
 * and a false positive on ordinary agent output gets the guard switched off. Roughly
 * half of what follows tests that it stays quiet when it should.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PII_PATTERNS,
  formatGuardResult,
  patternCandidates,
  scanModelVisibleText,
} from '../src/lib/pii-guard.js';

const CANARIES = { ssn: '900-73-1893', name: 'Zebediah Quillfeather' };

describe('canary detection', () => {
  it('finds a canary SSN embedded in prose', () => {
    const result = scanModelVisibleText('Participant 900-73-1893 withdrew at week 8.', {
      canaries: CANARIES,
    });

    expect(result.canaryClean).toBe(false);
    expect(result.hits.some((h) => h.label === 'canary:ssn')).toBe(true);
  });

  it('finds a canary name, which no digit-shaped pattern would catch', () => {
    const result = scanModelVisibleText('Subject Zebediah Quillfeather, arm=treatment', {
      canaries: CANARIES,
      patterns: [],
    });

    expect(result.canaryClean).toBe(false);
    expect(result.hits[0]?.label).toBe('canary:name');
  });

  it('reports every occurrence, not just the first', () => {
    const result = scanModelVisibleText('900-73-1893 ... later ... 900-73-1893', {
      canaries: CANARIES,
      patterns: [],
    });

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]?.index).toBeLessThan(result.hits[1]?.index ?? -1);
  });

  it('passes clean text', () => {
    const result = scanModelVisibleText(
      'Column ssn matched the SSN pattern in 98% of rows. n=240, p=0.0004.',
      { canaries: CANARIES },
    );

    expect(result.clean).toBe(true);
    expect(result.canaryClean).toBe(true);
  });

  it('cannot be silenced by the allow list', () => {
    // An allow-list entry must never suppress a canary hit.
    const result = scanModelVisibleText('leaked 900-73-1893 here', {
      canaries: CANARIES,
      allow: ['leaked 900-73-1893 here'],
    });

    expect(result.canaryClean).toBe(false);
  });

  it('ignores empty canary values rather than matching everywhere', () => {
    const result = scanModelVisibleText('anything at all', {
      canaries: { ssn: '' },
      patterns: [],
    });

    expect(result.clean).toBe(true);
  });
});

describe('pattern detection', () => {
  it('flags an SSN-shaped value', () => {
    const result = scanModelVisibleText('ssn=123-45-6789');
    expect(result.hits.map((h) => h.label)).toContain('us-ssn');
  });

  it('flags an email address', () => {
    const result = scanModelVisibleText('contact rosa.delacroix@example.com for records');
    expect(result.hits.map((h) => h.label)).toContain('email');
  });

  it.each([
    ['(555) 555-0148', 'parenthesised'],
    ['555.555.0148', 'dotted'],
    ['555-555-0148', 'hyphenated'],
    ['+1 555 555 0148', 'international'],
  ])('flags phone format %s (%s)', (phone) => {
    const result = scanModelVisibleText(`call ${phone} to confirm`);
    expect(result.hits.map((h) => h.label)).toContain('us-phone');
  });

  it.each(['1981-12-07', '12/07/1981', '7 Dec 1981'])('flags date of birth %s', (dob) => {
    const result = scanModelVisibleText(`dob ${dob}`);
    expect(result.hits.map((h) => h.label)).toContain('date-of-birth');
  });

  it('flags an MRN case-insensitively', () => {
    expect(scanModelVisibleText('mrn497357').hits.map((h) => h.label)).toContain('mrn');
  });

  it('flags a street address', () => {
    const result = scanModelVisibleText('lives at 482 Kestrel Lane, Cedar Falls, IA 50123 now');
    expect(result.hits.map((h) => h.label)).toContain('us-street-address');
  });

  it('separates severities so callers can apply different policy', () => {
    const result = scanModelVisibleText('example ssn 123-45-6789', { canaries: CANARIES });

    expect(result.clean).toBe(false);
    // Suspicious, but not proof that patient data crossed.
    expect(result.canaryClean).toBe(true);
  });
});

describe('staying quiet when it should', () => {
  it('does not flag column names', () => {
    const result = scanModelVisibleText(
      'Columns: subject_id, patient_name, ssn, mrn, dob, email, phone, address',
      { canaries: CANARIES },
    );

    expect(result.clean).toBe(true);
  });

  it('does not flag aggregate statistics', () => {
    const result = scanModelVisibleText(
      'n=240, mean change -5.6 (SD 6.4), 95% CI [-7.2, -4.0], p=0.0004, effect size 0.42',
      { canaries: CANARIES },
    );

    expect(result.clean).toBe(true);
  });

  it('does not flag a verdict payload', () => {
    const verdict = JSON.stringify({
      row_count: 300,
      columns: [
        {
          name: 'ssn',
          dtype: 'object',
          populated: 300,
          pii_type: 'ssn',
          match_rate: 1.0,
          example: null,
        },
        {
          name: 'dob',
          dtype: 'object',
          populated: 300,
          pii_type: 'dob',
          match_rate: 0.98,
          example: null,
        },
      ],
    });

    expect(scanModelVisibleText(verdict, { canaries: CANARIES }).clean).toBe(true);
  });

  it('does not flag detector regexes in agent-authored code', () => {
    const source = String.raw`Detector("ssn", re.compile(r"^\d{3}-\d{2}-\d{4}$"))`;
    expect(scanModelVisibleText(source, { canaries: CANARIES }).clean).toBe(true);
  });

  it('does not flag a canary split across a line break', () => {
    // A documented limit: line-wrapped values are not caught.
    const result = scanModelVisibleText('900-73-\n1893', { canaries: CANARIES, patterns: [] });
    expect(result.canaryClean).toBe(true);
  });

  it('honours the allow list for pattern hits', () => {
    const result = scanModelVisibleText('sample value 123-45-6789 in docs', {
      allow: ['123-45-6789'],
    });

    expect(result.clean).toBe(true);
  });

  it('reports offsets into the original text even after allow-listing', () => {
    const text = 'prefix 123-45-6789 and 900-11-2222';
    const result = scanModelVisibleText(text, { allow: ['123-45-6789'] });

    expect(result.hits).toHaveLength(1);
    expect(text.slice(result.hits[0]!.index, result.hits[0]!.index + 11)).toBe('900-11-2222');
  });
});

describe('the guard does not become the leak', () => {
  it('masks matched values in excerpts by default', () => {
    const result = scanModelVisibleText('patient 900-73-1893 withdrew', { canaries: CANARIES });
    const excerpt = result.hits[0]!.excerpt;

    expect(excerpt).not.toContain('900-73-1893');
    expect(excerpt).toContain('900…893');
  });

  it('reveals only when explicitly asked', () => {
    const result = scanModelVisibleText('patient 900-73-1893 withdrew', {
      canaries: CANARIES,
      reveal: true,
    });

    expect(result.hits[0]!.excerpt).toContain('900-73-1893');
  });

  it('keeps surrounding context so a hit can be located', () => {
    const result = scanModelVisibleText('row 126 of trial_raw.csv had 900-73-1893 in it', {
      canaries: CANARIES,
      patterns: [],
    });

    expect(result.hits[0]!.excerpt).toContain('trial_raw.csv');
  });
});

describe('mechanics', () => {
  it('does not leak regex state between calls', () => {
    const text = 'a 123-45-6789 b';
    const first = scanModelVisibleText(text);
    const second = scanModelVisibleText(text);

    expect(second.hits).toEqual(first.hits);
  });

  it('sorts hits by position', () => {
    const result = scanModelVisibleText('900-73-1893 then rosa@example.com', {
      canaries: CANARIES,
    });

    const indices = result.hits.map((h) => h.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('handles empty input', () => {
    const result = scanModelVisibleText('', { canaries: CANARIES });
    expect(result.clean).toBe(true);
    expect(result.scannedChars).toBe(0);
  });

  it('reports how much it scanned', () => {
    expect(scanModelVisibleText('hello world').scannedChars).toBe(11);
  });

  it('ships patterns that all carry the global flag', () => {
    for (const pattern of DEFAULT_PII_PATTERNS) {
      expect(pattern.regex.flags).toContain('g');
    }
  });
});

describe('formatGuardResult', () => {
  it('states the pass case unambiguously', () => {
    const output = formatGuardResult(scanModelVisibleText('n=240, p=0.03', { canaries: CANARIES }));

    expect(output).toContain('Canary values in model context: NONE');
    expect(output).toContain('PII-shaped strings in model context: none');
  });

  it('states the fail case unambiguously', () => {
    const output = formatGuardResult(scanModelVisibleText('900-73-1893', { canaries: CANARIES }));

    expect(output).toContain('BOUNDARY BREACHED');
  });

  it('does not print raw matched values', () => {
    const output = formatGuardResult(scanModelVisibleText('900-73-1893', { canaries: CANARIES }));

    expect(output).not.toContain('900-73-1893');
  });
});

describe('adjudication support', () => {
  it('exposes the matched text so a pattern hit can be checked against the dataset', () => {
    const result = scanModelVisibleText('ssn=123-45-6789');
    expect(patternCandidates(result)).toEqual(['123-45-6789']);
  });

  it('deduplicates repeated matches', () => {
    const result = scanModelVisibleText('123-45-6789 and again 123-45-6789');
    expect(patternCandidates(result)).toHaveLength(1);
  });

  it('excludes canary hits, which need no adjudication', () => {
    const result = scanModelVisibleText('900-73-1893', { canaries: CANARIES });
    expect(patternCandidates(result)).not.toContain('900-73-1893');
  });

  it('returns nothing for clean text', () => {
    expect(patternCandidates(scanModelVisibleText('n=240, p=0.03'))).toEqual([]);
  });

  it('still keeps the raw match out of the formatted output', () => {
    const result = scanModelVisibleText('ssn=123-45-6789');
    expect(result.hits[0]!.match).toBe('123-45-6789');
    expect(formatGuardResult(result)).not.toContain('123-45-6789');
  });
});
