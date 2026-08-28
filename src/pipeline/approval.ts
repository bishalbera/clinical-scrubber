/**
 *
 * The point of this gate is that the CMO approves the *method*, not a button. So the
 * packet carries both agent-authored scripts in full — the de-identification rules and
 * the statistical methodology — alongside the aggregate results. Those scripts are the
 * ones pulled out of the sandbox by file download, so they are the exact text that ran
 * rather than a summary of it.
 *
 * A denial is not a stop. The reason goes back to the agent, which revises and presents
 * again, and the loop continues until the CMO approves or the attempt limit is reached.
 * Nothing is released on a denial.
 */

import type { EventIndex } from '../lib/event-index.js';
import { type IndexedEvent } from '../lib/event-index.js';
import { REPORT_TOOL_NAME } from '../mcp/report-server.js';

/** How many revise-and-resubmit rounds before giving up. */
const MAX_ROUNDS = 4;

export interface PendingApproval {
  readonly threadId: string;
  readonly toolCallId: string;
  /** Arguments the agent proposed to release, as JSON text. */
  readonly arguments: string;
}

export interface ReviewPacket {
  readonly scrubScript: string;
  readonly analyzeScript: string;
  readonly analysis: Record<string, unknown>;
  readonly proposed: PendingApproval;
}

export type ReviewDecision = { allow: true } | { allow: false; reason: string };

/** Asks a human to review the packet. */
export type Reviewer = (packet: ReviewPacket) => Promise<ReviewDecision> | ReviewDecision;

/**
 * Builds the packet for one round.
 *
 * Called per round rather than once, because a denial makes the agent revise its
 * scripts — showing round one's methodology while approving round three's output
 * would defeat the point of reviewing a method.
 */
export type PacketBuilder = (pending: PendingApproval) => Promise<ReviewPacket> | ReviewPacket;

/**
 * Confirms the release actually executed after an allow.
 *
 * An operator saying yes is not the same as the tool having run: the resumed turn can
 * fail, or finish without calling the tool at all.
 */
export type ReleaseConfirmer = (resumed: EventIndex) => Promise<boolean> | boolean;

export interface ApprovalOutcome {
  readonly approved: boolean;
  readonly rounds: number;
  /** Reasons given for each denial, oldest first. */
  readonly denials: readonly string[];
  readonly index: EventIndex;
}

/**
 * Find the tool call waiting on a human, if the turn paused for one.
 *
 * Looks at `tool.approval_required` for the pending ids, then recovers the proposed
 * arguments from the `model.message` named by `source_event_id` — the packet has to
 * show what would actually be released, not just that something is pending.
 */
export function pendingApproval(index: EventIndex): PendingApproval | undefined {
  for (const event of index.allEvents()) {
    if (event.type !== 'tool.approval_required') continue;

    const calls = (event.toolCalls ?? event.tool_calls) as
      Array<{ id?: string; sourceEventId?: string; source_event_id?: string }> | undefined;
    const call = calls?.[0];
    if (call?.id === undefined) continue;

    const threadId =
      typeof event.threadId === 'string' ? event.threadId : String(event.thread_id ?? 'main');
    const sourceId = call.sourceEventId ?? call.source_event_id;

    return {
      threadId,
      toolCallId: call.id,
      arguments: argumentsFor(index, sourceId, call.id),
    };
  }
  return undefined;
}

function argumentsFor(index: EventIndex, sourceEventId: unknown, toolCallId: string): string {
  for (const event of index.allEvents()) {
    if (typeof sourceEventId === 'string' && event.id !== sourceEventId) continue;

    const calls = (event.toolCalls ?? event.tool_calls) as
      Array<{ id?: string; function?: { name?: string; arguments?: string } }> | undefined;
    if (!Array.isArray(calls)) continue;

    for (const call of calls) {
      if (call.id === toolCallId || call.function?.name === REPORT_TOOL_NAME) {
        return call.function?.arguments ?? '';
      }
    }
  }
  return '';
}

/** Render the packet a CMO actually reads. */
export function formatReviewPacket(packet: ReviewPacket): string {
  const rule = (title: string): string => `\n${'═'.repeat(72)}\n${title}\n${'═'.repeat(72)}`;

  let proposed = packet.proposed.arguments;
  try {
    proposed = JSON.stringify(JSON.parse(proposed), null, 2);
  } catch {
    // Leave the raw text; a malformed proposal is itself worth seeing.
  }

  return [
    rule('CMO REVIEW — approval required before the report is released'),
    '',
    'You are approving a METHOD, not a button. Two scripts were written by the agent',
    'and run inside the sandbox. Read them before deciding.',
    rule('1. De-identification script (scrub.py)'),
    packet.scrubScript.trimEnd(),
    rule('2. Statistical methodology (analyze.py)'),
    packet.analyzeScript.trimEnd(),
    rule('3. Aggregate results'),
    JSON.stringify(packet.analysis, null, 2),
    rule('4. Proposed for release'),
    proposed,
    '',
  ].join('\n');
}

/**
 * Drive the approval loop to a decision.
 *
 * `resume` runs a new turn carrying the approval or denial and returns its event index,
 * so this stays testable without a live harness.
 */
export async function runApprovalLoop(
  initial: EventIndex,
  packetFor: PacketBuilder,
  review: Reviewer,
  resume: (threadId: string, toolCallId: string, decision: ReviewDecision) => Promise<EventIndex>,
  confirmRelease?: ReleaseConfirmer,
): Promise<ApprovalOutcome> {
  let index = initial;
  const denials: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const pending = pendingApproval(index);
    if (pending === undefined) {
      // Nothing is pending and we have not returned yet, so no approval was ever
      // granted — an allow returns immediately below. Either the agent never called
      // the gated tool, or it gave up after a denial. Neither is a release.
      return { approved: false, rounds: round - 1, denials, index };
    }

    const decision = await review(await packetFor(pending));
    if (!decision.allow) denials.push(decision.reason);

    index = await resume(pending.threadId, pending.toolCallId, decision);

    if (decision.allow) {
      if (confirmRelease !== undefined && !(await confirmRelease(index))) {
        throw new Error(
          'The CMO approved, but the release did not execute. Reporting success here ' +
            'would claim a report exists when none does.',
        );
      }
      return { approved: true, rounds: round, denials, index };
    }
  }

  throw new Error(
    `The CMO denied ${MAX_ROUNDS} times without approving. Nothing was released.\n` +
      denials.map((r, i) => `  ${i + 1}. ${r}`).join('\n'),
  );
}

/** Build the resume input for a decision. */
export function approvalInput(
  threadId: string,
  toolCallId: string,
  decision: ReviewDecision,
): IndexedEvent {
  return {
    type: 'user.tool_approval',
    id: toolCallId,
    threadId,
    toolCallId,
    approval: decision.allow ? { status: 'allow' } : { status: 'deny', reason: decision.reason },
  };
}
