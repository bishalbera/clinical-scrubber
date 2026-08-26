/**
 * Sandbox helpers.
 *
 * The agent gets one system tool, `exec`, taking `{intent, command}`. Files move in
 * and out on channels the model is not part of: attachments on a user message go in,
 * the turn download endpoint brings results out.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { TrueForge } from '@truefoundry/trueforge-sdk';

import type { IndexedEvent } from './event-index.js';

/** Where the pipeline keeps its working files inside the sandbox. */
export const SANDBOX_WORK_DIR = '/work';

/** Where the harness places files attached to a user message. Verified by `pnpm probe:upload`. */
export const SANDBOX_UPLOAD_DIR = '/opt/tf/uploads';

/**
 * Attach a local file for the harness to place in the sandbox.
 *
 * The alternative — having the model write the file via a shell command — fails at
 * real sizes: it emits roughly 28 chars/second and corrupts the stream around 12KB.
 * An attachment travels as request input instead, arrives byte-identical, and its
 * contents do not enter model context.
 */
export function fileAttachment(
  localPath: string,
  mimeType = 'text/x-python',
): { type: 'file'; name: string; data: string } {
  const contents = readFileSync(localPath);
  return {
    type: 'file',
    name: basename(localPath),
    data: `data:${mimeType};base64,${contents.toString('base64')}`,
  };
}

/** The `exec` tool's response payload, as it arrives inside `tool.response.content`. */
export interface ExecResult {
  success: boolean;
  exitCode: number | undefined;
  output: string;
}

/** Pull `exec` results out of a run's events, rather than the model's summary of them. */
export function execResults(events: readonly IndexedEvent[]): ExecResult[] {
  const results: ExecResult[] = [];

  for (const event of events) {
    if (event.type !== 'tool.response' || typeof event.content !== 'string') continue;

    try {
      const parsed = JSON.parse(event.content) as {
        success?: boolean;
        response?: { exitCode?: number; result?: string };
      };
      results.push({
        success: parsed.success === true,
        exitCode: parsed.response?.exitCode,
        output: parsed.response?.result ?? '',
      });
    } catch {
      continue;
    }
  }

  return results;
}

/** Every balanced top-level JSON object in `text`, parsed. */
export function extractJsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          found.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // not a JSON payload
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }

  return found;
}

interface BinaryBody {
  arrayBuffer?: () => Promise<ArrayBuffer>;
  bytes?: () => Promise<Uint8Array>;
}

/**
 * Read a file out of a turn's sandbox as text.
 *
 * A direct harness-to-orchestrator call — the model does not issue it and cannot
 * observe it. Serves any path in the sandbox, not only declared artifacts.
 */
export async function downloadSandboxText(
  client: TrueForge,
  sessionId: string,
  turnId: string,
  path: string,
): Promise<string> {
  const body = (await client.sessions.downloadSandboxFile(sessionId, turnId, {
    path,
  })) as unknown as BinaryBody | string | Uint8Array;

  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);

  if (typeof body.bytes === 'function') {
    return new TextDecoder().decode(await body.bytes());
  }
  if (typeof body.arrayBuffer === 'function') {
    return new TextDecoder().decode(await body.arrayBuffer());
  }

  throw new Error(`downloadSandboxFile returned an unreadable body for ${path}.`);
}
