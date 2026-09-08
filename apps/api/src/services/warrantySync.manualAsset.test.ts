import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #4622 W03 — `device_warranty` gained an XOR subject, so the provider tail of
 * the warranty sync is now subject-agnostic. These tests pin the two things a
 * refactor of that shape can silently break: which conflict target the upsert
 * writes against, and which subjects the fleet sweep is willing to pick up.
 *
 * The 23514 XOR proof lives in
 * `src/__tests__/integration/deviceWarrantyManualSubject.integration.test.ts` —
 * a CHECK constraint cannot be proven against a mocked db.
 */
const insertMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...args),
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

vi.mock('../db/schema', () => ({
  deviceWarranty: {
    id: 'deviceWarranty.id',
    deviceId: 'deviceWarranty.deviceId',
    manualAssetId: 'deviceWarranty.manualAssetId',
    nextSyncAt: 'deviceWarranty.nextSyncAt',
    dataSource: 'deviceWarranty.dataSource',
    status: 'deviceWarranty.status',
  },
  deviceHardware: {
    deviceId: 'deviceHardware.deviceId',
    serialNumber: 'deviceHardware.serialNumber',
    manufacturer: 'deviceHardware.manufacturer',
    model: 'deviceHardware.model',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    isEphemeral: 'devices.isEphemeral',
    isVirtual: 'devices.isVirtual',
  },
  manualAssets: {
    id: 'manualAssets.id',
    orgId: 'manualAssets.orgId',
    manufacturer: 'manualAssets.manufacturer',
    serialNumber: 'manualAssets.serialNumber',
    retiredAt: 'manualAssets.retiredAt',
  },
}));

const providerMock = vi.fn();
vi.mock('./warrantyProviders', () => ({
  getProviderForManufacturer: (...args: unknown[]) => providerMock(...args),
  normalizeManufacturer: (m: string) => m.toLowerCase(),
}));

const evaluateWarrantyAlertsMock = vi.fn().mockResolvedValue(null);
vi.mock('./warrantyAlertEvaluator', () => ({
  evaluateWarrantyAlerts: (...args: unknown[]) => evaluateWarrantyAlertsMock(...args),
}));

import {
  syncWarrantyForSubject,
  syncWarrantyForManualAsset,
  getDevicesNeedingWarrantySync,
} from './warrantySync';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const MANUAL_ASSET_ID = '55555555-5555-4555-8555-555555555555';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

function captureUpsert() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  insertMock.mockReturnValue({ values });
  return { values, onConflictDoUpdate };
}

/** Each terminal await on a db.select() chain shifts one canned result set. */
function queueReads(...results: unknown[][]) {
  const queue = [...results];
  selectMock.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    const next = () => Promise.resolve(queue.shift() ?? []);
    for (const method of ['from', 'leftJoin', 'innerJoin', 'where', 'orderBy']) {
      chain[method] = () => chain;
    }
    chain.limit = next;
    // Some arms terminate on .orderBy(...).limit(...); others are awaited
    // straight off .where(...). Make the chain thenable so both work.
    (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
      next().then(resolve);
    return chain;
  });
}

