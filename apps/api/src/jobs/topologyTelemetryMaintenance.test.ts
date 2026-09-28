import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), maintain: vi.fn(), rollup: vi.fn(), capture: vi.fn(), contexts: [] as number[], nextContext: 0 }));
vi.mock('../db', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const context = new AsyncLocalStorage<number>();
  return {
    db: {
      execute: (...args: unknown[]) => { mocks.contexts.push(context.getStore() ?? -1); return mocks.execute(...args); },
      transaction: (fn: () => Promise<unknown>) => fn(),
    },
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => context.run(++mocks.nextContext, fn),
    runOutsideDbContext: (fn: () => unknown) => context.exit(fn),
  };
});
vi.mock('../services/topology/interfaceRetention', () => ({ maintainTopologyInterfacePartitions: mocks.maintain }));
vi.mock('../services/topology/interfaceRollups', () => ({ rollupTopologyInterfaceSource: mocks.rollup }));
vi.mock('../services/sentry', () => ({ captureException: mocks.capture }));
import {
  initializeTopologyTelemetryMaintenanceWorker, runTopologyTelemetryMaintenanceTick, shutdownTopologyTelemetryMaintenanceWorker,
  TOPOLOGY_TELEMETRY_MAINTENANCE_INTERVAL_MS,
} from './topologyTelemetryMaintenance';

const sources = [{ id: '00000000-0000-4000-8000-000000000001' }, { id: '00000000-0000-4000-8000-000000000002' }];
beforeEach(() => {
  vi.clearAllMocks(); mocks.contexts.length = 0; mocks.nextContext = 0;
  mocks.execute.mockResolvedValue(sources);
  mocks.maintain.mockResolvedValue({ created: 1, dropped: 2, deleted: 3, backlog: 0, incomplete: false });
  mocks.rollup.mockResolvedValue({ fiveMinute: 2, hourly: 1, busy: false });
});
afterEach(async () => { await shutdownTopologyTelemetryMaintenanceWorker(); vi.useRealTimers(); });

describe('topology telemetry maintenance worker', () => {
  it('maintains partitions, then rolls up each dirty source in its own system context', async () => {
    const now = new Date('2026-11-10T12:00:00Z');
    const result = await runTopologyTelemetryMaintenanceTick(now);
    expect(mocks.maintain).toHaveBeenCalledWith(now);
    expect(mocks.rollup.mock.calls.map(call => call[0])).toEqual(sources.map(s => s.id));
    expect(result).toEqual({ created: 1, dropped: 2, deleted: 3, backlog: 0, fiveMinute: 4, hourly: 2, busy: 0, failed: 0, incomplete: false });
    expect(mocks.contexts.every(id => id > 0)).toBe(true);
    expect(mocks.nextContext).toBe(4); // partitions + candidate query + one per source
  });

  it('keeps going when one source fails and reports it as incomplete', async () => {
    mocks.rollup.mockRejectedValueOnce(new Error('boom'));
    const result = await runTopologyTelemetryMaintenanceTick(new Date());
    expect(mocks.rollup).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ failed: 1, incomplete: true, fiveMinute: 2 });
  });

  it('still rolls up when partition maintenance fails, and reports busy sources', async () => {
    mocks.maintain.mockRejectedValueOnce(new Error('ddl'));
    mocks.rollup.mockResolvedValue({ fiveMinute: 0, hourly: 0, busy: true });
    const result = await runTopologyTelemetryMaintenanceTick(new Date());
    expect(result).toMatchObject({ busy: 2, incomplete: true });
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it('coalesces ticks and waits for the in-flight tick on shutdown', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    mocks.maintain.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ created: 0, dropped: 0, deleted: 0, backlog: 0, incomplete: false }); }));
    initializeTopologyTelemetryMaintenanceWorker(); initializeTopologyTelemetryMaintenanceWorker();
    await vi.advanceTimersByTimeAsync(TOPOLOGY_TELEMETRY_MAINTENANCE_INTERVAL_MS * 2);
    expect(mocks.maintain).toHaveBeenCalledOnce();
    let stopped = false; const stopping = shutdownTopologyTelemetryMaintenanceWorker().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    finish(); await stopping; expect(stopped).toBe(true);
  });
});
