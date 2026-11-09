import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { workerCloseMock, workerConstructorMock, queueCloseMock, createInstrumentedQueueMock } = vi.hoisted(() => ({
  workerCloseMock: vi.fn(),
  workerConstructorMock: vi.fn(),
  queueCloseMock: vi.fn(),
  createInstrumentedQueueMock: vi.fn(() => ({ close: queueCloseMock })),
}));

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/bullmqQueue', () => ({ createInstrumentedQueue: createInstrumentedQueueMock }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('bullmq', () => ({
  Worker: class {
    close = workerCloseMock;
    on = vi.fn();
    constructor(...args: unknown[]) {
      workerConstructorMock(...args);
    }
  },
}));
vi.mock('../services/unifi/unifiTelemetryService', () => ({ reconcileTelemetry: vi.fn(async () => ({})) }));
vi.mock('../services/unifi/unifiCollectorService', () => ({
  getCollectorOwnerDeviceId: vi.fn(),
  markCollectorPoll: vi.fn(async () => undefined),
}));

import {
  processIngest,
  getUnifiTelemetryQueue,
  initializeUnifiTelemetryWorker,
  shutdownUnifiTelemetryWorker,
} from './unifiTelemetryWorker';
import * as telemetrySvc from '../services/unifi/unifiTelemetryService';
import * as collectorSvc from '../services/unifi/unifiCollectorService';
import * as dbModule from '../db';

const basePayload = {
  collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true,
  devices: [], clients: [], deviceId: 'dev-1',
};

describe('processIngest ownership gate (C1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects telemetry whose deviceId does not own the collector — no writes', async () => {
    (collectorSvc.getCollectorOwnerDeviceId as any).mockResolvedValue('dev-OTHER');
    await processIngest({ ...basePayload, deviceId: 'dev-attacker' });
    expect(telemetrySvc.reconcileTelemetry).not.toHaveBeenCalled();
    expect(collectorSvc.markCollectorPoll).not.toHaveBeenCalled();
  });

  it('rejects telemetry for an unknown collector — no writes', async () => {
    (collectorSvc.getCollectorOwnerDeviceId as any).mockResolvedValue(null);
    await processIngest(basePayload);
    expect(telemetrySvc.reconcileTelemetry).not.toHaveBeenCalled();
    expect(collectorSvc.markCollectorPoll).not.toHaveBeenCalled();
  });

  it('reconciles + marks connected when the device owns the collector', async () => {
    (collectorSvc.getCollectorOwnerDeviceId as any).mockResolvedValue('dev-1');
    await processIngest(basePayload);
    expect(telemetrySvc.reconcileTelemetry).toHaveBeenCalledWith({}, basePayload, { markStale: true });
    expect(collectorSvc.markCollectorPoll).toHaveBeenCalledWith({}, 'c1', 'connected', true, null);
  });
});

describe('processIngest status semantics (I1/I2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (collectorSvc.getCollectorOwnerDeviceId as any).mockResolvedValue('dev-1');
  });

  it('marks firmware_too_old (no reconcile) when firmwareOk is false', async () => {
    await processIngest({ ...basePayload, firmwareOk: false });
    expect(telemetrySvc.reconcileTelemetry).not.toHaveBeenCalled();
    expect(collectorSvc.markCollectorPoll).toHaveBeenCalledWith({}, 'c1', 'firmware_too_old', false, expect.any(String));
  });

  it('marks unreachable (no stale) on a poll error with no data', async () => {
    await processIngest({ ...basePayload, error: 'dial tcp: timeout' });
    expect(telemetrySvc.reconcileTelemetry).toHaveBeenCalledWith({}, expect.objectContaining({ error: 'dial tcp: timeout' }), { markStale: false });
    expect(collectorSvc.markCollectorPoll).toHaveBeenCalledWith({}, 'c1', 'unreachable', true, 'dial tcp: timeout');
  });

  it('marks error (no stale) on a partial poll that still returned devices', async () => {
    await processIngest({ ...basePayload, error: 'site s2 devices: 500', devices: [{ unifiDeviceId: 'd1' } as any] });
    expect(telemetrySvc.reconcileTelemetry).toHaveBeenCalledWith({}, expect.objectContaining({ error: 'site s2 devices: 500' }), { markStale: false });
    expect(collectorSvc.markCollectorPoll).toHaveBeenCalledWith({}, 'c1', 'error', true, 'site s2 devices: 500');
  });
});