describe('syncWarrantyForSubject — manual-asset subject (#4622)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMock.mockReset();
    selectMock.mockReset();
  });

  it('upserts against the manual_asset_id conflict target, never device_id', async () => {
    const { values, onConflictDoUpdate } = captureUpsert();
    providerMock.mockReturnValue({
      lookup: vi.fn().mockResolvedValue(
        new Map([
          [
            'SN-MANUAL-1',
            {
              found: true,
              entitlements: [],
              warrantyStartDate: '2024-01-01',
              warrantyEndDate: '2099-01-01',
            },
          ],
        ]),
      ),
    });

    await syncWarrantyForSubject({
      orgId: ORG_ID,
      manufacturer: 'Dell Inc.',
      serialNumber: 'SN-MANUAL-1',
      subject: { kind: 'manualAsset', manualAssetId: MANUAL_ASSET_ID },
    });

    expect(providerMock).toHaveBeenCalledWith('Dell Inc.');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        manualAssetId: MANUAL_ASSET_ID,
        deviceId: null,
        orgId: ORG_ID,
        status: 'active',
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'deviceWarranty.manualAssetId' }),
    );
  });

  it('upserts against the device_id conflict target for a device subject', async () => {
    const { values, onConflictDoUpdate } = captureUpsert();
    providerMock.mockReturnValue({
      lookup: vi.fn().mockResolvedValue(new Map()),
    });

    await syncWarrantyForSubject({
      orgId: ORG_ID,
      manufacturer: 'Dell Inc.',
      serialNumber: 'SN-DEVICE-1',
      subject: { kind: 'device', deviceId: DEVICE_ID },
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: DEVICE_ID, manualAssetId: null }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'deviceWarranty.deviceId' }),
    );
  });

  it('never evaluates warranty alerts for a manual asset (display-only in v1)', async () => {
    captureUpsert();
    providerMock.mockReturnValue({ lookup: vi.fn().mockResolvedValue(new Map()) });

    await syncWarrantyForSubject({
      orgId: ORG_ID,
      manufacturer: 'Dell Inc.',
      serialNumber: 'SN-MANUAL-2',
      subject: { kind: 'manualAsset', manualAssetId: MANUAL_ASSET_ID },
    });

    expect(evaluateWarrantyAlertsMock).not.toHaveBeenCalled();
  });

  it('skips a manual asset with no manufacturer or no serial', async () => {
    captureUpsert();
    queueReads([{ orgId: ORG_ID, manufacturer: null, serialNumber: 'SN-X' }]);

    await syncWarrantyForManualAsset(MANUAL_ASSET_ID);

    expect(providerMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('syncs a manual asset that has both manufacturer and serial', async () => {
    const { values } = captureUpsert();
    providerMock.mockReturnValue({ lookup: vi.fn().mockResolvedValue(new Map()) });
    queueReads([{ orgId: ORG_ID, manufacturer: 'Lenovo', serialNumber: 'SN-Y' }]);

    await syncWarrantyForManualAsset(MANUAL_ASSET_ID);

    expect(providerMock).toHaveBeenCalledWith('Lenovo');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ manualAssetId: MANUAL_ASSET_ID, deviceId: null }),
    );
  });
});

describe('getDevicesNeedingWarrantySync — subject-tagged sweep (#4622)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
  });

  it('returns both device and manual-asset subjects, tagged by kind', async () => {
    queueReads(
      [{ deviceId: DEVICE_ID, nextSyncAt: new Date('2026-01-02T00:00:00Z') }],
      [{ manualAssetId: MANUAL_ASSET_ID, nextSyncAt: new Date('2026-01-01T00:00:00Z') }],
    );

    const subjects = await getDevicesNeedingWarrantySync(50);

    // Ordered by due-ness across both arms — the manual asset is due first.
    expect(subjects).toEqual([
      { kind: 'manualAsset', manualAssetId: MANUAL_ASSET_ID },
      { kind: 'device', deviceId: DEVICE_ID },
    ]);
  });

  it('honours the limit across the merged arms, not per arm', async () => {
    queueReads(
      [
        { deviceId: DEVICE_ID, nextSyncAt: new Date('2026-01-03T00:00:00Z') },
        {
          deviceId: '66666666-6666-4666-8666-666666666666',
          nextSyncAt: new Date('2026-01-04T00:00:00Z'),
        },
      ],
      [{ manualAssetId: MANUAL_ASSET_ID, nextSyncAt: new Date('2026-01-01T00:00:00Z') }],
    );

    const subjects = await getDevicesNeedingWarrantySync(2);

    expect(subjects).toHaveLength(2);
    expect(subjects[0]).toEqual({ kind: 'manualAsset', manualAssetId: MANUAL_ASSET_ID });
  });
});
