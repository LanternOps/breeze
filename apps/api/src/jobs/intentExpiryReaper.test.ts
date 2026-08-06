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

/**
 * Flattens a drizzle sql`` object to its static SQL text (StringChunks and
 * interpolated column identifiers only — bound params contribute nothing).
 * Same introspection approach as ticketSlaWorker.test.ts's `sqlText`.
 */
function sqlText(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  const obj = q as { queryChunks?: unknown[]; value?: unknown[]; name?: string };
  if (Array.isArray(obj.queryChunks)) {
    return obj.queryChunks.map(sqlText).join(' ');
  }
  if (Array.isArray(obj.value)) {
    return (obj.value as string[]).join('');
  }
  if (typeof obj.name === 'string') return obj.name;
  return '';
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

  it('splits the deadline by status: pending_approval on approval_expires_at falling back to expires_at, approved on release_by falling back to expires_at', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });

    await reapExpiredIntents();

    const query = sqlText(executeMock.mock.calls[0]?.[0]);
    // pending_approval branch checks approval_expires_at with an expires_at
    // fallback for legacy writer rows that never set approval_expires_at.
    expect(query).toContain('COALESCE( approval_expires_at ,  expires_at )');
    expect(query).toMatch(/status\s*=\s*'pending_approval'\s+AND\s+COALESCE/);
    // approved branch checks release_by with an expires_at fallback for
    // legacy rows that predate the release-lease column.
    expect(query).toContain('COALESCE( release_by ,  expires_at )');
    expect(query).toMatch(/status\s*=\s*'approved'\s+AND\s+COALESCE/);
  });

  it('reaps a legacy pending_approval row with a NULL approval_expires_at once expires_at has passed', async () => {
    // Legacy-writer row: approval_expires_at was never backfilled, but
    // expires_at is the pre-split deadline and it has passed. Without the
    // COALESCE fallback, `approval_expires_at < now()` on a NULL column is
    // NULL (never true in SQL), so this row would never be reaped.
    const past = new Date(Date.now() - 60_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'intent-legacy-null-approval-deadline',
          org_id: 'org-1',
          action_name: 'breeze.legacy',
          argument_digest: 'digest-legacy',
          source: 'chat',
          requested_by_user_id: 'user-1',
          expires_at: past,
        },
      ],
    });
    const chain = makeUpdateChain([]);
    updateMock.mockReturnValue({ set: chain.set });

    const reaped = await reapExpiredIntents();

    expect(reaped).toBe(1);
    expect(recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'intent-legacy-null-approval-deadline', outcome: 'expired' }),
    );
  });

  it('the 59:59 trap: an approved intent past approval_expires_at but with releaseBy still in the future is NOT reaped', async () => {
    // The reaper's WHERE clause runs against a real database and this test
    // mocks db.execute at the boundary, so it cannot exercise Postgres's
    // actual row filtering. What it CAN prove — and what regresses the trap
    // if broken — is that the approved branch's predicate is anchored on
    // release_by (COALESCE'd with expires_at), not approval_expires_at. If a
    // future edit swapped that back to approval_expires_at, this assertion
    // fails; the query-shape assertions above are the regression guard for
    // this exact scenario, verified end-to-end by the RLS/integration suite.
    executeMock.mockResolvedValueOnce({ rows: [] });

    await reapExpiredIntents();

    const query = sqlText(executeMock.mock.calls[0]?.[0]);
    expect(query).not.toMatch(/status\s*=\s*'approved'\s+AND\s+approval_expires_at\s*<\s*now\(\)/);
  });

  it('reaps an approved intent once release_by has passed', async () => {
    const past = new Date(Date.now() - 60_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'intent-approved-leased',
          org_id: 'org-1',
          action_name: 'breeze.c',
          argument_digest: 'd3',
          source: 'chat',
          requested_by_user_id: 'user-1',
          expires_at: past,
        },
      ],
    });
    const chain = makeUpdateChain([]);
    updateMock.mockReturnValue({ set: chain.set });

    const reaped = await reapExpiredIntents();

    expect(reaped).toBe(1);
    expect(recordActionIntentEvent).toHaveBeenCalledTimes(1);
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