// W04 (#11504): one structured line when a self-hosted collector skipped or
// removed records for unmapped sites, so an operator can see why inventory is
// missing and which discovered assets to review.
describe('processIngest unmapped-site log (unifi.reconcile.unmapped)', () => {
  const zero = {
    devicesUpserted: 1, devicesStaled: 0, clientsUpserted: 1, clientsStaled: 0,
    devicesSkippedUnmapped: 0, clientsSkippedUnmapped: 0, devicesSkippedNoSiteId: 0, clientsSkippedNoSiteId: 0,
    devicesRemovedUnmapped: 0, clientsRemovedUnmapped: 0, unmappedSiteIds: [] as string[], removedDiscoveredAssetIds: [] as string[],
  };
  const skipOnly = { ...zero, devicesSkippedUnmapped: 1, unmappedSiteIds: ['s2'] };
  const loggedEvents = (spy: { mock: { calls: unknown[][] } }): Array<Record<string, any>> => spy.mock.calls
    .map((args: unknown[]) => { try { return JSON.parse(String(args[0])) as Record<string, any>; } catch { return null; } })
    .filter((line): line is Record<string, any> => line?.event === 'unifi.reconcile.unmapped');
  // The throttle is keyed per collector, so each test uses its own collector id.
  const payloadFor = (collectorId: string) => ({ ...basePayload, collectorId });
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (collectorSvc.getCollectorOwnerDeviceId as any).mockResolvedValue('dev-1');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('logs every counter by reason, the unmapped site ids, and at most 50 removed discovered-asset ids', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `asset-${i}`);
    (telemetrySvc.reconcileTelemetry as any).mockResolvedValueOnce({
      ...zero, devicesSkippedUnmapped: 2, clientsSkippedUnmapped: 3, devicesSkippedNoSiteId: 5, clientsSkippedNoSiteId: 6,
      devicesRemovedUnmapped: 60, clientsRemovedUnmapped: 4, unmappedSiteIds: ['s2', 's4'], removedDiscoveredAssetIds: ids,
    });
    await processIngest(payloadFor('c-log-full'));
    const events = loggedEvents(warn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      collectorId: 'c-log-full', devicesSkippedUnmapped: 2, clientsSkippedUnmapped: 3, devicesSkippedNoSiteId: 5, clientsSkippedNoSiteId: 6,
      devicesRemovedUnmapped: 60, clientsRemovedUnmapped: 4, unmappedSiteIds: ['s2', 's4'], removedDiscoveredAssetIdCount: 60,
    });
    expect(events[0]!.removedDiscoveredAssetIds).toEqual(ids.slice(0, 50));
  });

  it('logs nothing when every counter is zero', async () => {
    (telemetrySvc.reconcileTelemetry as any).mockResolvedValueOnce(zero);
    await processIngest(payloadFor('c-log-zero'));
    expect(loggedEvents(warn)).toHaveLength(0);
  });

  it('re-logs an unchanged skip-only condition at most hourly, but logs a changed site set or a removal at once', async () => {
    const t0 = Date.parse('2026-11-08T00:00:00Z');
    const now = vi.spyOn(Date, 'now');
    try {
      const poll = async (result: object, at: number) => {
        now.mockReturnValue(at);
        (telemetrySvc.reconcileTelemetry as any).mockResolvedValueOnce(result);
        await processIngest(payloadFor('c-log-throttle'));
        return loggedEvents(warn).length;
      };
      expect(await poll(skipOnly, t0)).toBe(1);
      expect(await poll(skipOnly, t0 + 60_000)).toBe(1); // same condition, a minute later: throttled
      expect(await poll({ ...skipOnly, unmappedSiteIds: ['s2', 's5'] }, t0 + 120_000)).toBe(2); // new unmapped site
      expect(await poll({ ...skipOnly, unmappedSiteIds: ['s2', 's5'], clientsRemovedUnmapped: 1 }, t0 + 180_000)).toBe(3); // removal
      expect(await poll({ ...skipOnly, unmappedSiteIds: ['s2', 's5'] }, t0 + 180_000 + 60 * 60 * 1000)).toBe(4); // an hour on
    } finally {
      now.mockRestore();
    }
  });

  it('does not log when the reconcile transaction fails (its removals rolled back)', async () => {
    (telemetrySvc.reconcileTelemetry as any).mockResolvedValueOnce({ ...skipOnly, devicesRemovedUnmapped: 1 });
    (collectorSvc.markCollectorPoll as any).mockRejectedValueOnce(new Error('status write failed'));
    await expect(processIngest(payloadFor('c-log-rollback'))).rejects.toThrow('status write failed');
    expect(loggedEvents(warn)).toHaveLength(0);
  });
});

