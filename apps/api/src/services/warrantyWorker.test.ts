import { beforeEach, describe, expect, it, vi } from 'vitest';

// #10403 — the sweep job's wiring: the page is selected in its own context,
// the batch runs OUTSIDE it (one transaction per subject), and a page on which
// every subject failed fails the job so BullMQ's failed-job reporting fires.

const state = vi.hoisted(() => ({ contextDepth: 0, depthAtBatch: -1 }));

vi.mock('../db', () => ({
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    state.contextDepth += 1;
    try {
      return await fn();
    } finally {
      state.contextDepth -= 1;
    }
  },
}));
vi.mock('./redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./bullmqQueue', () => ({ createInstrumentedQueue: vi.fn() }));
vi.mock('../jobs/scheduleRegistry', () => ({ jobSchedule: vi.fn() }));
vi.mock('../jobs/workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

const getDevicesNeedingWarrantySyncMock = vi.fn();
const syncWarrantyBatchMock = vi.fn();
vi.mock('./warrantySync', () => ({
  syncWarrantyForDevice: vi.fn(),
  getDevicesNeedingWarrantySync: (...args: unknown[]) => getDevicesNeedingWarrantySyncMock(...args),
  syncWarrantyBatch: (...args: unknown[]) => {
    state.depthAtBatch = state.contextDepth;
    return syncWarrantyBatchMock(...args);
  },
}));

import { processWarrantyJob } from './warrantyWorker';

const page = [
  { kind: 'device', deviceId: 'd1' },
  { kind: 'manualAsset', manualAssetId: 'm2' },
];

describe('processWarrantyJob sync-batch (#10403)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.contextDepth = 0;
    state.depthAtBatch = -1;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('selects inside a context but runs the batch outside it', async () => {
    getDevicesNeedingWarrantySyncMock.mockImplementation(async () => {
      expect(state.contextDepth).toBe(1);
      return page;
    });
    syncWarrantyBatchMock.mockResolvedValue({ synced: 2, failed: 0 });

    await expect(processWarrantyJob({ type: 'sync-batch' })).resolves.toEqual({ synced: 2, failed: 0 });
    expect(state.depthAtBatch).toBe(0);
  });

  it('completes with counts when only some subjects failed', async () => {
    getDevicesNeedingWarrantySyncMock.mockResolvedValue(page);
    syncWarrantyBatchMock.mockResolvedValue({ synced: 1, failed: 1 });

    await expect(processWarrantyJob({ type: 'sync-batch' })).resolves.toEqual({ synced: 1, failed: 1 });
  });

  it('fails the job when every subject on the page failed', async () => {
    getDevicesNeedingWarrantySyncMock.mockResolvedValue(page);
    syncWarrantyBatchMock.mockResolvedValue({ synced: 0, failed: 2 });

    await expect(processWarrantyJob({ type: 'sync-batch' })).rejects.toThrow(/all 2 subjects failed/);
  });

  it('returns zero counts on an empty page without calling the batch', async () => {
    getDevicesNeedingWarrantySyncMock.mockResolvedValue([]);

    await expect(processWarrantyJob({ type: 'sync-batch' })).resolves.toEqual({ synced: 0, failed: 0 });
    expect(syncWarrantyBatchMock).not.toHaveBeenCalled();
  });
});
