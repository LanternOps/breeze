import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), reconcile: vi.fn(), flags: vi.fn(), capture: vi.fn() }));
vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => mocks.execute(...args) },
  assertInTransaction: vi.fn(),
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/topology/reconcile', () => ({ reconcileTopologySite: mocks.reconcile }));
vi.mock('../services/topology/flags', () => ({ loadTopologyFlags: mocks.flags }));
vi.mock('../services/sentry', () => ({ captureException: mocks.capture }));
vi.mock('../services/topology/physicalAuthorities', () => ({ registerTopologyPhysicalAuthorities: vi.fn() }));
import { runTopologyReconcileTick, shutdownTopologyReconcileWorker } from './topologyReconcileWorker';
const site = { org_id: '00000000-0000-4000-8000-000000000001', site_id: '00000000-0000-4000-8000-000000000002' };

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  mocks.execute.mockResolvedValue([site]); mocks.flags.mockResolvedValue({ materialization: true }); mocks.reconcile.mockResolvedValue({ published: true, graphRevision: '1' });
});
afterEach(async () => { await shutdownTopologyReconcileWorker(); vi.useRealTimers(); });

describe('topology reconcile worker failure backoff (BREEZE-4B)', () => {
  it('backs a permanently failing site off instead of reconciling it every tick', async () => {
    mocks.reconcile.mockRejectedValue(new Error('Conflicting pins stop canonical merge'));
    await runTopologyReconcileTick();
    await runTopologyReconcileTick();
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    await runTopologyReconcileTick();
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), undefined, { worker: 'topologyReconcile' });
  });

  it('rotates the failed site to the back of the queue outside the rolled-back transaction', async () => {
    mocks.reconcile.mockRejectedValue(new Error('boom'));
    await runTopologyReconcileTick();
    // candidate query, in-transaction rotation (rolled back), then the durable rotation.
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });

  it('reconciles a site every tick while it keeps succeeding', async () => {
    await runTopologyReconcileTick();
    await runTopologyReconcileTick();
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  });
});