describe('processIngest reconcile-failure status (rollback-safe)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (collectorSvc.getCollectorOwnerDeviceId as any).mockResolvedValue('dev-1');
  });

  it('records error status in a SEPARATE context and rethrows when reconcile fails', async () => {
    (telemetrySvc.reconcileTelemetry as any).mockRejectedValueOnce(new Error('db boom'));
    await expect(processIngest(basePayload)).rejects.toThrow('db boom');
    // The collector UI must reflect the failure...
    expect(collectorSvc.markCollectorPoll).toHaveBeenCalledWith({}, 'c1', 'error', true, 'db boom');
    // ...written via a second context, because the reconcile transaction rolls
    // back on throw — an in-transaction status write would be lost.
    expect((dbModule.withSystemDbAccessContext as any).mock.calls.length).toBe(2);
  });

  it('does NOT write any status for a cross-device payload (no error-status leak to another collector)', async () => {
    (collectorSvc.getCollectorOwnerDeviceId as any).mockResolvedValue('dev-OTHER');
    (telemetrySvc.reconcileTelemetry as any).mockRejectedValueOnce(new Error('should not run'));
    await processIngest({ ...basePayload, deviceId: 'dev-attacker' });
    expect(collectorSvc.markCollectorPoll).not.toHaveBeenCalled();
  });
});

describe('shutdownUnifiTelemetryWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('closes the worker and the lazily-created queue exactly once after initialize', async () => {
    await initializeUnifiTelemetryWorker();
    // The worker only initializes its own Worker handle — the queue is
    // created lazily via getUnifiTelemetryQueue() (enqueue path). Peek it
    // here so shutdown has something to close.
    getUnifiTelemetryQueue();

    await shutdownUnifiTelemetryWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('a second shutdown call is a no-op (handles already nulled)', async () => {
    await initializeUnifiTelemetryWorker();
    getUnifiTelemetryQueue();

    await shutdownUnifiTelemetryWorker();
    await shutdownUnifiTelemetryWorker();

    expect(workerCloseMock).toHaveBeenCalledTimes(1);
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when called before initialize or queue creation', async () => {
    await expect(shutdownUnifiTelemetryWorker()).resolves.toBeUndefined();
    expect(workerCloseMock).not.toHaveBeenCalled();
    expect(queueCloseMock).not.toHaveBeenCalled();
  });

  it('closes the queue when it was created lazily via getUnifiTelemetryQueue() without ever initializing the worker', async () => {
    getUnifiTelemetryQueue();

    await shutdownUnifiTelemetryWorker();

    expect(workerCloseMock).not.toHaveBeenCalled();
    expect(queueCloseMock).toHaveBeenCalledTimes(1);
  });
});
