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

const insertMock = vi.fn(() => ({ values: vi.fn(async () => undefined) }));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      execute: (...args: unknown[]) => executeMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
      // Was NOT stubbed before wave 2, so `db.insert` fell through to the real
      // Drizzle insert. Every reaper test was quietly issuing a real INSERT that
      // failed and was swallowed by the old best-effort catch, which is exactly
      // why the new intent_expired write looked covered and was not.
      insert: (...args: unknown[]) => insertMock(...(args as [])),
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

  it('writes one intent_expired outbox row per expired intent, ids only', async () => {
    // Untested before: db.insert was unstubbed, so this line ran for real,
    // failed, and was swallowed. Nothing an expiry does is visible to the
    // requester without this row.
    executeMock.mockResolvedValueOnce({
      rows: [
        { id: 'i-1', org_id: 'org-1', action_name: 'run_script', argument_digest: 'd1', source: 'chat', requested_by_user_id: 'u-1', expires_at: new Date() },
        { id: 'i-2', org_id: 'org-2', action_name: 'run_script', argument_digest: 'd2', source: 'chat', requested_by_user_id: 'u-2', expires_at: new Date() },
      ],
    });
    updateMock.mockReturnValue({ set: makeUpdateChain([]).set });

    await reapExpiredIntents();

    expect(insertMock).toHaveBeenCalledTimes(1);
    const values = insertMock.mock.results[0]!.value.values as ReturnType<typeof vi.fn>;
    const rows = values.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      intentId: 'i-1',
      eventType: 'intent_expired',
      payload: { intentId: 'i-1', orgId: 'org-1' },
    });
    // Ids only — no action name, no digest, no arguments.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('run_script');
    expect(serialized).not.toContain('d1');
  });

  it('PROPAGATES an outbox failure so the expiry rolls back with it', async () => {
    // The whole pass is ONE transaction: catching a DB error in JS does not
    // un-abort it, so a swallowed failure discarded the expiry too while the
    // caller still reported success and the audit log recorded an expiry that
    // never committed.
    executeMock.mockResolvedValueOnce({
      rows: [
        { id: 'i-1', org_id: 'org-1', action_name: 'run_script', argument_digest: 'd1', source: 'chat', requested_by_user_id: 'u-1', expires_at: new Date() },
      ],
    });
    updateMock.mockReturnValue({ set: makeUpdateChain([]).set });
    insertMock.mockReturnValueOnce({
      values: vi.fn(async () => { throw new Error('constraint violation'); }),
    } as never);

    await expect(reapExpiredIntents()).rejects.toThrow('constraint violation');
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

  /**
   * SCOPE WARNING — read before adding a test here.
   *
   * This suite mocks `db.execute` at the boundary, so Postgres NEVER
   * evaluates the WHERE clause and the mocked rows come back regardless of
   * what the predicate says. A test in this file therefore CANNOT prove which
   * rows the reaper selects: seeding a "legacy NULL approval_expires_at" row
   * and asserting it was reaped would pass identically if the predicate were
   * `1=1`. Two such tests used to live here and have been deleted rather than
   * left as false confidence.
   *
   * All row-selection behavior — the 59:59 trap, both legacy `expires_at`
   * fallbacks, and their negative counterparts — is proved against real
   * Postgres in `intentExpiryReaper.integration.test.ts`
   * ('reapExpiredIntents (real PG) — status-split deadline').
   *
   * What the two tests below legitimately cover is narrower and stated as
   * such: the SQL TEXT the reaper builds still anchors each status on the
   * right deadline column. That is a cheap tripwire for a careless rewrite,
   * not a behavioral guarantee.
   */
  describe('deadline predicate (SQL text only — row selection is proved in the integration suite)', () => {
    /** Static SQL text with runs of whitespace collapsed, so assertions are
     *  not hostage to drizzle's chunk-join spacing (the previous version
     *  asserted `'COALESCE( approval_expires_at ,  expires_at )'` — double
     *  space included — which broke on formatting alone and proved nothing
     *  semantic). */
    const builtSql = async (): Promise<string> => {
      executeMock.mockResolvedValueOnce({ rows: [] });
      await reapExpiredIntents();
      return sqlText(executeMock.mock.calls[0]?.[0]).replace(/\s+/g, ' ');
    };

    it('anchors pending_approval on approval_expires_at with an expires_at fallback', async () => {
      expect(await builtSql()).toMatch(
        /status\s*=\s*'pending_approval'\s+AND\s+COALESCE\(\s*approval_expires_at\s*,\s*expires_at\s*\)\s*<\s*now\(\)/,
      );
    });

    it('anchors approved on release_by with an expires_at fallback, never on approval_expires_at', async () => {
      // The 59:59 trap in SQL-shape form: once an intent is approved,
      // approval_expires_at no longer governs it — the fresh release_by lease
      // does. Both directions are asserted because the negative alone (the
      // previous version of this test) passes for any rewrite that merely
      // spells the regression differently.
      const query = await builtSql();
      expect(query).toMatch(
        /status\s*=\s*'approved'\s+AND\s+COALESCE\(\s*release_by\s*,\s*expires_at\s*\)\s*<\s*now\(\)/,
      );
      expect(query).not.toMatch(/status\s*=\s*'approved'\s+AND\s+approval_expires_at/);
    });
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
