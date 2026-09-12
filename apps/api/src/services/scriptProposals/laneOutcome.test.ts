import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Lane circuit (spec §4.6 "After execution", §9): a per-org streak of failed
 * or unknown verifications that opens at LANE_OPEN_THRESHOLD, by CAS.
 *
 * The DB mock is a tiny in-memory row: the upsert applies the `set` payload,
 * the CAS update flips state only when it is still 'closed'.
 */
let row: Record<string, unknown> | null = null;
const audits: Array<Record<string, unknown>> = [];
const notifications: Array<Record<string, unknown>> = [];
const mockRecordRunTerminal = vi.fn();
const mockRegister = vi.fn();
const selectRows: unknown[][] = [];

vi.mock('../../db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
          returning: async () => {
            if (!row) row = { orgId: v.orgId, consecutiveFailedVerifications: v.consecutiveFailedVerifications, state: 'closed', openedAt: null, openedReason: null };
            else {
              const inc = typeof set.consecutiveFailedVerifications === 'object';
              row = {
                ...row,
                consecutiveFailedVerifications: inc
                  ? (row.consecutiveFailedVerifications as number) + 1
                  : (set.consecutiveFailedVerifications as number),
              };
            }
            return [row];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (row?.state !== 'closed') return [];
            row = { ...row, ...patch };
            return [row];
          },
        }),
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => selectRows.shift() ?? [] }) }) }),
  },
  runOutsideDbContext: async (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
}));
vi.mock('../auditService', () => ({ createAuditLogAsync: async (p: unknown) => { audits.push(p as never); } }));
vi.mock('../userNotifications', () => ({ createNotification: async (p: unknown) => { notifications.push(p as never); return 'n-1'; } }));
vi.mock('../aiAgents/agentCircuit', () => ({ recordRunTerminal: (...a: unknown[]) => mockRecordRunTerminal(...a) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./verify', () => ({ registerUnattendedVerificationOutcomeHandler: (...a: unknown[]) => mockRegister(...a) }));

import {
  LANE_OPEN_THRESHOLD,
  onUnattendedVerificationOutcome,
  registerLaneOutcomeHandler,
  resolveUnattendedOutcome,
} from './laneOutcome';

const CHAT = { kind: 'chat', sessionId: 'sess-1', userId: 'u-1' } as const;
const AGENT = { kind: 'agent', runId: 'run-1', agentId: 'agent-1', profile: 'full' } as const;
const base = { orgId: 'org-1', proposalId: 'prop-1', intentId: 'int-1', executionId: 'exec-1' };

beforeEach(() => {
  row = null;
  audits.length = 0;
  notifications.length = 0;
  selectRows.length = 0;
  mockRecordRunTerminal.mockReset();
  mockRegister.mockReset();
});

describe('onUnattendedVerificationOutcome', () => {
  it('the threshold is two (spec §9)', () => {
    expect(LANE_OPEN_THRESHOLD).toBe(2);
  });

  it('a verified run RESETS the counter and audits ai.script.unattended_verified', async () => {
    row = { orgId: 'org-1', consecutiveFailedVerifications: 1, state: 'closed', openedAt: null, openedReason: null };
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verified', origin: CHAT });
    expect(row).toMatchObject({ consecutiveFailedVerifications: 0, state: 'closed' });
    expect(audits[0]).toMatchObject({ action: 'ai.script.unattended_verified', result: 'success', initiatedBy: 'ai' });
  });

  it('a verified run never CLOSES an open lane — reset is a human decision', async () => {
    row = { orgId: 'org-1', consecutiveFailedVerifications: 2, state: 'open', openedAt: new Date(), openedReason: 'x' };
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verified', origin: CHAT });
    expect(row).toMatchObject({ consecutiveFailedVerifications: 0, state: 'open' });
  });

  it('a FAILED verification increments and audits ai.script.unattended_failed', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(row).toMatchObject({ consecutiveFailedVerifications: 1, state: 'closed' });
    expect(audits[0]).toMatchObject({ action: 'ai.script.unattended_failed', result: 'failure' });
  });

  it('an UNKNOWN outcome counts as a failure — an unverifiable run is not a success', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'unknown', origin: CHAT });
    expect(row).toMatchObject({ consecutiveFailedVerifications: 1 });
    expect(audits[0]).toMatchObject({ action: 'ai.script.unattended_failed' });
  });

  it('the lane OPENS at the second consecutive failure, not the first, and audits the open once', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(row).toMatchObject({ state: 'closed' });
    expect(audits.some((a) => a.action === 'ai.script_lane.opened')).toBe(false);

    await onUnattendedVerificationOutcome({ ...base, outcome: 'unknown', origin: CHAT });
    expect(row).toMatchObject({ state: 'open', openedReason: expect.stringContaining(String(LANE_OPEN_THRESHOLD)) });
    expect(audits.filter((a) => a.action === 'ai.script_lane.opened')).toHaveLength(1);

    // A third failure on an already-open lane does not re-audit the open.
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(audits.filter((a) => a.action === 'ai.script_lane.opened')).toHaveLength(1);
  });

  it('an AGENT-origin failure ALSO feeds the agent circuit', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: AGENT });
    expect(mockRecordRunTerminal).toHaveBeenCalledWith(
      { id: 'run-1', orgId: 'org-1', agentId: 'agent-1', profile: 'full' },
      'completed', null, 'needs_attention',
    );
  });

  it('a CHAT-origin failure does NOT touch the agent circuit (there is no agent key)', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(mockRecordRunTerminal).not.toHaveBeenCalled();
  });

  it('an agent-origin VERIFIED run does not feed the agent circuit', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verified', origin: AGENT });
    expect(mockRecordRunTerminal).not.toHaveBeenCalled();
  });

  it('notifies the session owner when the lane OPENS on a chat-origin run, not on the first failure', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(notifications).toHaveLength(0);
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(notifications[0]).toMatchObject({ userId: 'u-1', orgId: 'org-1', priority: 'high' });
  });

  it('a verified run notifies nobody — success is not an interruption', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verified', origin: CHAT });
    expect(notifications).toHaveLength(0);
  });

  it('never throws: a bookkeeping fault is reported, not propagated', async () => {
    row = { orgId: 'org-1', consecutiveFailedVerifications: 0, state: 'closed', openedAt: null, openedReason: null };
    mockRecordRunTerminal.mockRejectedValue(new Error('circuit down'));
    await expect(onUnattendedVerificationOutcome({ ...base, outcome: 'unknown', origin: AGENT })).resolves.toBeUndefined();
  });
});

