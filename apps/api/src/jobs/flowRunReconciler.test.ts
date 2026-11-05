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
  failOn: new Map<string, Error>(),
  capture: vi.fn(),
  audit: vi.fn(),
}));

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q).sql.replace(/\s+/g, ' ');

vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (q: SQL) => {
      const text = render(q);
      h.queries.push(text);
      for (const [marker, err] of h.failOn) if (text.includes(marker)) throw err;
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
vi.mock('../services/sentry', () => ({ captureException: (...a: unknown[]) => h.capture(...a) }));
vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: () => ({}),
  writeAuditEvent: (...a: unknown[]) => h.audit(...a),
}));

import { reconcileFlowRuns, FLOW_RUN_RECONCILE_LIMIT, FlowRunReconcileError } from './flowRunReconciler';
import { LEGACY_DRAIN_MIN_MS } from '@breeze/shared';
import { TERMINAL_FLOW_RUN_STATUSES } from '../services/flows/runStore';

const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  vi.clearAllMocks();
  h.responses.clear();
  h.queries.length = 0;
  h.enqueuedInTx.length = 0;
  h.failOn.clear();
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

  it('one failed enqueue does not stop the others, but the pass then fails visibly', async () => {
    h.responses.set("status = 'queued'", [
      { id: id(1), org_id: 'cccccccc-0000-4000-8000-000000000001', flow_id: 'eeeeeeee-0000-4000-8000-000000000009' } as { id: string },
      { id: id(5) },
    ]);
    h.responses.set("status = 'waiting'", [{ id: id(4) }]);
    h.enqueue.mockRejectedValueOnce(new Error('redis down'));
    const err = await reconcileFlowRuns().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlowRunReconcileError);
    // Every clause still ran after the failure.
    expect(h.enqueue).toHaveBeenCalledTimes(3);
    expect(h.enqueue).toHaveBeenCalledWith(id(4));
    expect((err as FlowRunReconcileError).summary).toMatchObject({ queued: 2, overdueWaits: 1, enqueueFailures: 1 });
    expect(h.capture).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { org_id: 'cccccccc-0000-4000-8000-000000000001', flow_id: 'eeeeeeee-0000-4000-8000-000000000009', flow_run_id: id(1), flow_site: 'reconciler.enqueue' },
      { fingerprint: ['flow', 'reconciler.enqueue'] },
    );
  });

  it('a failing clause does not starve the clauses after it; the pass rethrows an aggregate', async () => {
    h.durable = false;
    h.failOn.set("status = 'queued'", new Error('statement timeout'));
    h.failOn.set("r.status = 'awaiting_approval'", new Error('deadlock'));
    h.responses.set("status = 'running'", [{ id: id(3) }]);
    h.responses.set("status = 'waiting'", [{ id: id(4) }]);
    h.responses.set("definition->'trigger'->>'type' = 'event'", [{ id: 'eeeeeeee-0000-4000-8000-000000000001' }]);
    const err = await reconcileFlowRuns().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlowRunReconcileError);
    expect((err as FlowRunReconcileError).errors).toHaveLength(2);
    expect(h.enqueue).toHaveBeenCalledWith(id(3));
    expect(h.enqueue).toHaveBeenCalledWith(id(4));
    expect(h.pauseFlow).toHaveBeenCalledTimes(1);
    expect((err as FlowRunReconcileError).summary).toMatchObject({ leaseExpired: 1, overdueWaits: 1, pausedEventFlows: 1, enqueueFailures: 0 });
    expect(h.capture).toHaveBeenCalledWith(expect.any(Error), undefined, { flow_site: 'reconciler.queued' }, { fingerprint: ['flow', 'reconciler.queued'] });
    expect(h.capture).toHaveBeenCalledWith(expect.any(Error), undefined, { flow_site: 'reconciler.awaiting_approval' }, { fingerprint: ['flow', 'reconciler.awaiting_approval'] });
  });

  it('a failing (e) select is collected too, after (a)-(d) ran', async () => {
    h.durable = false;
    h.failOn.set("definition->'trigger'->>'type' = 'event'", new Error('boom'));
    h.responses.set("status = 'queued'", [{ id: id(1) }]);
    const err = await reconcileFlowRuns().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlowRunReconcileError);
    expect(h.enqueue).toHaveBeenCalledWith(id(1));
    expect(h.capture).toHaveBeenCalledWith(expect.any(Error), undefined, { flow_site: 'reconciler.event_flows' }, { fingerprint: ['flow', 'reconciler.event_flows'] });
  });

  it('(e) a per-flow pause failure is fingerprinted, tagged with the flow, and fails the pass', async () => {
    h.durable = false;
    const a = 'eeeeeeee-0000-4000-8000-000000000001';
    const b = 'eeeeeeee-0000-4000-8000-000000000002';
    h.responses.set("definition->'trigger'->>'type' = 'event'", [
      { id: a, org_id: 'cccccccc-0000-4000-8000-000000000001', partner_id: null } as unknown as { id: string },
      { id: b, org_id: null, partner_id: 'dddddddd-0000-4000-8000-000000000001' } as unknown as { id: string },
    ]);
    h.pauseFlow.mockRejectedValueOnce(new Error('lock timeout'));
    const err = await reconcileFlowRuns().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlowRunReconcileError);
    expect(h.pauseFlow).toHaveBeenCalledTimes(2);
    expect((err as FlowRunReconcileError).summary).toMatchObject({ pausedEventFlows: 1, pauseFailures: 1 });
    expect(h.capture).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { org_id: 'cccccccc-0000-4000-8000-000000000001', flow_id: a, flow_site: 'reconciler.pause_event_flow' },
      { fingerprint: ['flow', 'reconciler.pause_event_flow'] },
    );
  });

  // #5221 B4 (Decision 7) — a reverted conversion's flow, once drained and aged.
  it('(f) reconciler disables only drained, aged reverted flows and cancels nothing', async () => {
    const flowId = 'ffffffff-0000-4000-8000-000000000001';
    const conversionId = 'cccccccc-0000-4000-8000-0000000000f1';
    h.responses.set("fac.state = 'reverted'", [
      { id: flowId, org_id: 'cccccccc-0000-4000-8000-000000000001', partner_id: null, name: 'Moved Job', conversion_id: conversionId } as unknown as { id: string },
    ]);
    const summary = await reconcileFlowRuns();
    expect(summary.disabledRevertedFlows).toBe(1);

    const q = h.queries.find((s) => s.includes("fac.state = 'reverted'"))!;
    // One statement: the flow alone flips, with no publication and no pause reason.
    expect(q.trim()).toMatch(/^WITH drained AS/);
    expect(q).toContain("SET status = 'disabled', enabled_publication_seq = NULL, paused_reason = NULL");
    expect(q).toContain("f.status IN ('enabled', 'paused')");
    expect(q).toContain(`fac.revert_at < now() - interval '${LEGACY_DRAIN_MIN_MS} milliseconds'`);
    // Drained: no non-terminal run, no open intent of any of its runs.
    expect(q).toMatch(/NOT EXISTS \( ?SELECT 1 FROM flow_runs r WHERE r\.flow_id = f\.id AND r\.status NOT IN \(/);
    for (const status of TERMINAL_FLOW_RUN_STATUSES) expect(q).toContain(`'${status}'`);
    expect(q).toContain("i.status NOT IN ('completed', 'failed', 'rejected', 'expired', 'cancelled')");
    expect(q).toContain('LIMIT 500 FOR UPDATE OF f SKIP LOCKED');
    // Cancels nothing: no run, intent or step is written.
    expect(h.queries.some((s) => /UPDATE (flow_runs|action_intents|flow_run_steps)/.test(s))).toBe(false);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'flow.disable', resourceType: 'flow', resourceId: flowId, actorType: 'system',
      details: { reason: 'flow_conversion_reverted_drained', conversionId },
    }));
  });

  it('(f) a failing drain statement is collected like any clause', async () => {
    h.failOn.set("fac.state = 'reverted'", new Error('lock timeout'));
    h.responses.set("status = 'queued'", [{ id: id(1) }]);
    const err = await reconcileFlowRuns().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FlowRunReconcileError);
    expect(h.enqueue).toHaveBeenCalledWith(id(1));
    expect(h.capture).toHaveBeenCalledWith(expect.any(Error), undefined, { flow_site: 'reconciler.reverted_flows' }, { fingerprint: ['flow', 'reconciler.reverted_flows'] });
  });

  it('every clause is bounded', () => {
    expect(FLOW_RUN_RECONCILE_LIMIT).toBe(500);
  });
});
