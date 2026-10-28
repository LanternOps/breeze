import { beforeEach, describe, expect, it, vi } from 'vitest';

// #10403 — the fleet sweep must give every subject its OWN transaction. The
// partner-export triggers on device_warranty take per-org (and per-partner)
// advisory locks whose hierarchy only holds within one org's partner, so one
// transaction spanning orgs aborts on the first cross-partner subject and
// rolls back the whole batch. Real-lock behaviour is proven in
// __tests__/integration/warrantyBatchExportLocks.integration.test.ts; this
// suite pins the transaction boundaries and per-subject failure isolation.

const state = vi.hoisted(() => ({ contextDepth: 0, contextCalls: [] as Array<string | undefined> }));
const selectMock = vi.fn();
const withSystemDbAccessContextMock = vi.fn(async (fn: () => Promise<unknown>, label?: string) => {
  state.contextCalls.push(label);
  state.contextDepth += 1;
  try {
    return await fn();
  } finally {
    state.contextDepth -= 1;
  }
});

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: vi.fn(),
    update: vi.fn(),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>, label?: string) => withSystemDbAccessContextMock(fn, label),
  hasDbAccessContext: () => state.contextDepth > 0,
}));

vi.mock('../db/schema', () => ({
  deviceWarranty: { deviceId: 'deviceWarranty.deviceId' },
  deviceHardware: {
    deviceId: 'deviceHardware.deviceId',
    serialNumber: 'deviceHardware.serialNumber',
    manufacturer: 'deviceHardware.manufacturer',
    model: 'deviceHardware.model',
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  manualAssets: {
    id: 'manualAssets.id',
    orgId: 'manualAssets.orgId',
    manufacturer: 'manualAssets.manufacturer',
    serialNumber: 'manualAssets.serialNumber',
  },
}));

vi.mock('./warrantyProviders', () => ({
  getProviderForManufacturer: vi.fn(),
  normalizeManufacturer: (m: string) => m.toLowerCase(),
}));
vi.mock('./warrantyAlertEvaluator', () => ({ evaluateWarrantyAlerts: vi.fn() }));
vi.mock('./unassignedPool/selectorPredicate', () => ({ notParkedDeviceCondition: () => 'not-parked' }));

import { syncWarrantyBatch, type WarrantySubject } from './warrantySync';

/**
 * Every subject's first statement is a `select().from().where().limit()` that
 * returns no row, so the sync logs "no serial/manufacturer" and returns. The
 * depth seen at that moment proves the statement ran inside a context.
 */
function selectReturningNothing(observedDepths: number[]) {
  selectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          observedDepths.push(state.contextDepth);
          return [];
        },
      }),
    }),
  }));
}

const subjects: WarrantySubject[] = [
  { kind: 'device', deviceId: 'device-1' },
  { kind: 'manualAsset', manualAssetId: 'asset-2' },
  { kind: 'device', deviceId: 'device-3' },
];

describe('syncWarrantyBatch — one transaction per subject (#10403)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.contextDepth = 0;
    state.contextCalls = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('opens a separate system context for every subject', async () => {
    const depths: number[] = [];
    selectReturningNothing(depths);

    const result = await syncWarrantyBatch(subjects);

    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(subjects.length);
    expect(state.contextCalls.every((label) => label === 'warrantySync.batchSubject')).toBe(true);
    // Every statement ran inside exactly one context — never nested, never bare.
    expect(depths).toHaveLength(subjects.length);
    expect(depths.every((d) => d === 1)).toBe(true);
    expect(result).toEqual({ synced: 3, failed: 0 });
  });

  it("isolates one subject's failure: later subjects still run in fresh contexts", async () => {
    const depths: number[] = [];
    let call = 0;
    selectMock.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            depths.push(state.contextDepth);
            call += 1;
            if (call === 1) throw new Error('partner export lock hierarchy violation');
            return [];
          },
        }),
      }),
    }));

    const result = await syncWarrantyBatch(subjects);

    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(subjects.length);
    expect(depths).toEqual([1, 1, 1]);
    expect(result).toEqual({ synced: 2, failed: 1 });
    expect(console.error).toHaveBeenCalledWith(
      '[WarrantySync] Batch sync error for device device-1:',
      'partner export lock hierarchy violation',
    );
  });

  it('refuses to run inside an already-open DB context (the subjects would share one transaction)', async () => {
    const depths: number[] = [];
    selectReturningNothing(depths);
    state.contextDepth = 1;

    await expect(syncWarrantyBatch(subjects)).rejects.toThrow(/own transaction/);
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    expect(depths).toHaveLength(0);
  });
});