describe('resolveUnattendedOutcome (the W03 hook adapter)', () => {
  it('returns null for a proposal with no intent', async () => {
    selectRows.push([{ intentId: null, sessionId: null }]);
    await expect(resolveUnattendedOutcome({ id: 'prop-1', orgId: 'org-1' }, 'verified')).resolves.toBeNull();
  });

  it('returns null for a HUMAN-approved run — only lane runs move the circuit', async () => {
    selectRows.push([{ intentId: 'int-1', sessionId: 'sess-1' }]);
    selectRows.push([{ id: 'int-1', decidedVia: null, requestedByUserId: 'u-1', requestingAgentRunId: null, scriptReviewerEvidence: null }]);
    await expect(resolveUnattendedOutcome({ id: 'prop-1', orgId: 'org-1' }, 'verification_failed')).resolves.toBeNull();
  });

  it('resolves a chat-origin lane run', async () => {
    selectRows.push([{ intentId: 'int-1', sessionId: 'sess-1' }]);
    selectRows.push([{ id: 'int-1', decidedVia: 'script_reviewer', requestedByUserId: 'u-1', requestingAgentRunId: null, scriptReviewerEvidence: { proposalId: 'prop-1' } }]);
    await expect(resolveUnattendedOutcome({ id: 'prop-1', orgId: 'org-1' }, 'unknown')).resolves.toEqual({
      orgId: 'org-1', proposalId: 'prop-1', intentId: 'int-1', executionId: null, outcome: 'unknown',
      origin: { kind: 'chat', sessionId: 'sess-1', userId: 'u-1' },
    });
  });

  it('resolves an agent-origin lane run from the evidence + run row', async () => {
    selectRows.push([{ intentId: 'int-1', sessionId: null }]);
    selectRows.push([{ id: 'int-1', decidedVia: 'script_reviewer', requestedByUserId: null, requestingAgentRunId: 'run-1', scriptReviewerEvidence: { agent: { agentId: 'agent-1' } } }]);
    selectRows.push([{ agentId: 'agent-1', profile: 'sweep' }]);
    await expect(resolveUnattendedOutcome({ id: 'prop-1', orgId: 'org-1' }, 'verified')).resolves.toMatchObject({
      origin: { kind: 'agent', runId: 'run-1', agentId: 'agent-1', profile: 'sweep' },
    });
  });

  it('registerLaneOutcomeHandler installs the adapter into the W03 hook registry', () => {
    registerLaneOutcomeHandler();
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(typeof mockRegister.mock.calls[0]![0]).toBe('function');
  });
});
