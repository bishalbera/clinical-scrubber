/**
 * The gate's job is to stop the run for a person and to keep it stopped on a denial.
 * These cover both, plus the packet contents — a CMO approving a method needs the
 * scripts in front of them, not a summary of the scripts.
 */

import { describe, expect, it, vi } from 'vitest';

import { EventIndex } from '../src/lib/event-index.js';
import {
  approvalInput,
  formatReviewPacket,
  pendingApproval,
  runApprovalLoop,
  type ReviewPacket,
} from '../src/pipeline/approval.js';

function pausedIndex(toolCallId = 'call-1'): EventIndex {
  const index = new EventIndex();
  index.add({
    type: 'model.message',
    id: 'msg-1',
    threadId: 'main',
    toolCalls: [
      {
        id: toolCallId,
        function: {
          name: 'generate_final_report',
          arguments: '{"title":"Efficacy summary","summary":"n=291, p=0.00015"}',
        },
      },
    ],
  });
  index.add({
    type: 'tool.approval_required',
    id: 'evt-1',
    threadId: 'main',
    toolCalls: [{ id: toolCallId, sourceEventId: 'msg-1' }],
  });
  return index;
}

const PACKET: ReviewPacket = {
  scrubScript: 'import pandas as pd  # DROP ssn',
  analyzeScript: 'from scipy import stats  # ttest_ind',
  analysis: { p_value: 0.00015 },
  proposed: { threadId: 'main', toolCallId: 'call-1', arguments: '{"title":"T"}' },
};

describe('pendingApproval', () => {
  it('finds the paused tool call and what it proposed to release', () => {
    const pending = pendingApproval(pausedIndex());

    expect(pending?.toolCallId).toBe('call-1');
    expect(pending?.threadId).toBe('main');
    expect(pending?.arguments).toContain('Efficacy summary');
  });

  it('returns undefined when the turn never paused', () => {
    const index = new EventIndex();
    index.add({ type: 'model.message', id: 'm', threadId: 'main', content: 'done' });

    expect(pendingApproval(index)).toBeUndefined();
  });
});

describe('formatReviewPacket', () => {
  it('shows both scripts in full, because the CMO approves the method', () => {
    const rendered = formatReviewPacket(PACKET);

    expect(rendered).toContain('DROP ssn');
    expect(rendered).toContain('ttest_ind');
    expect(rendered).toContain('0.00015');
  });

  it('survives a malformed proposal rather than hiding it', () => {
    const rendered = formatReviewPacket({
      ...PACKET,
      proposed: { ...PACKET.proposed, arguments: '{not json' },
    });
    expect(rendered).toContain('{not json');
  });
});

describe('runApprovalLoop', () => {
  it('approves and stops asking', async () => {
    const resume = vi.fn(async () => new EventIndex());
    const outcome = await runApprovalLoop(
      pausedIndex(),
      () => PACKET,
      () => ({ allow: true }),
      resume,
    );

    expect(outcome.approved).toBe(true);
    expect(outcome.rounds).toBe(1);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('does not release on a denial, and carries the reason back', async () => {
    const seen: string[] = [];
    const resume = vi.fn(async (_t: string, _c: string, d: { allow: boolean; reason?: string }) => {
      if (!d.allow) seen.push(d.reason ?? '');
      return new EventIndex();
    });

    const outcome = await runApprovalLoop(
      pausedIndex(),
      () => PACKET,
      () => ({ allow: false, reason: 'Use Welch, not Student.' }),
      resume,
    );

    expect(outcome.approved).toBe(false);
    expect(seen).toEqual(['Use Welch, not Student.']);
  });

  it('re-presents after a denial until approved', async () => {
    let round = 0;
    const resume = vi.fn(async () => pausedIndex(`call-${++round}`));

    const outcome = await runApprovalLoop(
      pausedIndex(),
      () => PACKET,
      () => (round < 2 ? { allow: false, reason: `fix ${round}` } : { allow: true }),
      resume,
    );

    expect(outcome.approved).toBe(true);
    expect(outcome.denials).toEqual(['fix 0', 'fix 1']);
  });

  it('gives up rather than looping forever, and releases nothing', async () => {
    const resume = vi.fn(async () => pausedIndex());

    await expect(
      runApprovalLoop(
        pausedIndex(),
        () => PACKET,
        () => ({ allow: false, reason: 'no' }),
        resume,
      ),
    ).rejects.toThrow(/denied 4 times without approving/);
  });
});

describe('approvalInput', () => {
  it('builds an allow item', () => {
    expect(approvalInput('main', 'c1', { allow: true })).toMatchObject({
      type: 'user.tool_approval',
      threadId: 'main',
      toolCallId: 'c1',
      approval: { status: 'allow' },
    });
  });

  it('carries the reason on a deny', () => {
    expect(approvalInput('main', 'c1', { allow: false, reason: 'why' }).approval).toEqual({
      status: 'deny',
      reason: 'why',
    });
  });
});
