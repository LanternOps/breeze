import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/bullmqQueue', () => ({ createInstrumentedQueue: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/unifi/unifiTelemetryService', () => ({ reconcileTelemetry: vi.fn(async () => ({})) }));
vi.mock('../services/unifi/unifiCollectorService', () => ({
  getCollectorOwnerDeviceId: vi.fn(),
  markCollectorPoll: vi.fn(async () => undefined),
}));

import { processIngest } from './unifiTelemetryWorker';
import * as telemetrySvc from '../services/unifi/unifiTelemetryService';
import * as collectorSvc from '../services/unifi/unifiCollectorService';

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
