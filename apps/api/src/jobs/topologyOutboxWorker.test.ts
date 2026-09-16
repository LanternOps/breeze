import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), drain: vi.fn(), prune: vi.fn(), flags: vi.fn(), capture: vi.fn(), contexts: [] as number[], nextContext: 0 }));
vi.mock('../db', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const context = new AsyncLocalStorage<number>();
  return {
    db: { execute: (...args: unknown[]) => { mocks.contexts.push(context.getStore() ?? -1); return mocks.execute(...args); } },
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => context.run(++mocks.nextContext, fn),
    runOutsideDbContext: (fn: () => unknown) => context.exit(fn),
  };
});
vi.mock('../services/topology/legacyImport', () => ({ drainTopologyOutbox: mocks.drain }));
vi.mock('../services/topology/legacyRetention', () => ({ pruneDeliveredTopologyOutbox: mocks.prune }));
vi.mock('../services/topology/flags', () => ({ loadTopologyFlags: mocks.flags }));
vi.mock('../services/sentry', () => ({ captureException: mocks.capture }));
import { initializeTopologyOutboxWorker, retryableTopologyTransaction, runTopologyRepairTick, shutdownTopologyOutboxWorker } from './topologyOutboxWorker';
const site = { org_id: '00000000-0000-4000-8000-000000000001', site_id: '00000000-0000-4000-8000-000000000002', oldest: null };

beforeEach(() => {
  vi.clearAllMocks(); mocks.contexts.length = 0; mocks.nextContext = 0;
  mocks.execute.mockResolvedValue([site]); mocks.flags.mockResolvedValue({ materialization: true }); mocks.drain.mockResolvedValue({ complete: true }); mocks.prune.mockResolvedValue(0);
});
afterEach(async () => { await shutdownTopologyOutboxWorker(); vi.useRealTimers(); });
describe('topology database outbox repair worker', () => {
  it('does not materialize while disabled, while accepted events remain untouched', async () => {
    mocks.flags.mockResolvedValue({ materialization: false });
    await runTopologyRepairTick();
    expect(mocks.drain).not.toHaveBeenCalled(); expect(mocks.prune).not.toHaveBeenCalled();
  });
  it('drains a bounded site batch without contacting Redis', async () => {
    await runTopologyRepairTick();
    expect(mocks.drain).toHaveBeenCalledWith({ orgId: site.org_id, siteId: site.site_id }, { batchSize: 200 });
    expect(mocks.prune).toHaveBeenCalledOnce();
    expect(mocks.contexts.every(id => id > 0)).toBe(true);
  });
  it.each(['40P01', '40001', '55P03'])('retries %s in a fresh system transaction', async code => {
    mocks.drain.mockRejectedValueOnce({ cause: { code } });
    await runTopologyRepairTick();
    expect(mocks.drain).toHaveBeenCalledTimes(2);
    expect(mocks.nextContext).toBe(3); // candidate query + two separate drain contexts
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(retryableTopologyTransaction({ cause: { code: '40001' } })).toBe(true);
    expect(retryableTopologyTransaction({ code: '23503' })).toBe(false);
  });
  it('records a failed attempt without acknowledging its event', async () => {
    mocks.drain.mockRejectedValue(new Error('projection failed'));
    await runTopologyRepairTick();
    expect(mocks.drain).toHaveBeenCalledOnce(); expect(mocks.execute).toHaveBeenCalledTimes(3); expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.prune).not.toHaveBeenCalled();
  });
  it('coalesces ticks, does not backfill at startup and waits for in-flight shutdown', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    mocks.drain.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    initializeTopologyOutboxWorker(); initializeTopologyOutboxWorker();
    expect(mocks.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(mocks.drain).toHaveBeenCalledOnce();
    let stopped = false; const stopping = shutdownTopologyOutboxWorker().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    finish(); await stopping;
    await vi.advanceTimersByTimeAsync(6000); expect(mocks.drain).toHaveBeenCalledOnce();
  });
});
