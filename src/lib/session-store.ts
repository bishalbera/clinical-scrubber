/**
 * Remembers which TrueForge session this project is using, so runs share a sandbox
 * instead of cold-starting a new one.
 *
 * Daytona auto-stops after an idle interval and eventually archives, so a remembered
 * session is a hint, not a guarantee.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = resolve(HERE, '../../.trueforge-session.json');

export interface StoredSession {
  readonly sessionId: string;
  /** The file-download endpoint is addressed by turn. */
  readonly lastTurnId?: string;
  readonly model: string;
  /** Whether this session's agent carries the approval-gated report tool. */
  readonly reportGate: boolean;
  readonly updatedAt: string;
}

export function readStoredSession(): StoredSession | undefined {
  if (!existsSync(STORE_PATH)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as Partial<StoredSession>;
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) return undefined;
    return {
      sessionId: parsed.sessionId,
      ...(typeof parsed.lastTurnId === 'string' ? { lastTurnId: parsed.lastTurnId } : {}),
      model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
      reportGate: parsed.reportGate === true,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : 'unknown',
    };
  } catch {
    return undefined;
  }
}

export function writeStoredSession(session: Omit<StoredSession, 'updatedAt'>): void {
  writeFileSync(
    STORE_PATH,
    `${JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

export function clearStoredSession(): void {
  rmSync(STORE_PATH, { force: true });
}
