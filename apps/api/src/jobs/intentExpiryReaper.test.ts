import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, updateMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      execute: (...args: unknown[]) => executeMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

vi.mock('../services/actionIntents/metrics', () => ({
  recordActionIntentEvent: vi.fn(),
  recordActionIntentMetric: vi.fn(),
}));

import { reapExpiredIntents, reapStaleExecutingIntents } from './intentExpiryReaper';
import { writeAuditEvent } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import { recordActionIntentEvent, recordActionIntentMetric } from '../services/actionIntents/metrics';
import { approvalRequests } from '../db/schema/approvals';

function makeUpdateChain(returningValue: unknown = undefined) {
  const where = vi.fn(() => Promise.resolve(returningValue));
  const set = vi.fn(() => ({ where }));
  return { set, where };
}

describe('intentExpiryReaper.reapExpiredIntents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('flips pending_approval/approved intents past expiry to expired, expires linked approvals, and audits', async () => {
    const past = new Date(Date.now() - 60_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'intent-1',
          org_id: 'org-1',
          action_name: 'breeze.runScript',
          argument_digest: 'digest-1',
          source: 'chat',
          requested_by_user_id: 'user-1',
          expires_at: past,
        },
      ],
    });

    const chain = makeUpdateChain([]);
    updateMock.mockImplementation((table: unknown) => {
      if (table === approvalRequests) {
        return { set: chain.set };
      }
      throw new Error(`Unexpected table update: ${String(table)}`);
    });

    const reaped = await reapExpiredIntents();

    expect(reaped).toBe(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
    // Linked pending approval_requests rows for this intent are expired.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(approvalRequests);
    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    );

    expect(recordActionIntentEvent).toHaveBeenCalledTimes(1);
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        intentId: 'intent-1',
        actionName: 'breeze.runScript',
        argumentDigest: 'digest-1',
        source: 'chat',
        outcome: 'expired',
      }),
    );
  });

  it('returns 0 and touches nothing when no intents are past expiry', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });

    const reaped = await reapExpiredIntents();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
    expect(recordActionIntentEvent).not.toHaveBeenCalled();
  });

  it('transitions both pending_approval and approved intents in one pass', async () => {
    const past = new Date(Date.now() - 5_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'intent-pending',
          org_id: 'org-1',
          action_name: 'breeze.a',
          argument_digest: 'd1',
          source: 'chat',
          requested_by_user_id: 'user-1',
          expires_at: past,
        },
        {
          id: 'intent-approved',
          org_id: 'org-1',
          action_name: 'breeze.b',
          argument_digest: 'd2',
          source: 'mcp_api',
          requested_by_user_id: null,
          expires_at: past,
        },
      ],
    });
    const chain = makeUpdateChain([]);
    updateMock.mockReturnValue({ set: chain.set });

    const reaped = await reapExpiredIntents();

    expect(reaped).toBe(2);
    expect(recordActionIntentEvent).toHaveBeenCalledTimes(2);
  });
});

describe('intentExpiryReaper.reapStaleExecutingIntents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('flips stuck executing intents to failed/execution_lost and audits with result failure', async () => {
    const decidedAt = new Date(Date.now() - 25 * 60 * 1000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'intent-2',
          org_id: 'org-2',
          action_name: 'breeze.deleteRegistryKey',
          argument_digest: 'digest-2',
          source: 'mcp_api',
          decided_at: decidedAt,
        },
      ],
    });

    const reaped = await reapStaleExecutingIntents();

    expect(reaped).toBe(1);
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-2',
        action: 'action_intent.executed',
        resourceType: 'action_intent',
        resourceId: 'intent-2',
        actorType: 'system',
        result: 'failure',
        details: expect.objectContaining({ errorCode: 'execution_lost' }),
      }),
    );
    // Metrics counter still records this as an 'executed' outcome even
    // though the audit path bypasses recordActionIntentEvent (see file
    // header: 'executed' isn't in metrics.ts's FAILURE_OUTCOMES set, so
    // recordActionIntentEvent would mis-file this as a success).
    expect(recordActionIntentMetric).toHaveBeenCalledWith('mcp_api', 'breeze.deleteRegistryKey', 'executed');
    expect(recordActionIntentEvent).not.toHaveBeenCalled();
  });

  it('returns 0 when nothing is stuck past the stale-executing timeout', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });

    const reaped = await reapStaleExecutingIntents();

    expect(reaped).toBe(0);
    expect(writeAuditEvent).not.toHaveBeenCalled();
    expect(recordActionIntentMetric).not.toHaveBeenCalled();
  });

  it('captures the error but does not throw if the audit write fails', async () => {
    const decidedAt = new Date(Date.now() - 25 * 60 * 1000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'intent-3',
          org_id: 'org-3',
          action_name: 'breeze.x',
          argument_digest: 'digest-3',
          source: 'chat',
          decided_at: decidedAt,
        },
      ],
    });
    (writeAuditEvent as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('audit sink down');
    });

    const reaped = await reapStaleExecutingIntents();

    expect(reaped).toBe(1);
    expect(captureException).toHaveBeenCalled();
  });
});
