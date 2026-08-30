/** Reads the canary the sandbox minted, via the file-download side channel. */
/** Where `gen_data.py` writes the side file, relative to the dataset directory. */
export const CANARY_FILENAME = '.canary.json';

export interface CanarySet {
  readonly ssn: string;
  readonly name: string;
  readonly rowIndex: number;
  readonly subjectId: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Parse `.canary.json`. Throws rather than yield empty values, which would match nothing. */
export function parseCanaryFile(contents: string): CanarySet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Canary side file is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Canary side file did not contain a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  if (!isNonEmptyString(record.ssn) || !isNonEmptyString(record.name)) {
    throw new Error('Canary side file is missing `ssn` or `name`.');
  }

  return {
    ssn: record.ssn,
    name: record.name,
    rowIndex: typeof record.row_index === 'number' ? record.row_index : -1,
    subjectId: isNonEmptyString(record.subject_id) ? record.subject_id : 'unknown',
  };
}

/** The canary values in the shape {@link scanModelVisibleText} takes. */
export function canaryRecord(canaries: CanarySet): Record<string, string> {
  return { ssn: canaries.ssn, name: canaries.name };
}
