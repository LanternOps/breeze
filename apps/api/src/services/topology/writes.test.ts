import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), access: vi.fn(), flags: vi.fn(), drain: vi.fn(), state: vi.fn(), order: [] as string[] }));
vi.mock('../../db', () => ({ db: { select: () => ({ from: () => ({ where: mocks.state }) }) }, assertInTransaction: vi.fn(), withDbTransaction: mocks.transaction }));
vi.mock('./access', () => ({ requireTopologySiteAccess: mocks.access }));
vi.mock('./legacyImport', () => ({ drainTopologyOutbox: mocks.drain }));
vi.mock('./flags', () => ({ loadTopologyFlags: mocks.flags }));
import { drainWriteBarrier, withTopologyWrite } from './writes';
import type { TopologyRequestContext } from './access';

const ctx = { scope: { orgId: '11111111-1111-4111-8111-111111111111', siteId: '22222222-2222-4222-8222-222222222222' } } as TopologyRequestContext;
const on = { materialization: true, ui: true, physical: false, interfaceHealth: false, diagnostics: false, ai: false };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.access.mockResolvedValue(ctx);
  mocks.flags.mockImplementation(async () => { mocks.order.push('flags'); return on; });
});
describe('topology transaction conflict boundary', () => {
  it.each(['55P03', '40P01', '40001'])('returns retryable conflict only after the %s transaction rejects', async code => {
    mocks.transaction.mockRejectedValue({ cause: { code } });
    await expect(withTopologyWrite(ctx, true, async () => undefined)).rejects.toMatchObject({ code: 'topology_inventory_busy', status: 409 });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
  it('preserves unrelated SQL errors and authorization denials', async () => {
    const sqlError = { cause: { code: '23503' } };
    mocks.transaction.mockRejectedValue(sqlError);
    await expect(withTopologyWrite(ctx, true, async () => undefined)).rejects.toBe(sqlError);
    mocks.transaction.mockClear();
    const denial = new Error('denied'); mocks.access.mockRejectedValue(denial);
    await expect(withTopologyWrite(ctx, true, async () => undefined)).rejects.toBe(denial);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

// The flag read escapes to a SECOND pooled connection (partner-axis read).
// Doing it while holding topology_site_state FOR UPDATE let a UI write plus a
// same-site heartbeat burst (negotiateTopologyContext locks the same row)
// fill the pool behind the lock holder — the 2026-09-22 US deadlock shape.
describe('topology write flag resolution', () => {
  it('resolves flags before opening the locking transaction', async () => {
    mocks.transaction.mockImplementation(async () => { mocks.order.push('transaction'); throw { cause: { code: '40001' } }; });
    await expect(withTopologyWrite(ctx, true, async () => undefined)).rejects.toMatchObject({ code: 'topology_inventory_busy' });
    expect(mocks.order).toEqual(['flags', 'transaction']);
  });
  it('refuses a ready-required write with materialization off without taking any lock', async () => {
    mocks.flags.mockResolvedValue({ ...on, materialization: false });
    await expect(withTopologyWrite(ctx, true, async () => undefined)).rejects.toMatchObject({ code: 'topology_materialization_disabled', status: 409 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

// Collection ingest, aging, authority revocation and physical identity bumps
// advance dirty_revision WITHOUT an outbox row, so the legacy checkpoint's
// deliveredThrough can never reach the barrier. An empty barrier is drained.
describe('write barrier over non-outbox dirty revisions', () => {
  it('treats zero pending events through the barrier as drained', async () => {
    mocks.state.mockResolvedValue([{ dirtyRevision: 9n }]);
    mocks.drain.mockResolvedValue({ complete: false, pendingThroughBarrier: 0, deliveredThrough: '4' });
    await expect(drainWriteBarrier(ctx.scope)).resolves.toBeUndefined();
    expect(mocks.drain).toHaveBeenCalledOnce();
    expect(mocks.drain).toHaveBeenCalledWith(ctx.scope, { throughRevision: '9', batchSize: 1000 });
  });
  it('still refuses when events remain pending through the barrier', async () => {
    mocks.state.mockResolvedValue([{ dirtyRevision: 9n }]);
    mocks.drain.mockResolvedValue({ complete: false, pendingThroughBarrier: 3, deliveredThrough: '4' });
    await expect(drainWriteBarrier(ctx.scope)).rejects.toMatchObject({ code: 'topology_backlog_busy', status: 503 });
    expect(mocks.drain).toHaveBeenCalledTimes(10);
  });
});
