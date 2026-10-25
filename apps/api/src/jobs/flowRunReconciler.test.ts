import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Tool catalog W04 (#5219), plan Task A8 — the flow run reconciler. Each
 * clause is one SELECT … FOR UPDATE SKIP LOCKED (rendered and inspected here)
 * followed by an enqueue after commit; (e) pauses enabled event flows when
 * event delivery is not durable. The SQL is exercised against Postgres by the
 * A12 integration suite.
 */
const h = vi.hoisted(() => ({
  responses: new Map<string, Array<{ id: string }>>(),
  queries: [] as string[],
  enqueue: vi.fn(async () => 'job'),
  pauseFlow: vi.fn(async () => {}),
  durable: true,
  inTx: false,
  enqueuedInTx: [] as boolean[],
}));

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q).sql.replace(/\s+/g, ' ');

vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (q: SQL) => {
      const text = render(q);
      h.queries.push(text);
      for (const [marker, rows] of h.responses) if (text.includes(marker)) return rows;
      return [];
    }),
  },
  withSystemDbAccessContext: async (fn: () => unknown) => {
    h.inTx = true;
    try { return await fn(); } finally { h.inTx = false; }
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('./flowRunQueue', () => ({
  enqueueFlowRunSlice: (...a: unknown[]) => { h.enqueuedInTx.push(h.inTx); return (h.enqueue as (...x: unknown[]) => Promise<string>)(...a); },
}));
vi.mock('../services/flows/versions', () => ({ pauseFlow: (...a: unknown[]) => (h.pauseFlow as (...x: unknown[]) => Promise<void>)(...a) }));
vi.mock('../services/flowValidator', () => ({ isFlowEventDeliveryDurable: () => h.durable }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { reconcileFlowRuns, FLOW_RUN_RECONCILE_LIMIT } from './flowRunReconciler';

const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  vi.clearAllMocks();
  h.responses.clear();
  h.queries.length = 0;
  h.enqueuedInTx.length = 0;
  h.durable = true;
});

describe('reconcileFlowRuns', () => {
  it('nothing to do ⇒ nothing enqueued, nothing paused', async () => {
    const summary = await reconcileFlowRuns();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.pauseFlow).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ queued: 0, awaitingApproval: 0, leaseExpired: 0, overdueWaits: 0, pausedEventFlows: 0 });
  });

  it('(a) re-enqueues queued runs untouched for 2 minutes', async () => {
    h.responses.set("status = 'queued'", [{ id: id(1) }]);
    await reconcileFlowRuns();
    expect(h.enqueue).toHaveBeenCalledWith(id(1));
    const q = h.queries.find((s) => s.includes("status = 'queued'"))!;
    expect(q).toMatch(/updated_at < now\(\) - interval '2 minutes'/);
    expect(q).toMatch(/LIMIT 500 FOR UPDATE SKIP LOCKED/);
  });

  it('(b) re-enqueues awaiting_approval runs whose step intent is terminal', async () => {
    h.responses.set("r.status = 'awaiting_approval'", [{ id: id(2) }]);
    await reconcileFlowRuns();
    expect(h.enqueue).toHaveBeenCalledWith(id(2));
    const q = h.queries.find((s) => s.includes("r.status = 'awaiting_approval'"))!;
    expect(q).toContain("s.status = 'awaiting_approval'");
    expect(q).toContain("i.status IN ('completed', 'failed', 'rejected', 'expired', 'cancelled')");
    expect(q).toMatch(/FOR UPDATE OF r SKIP LOCKED/);
  });

  it('(c) re-enqueues running runs whose lease expired', async () => {
    h.responses.set("status = 'running'", [{ id: id(3) }]);
    await reconcileFlowRuns();
    expect(h.enqueue).toHaveBeenCalledWith(id(3));
    const q = h.queries.find((s) => s.includes("status = 'running'"))!;
    expect(q).toContain('lease_expires_at < now()');
  });

  it('(d) re-enqueues waiting runs 2 minutes past their wake', async () => {
    h.responses.set("status = 'waiting'", [{ id: id(4) }]);
    await reconcileFlowRuns();
    expect(h.enqueue).toHaveBeenCalledWith(id(4));
    expect(h.queries.find((s) => s.includes("status = 'waiting'"))).toMatch(/wake_at < now\(\) - interval '2 minutes'/);
  });

  it('(e) pauses every enabled event flow when delivery is not durable', async () => {
    h.durable = false;
    const flowId = 'eeeeeeee-0000-4000-8000-000000000001';
    h.responses.set("definition->'trigger'->>'type' = 'event'", [{ id: flowId }]);
    const summary = await reconcileFlowRuns();
    expect(h.pauseFlow).toHaveBeenCalledWith(flowId, 'event_dispatch_not_durable');
    expect(summary.pausedEventFlows).toBe(1);
    expect(h.queries.find((s) => s.includes("'event'"))).toContain("status = 'enabled'");
  });

  it('(e) does nothing while delivery is durable', async () => {
    h.responses.set("definition->'trigger'->>'type' = 'event'", [{ id: 'eeeeeeee-0000-4000-8000-000000000001' }]);
    await reconcileFlowRuns();
    expect(h.pauseFlow).not.toHaveBeenCalled();
    expect(h.queries.some((s) => s.includes("'event'"))).toBe(false);
  });

  it('enqueues only after the selecting transaction ends, never inside it', async () => {
    h.responses.set("status = 'queued'", [{ id: id(1) }, { id: id(5) }]);
    await reconcileFlowRuns();
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(h.enqueuedInTx).toEqual([false, false]);
  });

  it('one failed enqueue does not stop the others', async () => {
    h.responses.set("status = 'queued'", [{ id: id(1) }, { id: id(5) }]);
    h.enqueue.mockRejectedValueOnce(new Error('redis down'));
    const summary = await reconcileFlowRuns();
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(summary.enqueueFailures).toBe(1);
  });

  it('every clause is bounded', () => {
    expect(FLOW_RUN_RECONCILE_LIMIT).toBe(500);
  });
});
