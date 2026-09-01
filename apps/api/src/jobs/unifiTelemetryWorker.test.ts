import { beforeEach, describe, expect, it, vi } from 'vitest';

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
