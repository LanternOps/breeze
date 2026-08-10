import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3201: a VM reports a synthetic serial and a vendor-ish manufacturer, so it
// clears the serial/manufacturer filters and gets submitted to a vendor
// warranty API that has never heard of it — burnt quota, permanent 'unknown'.
// The observable guarantee is that no provider is ever consulted for a VM.

const selectMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    // Only reached on the physical-device path, which runs past the guards.
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve(undefined) }),
    }),
  },
}));

vi.mock('../db/schema', () => ({
  deviceWarranty: { id: 'deviceWarranty.id', deviceId: 'deviceWarranty.deviceId', nextSyncAt: 'deviceWarranty.nextSyncAt' },
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
}));

const getProviderForManufacturerMock = vi.fn();
vi.mock('./warrantyProviders', () => ({
  getProviderForManufacturer: (...args: unknown[]) => getProviderForManufacturerMock(...args),
  normalizeManufacturer: (m: string) => m.toLowerCase(),
}));

vi.mock('./warrantyAlertEvaluator', () => ({
  evaluateWarrantyAlerts: vi.fn().mockResolvedValue(null),
}));

import { syncWarrantyForDevice } from './warrantySync';

const DEVICE_ID = '44444444-4444-4444-4444-444444444444';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

/**
 * syncWarrantyForDevice runs two identically shaped reads —
 * `.select().from().where().limit()` — first the hardware row, then the device
 * row. Queue their results in that order.
 */
function queueReads(...results: unknown[][]) {
  const queue = [...results];
  selectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(queue.shift() ?? []),
      }),
    }),
  }));
}

const VM_HARDWARE = [{
  serialNumber: 'VMware-42 0f 1a',   // synthetic, but non-null: clears the filter
  manufacturer: 'VMware, Inc.',      // vendor-ish, so normalizeManufacturer resolves
  model: 'VMware Virtual Platform',
}];

const PHYSICAL_HARDWARE = [{
  serialNumber: 'ABC1234',
  manufacturer: 'Dell Inc.',
  model: 'Latitude 7420',
}];

describe('syncWarrantyForDevice — virtual machine exclusion (#3201)', () => {
  beforeEach(() => {
    selectMock.mockReset();
    getProviderForManufacturerMock.mockReset();
    getProviderForManufacturerMock.mockReturnValue(undefined);
  });

  it('never consults a vendor provider for a virtual machine', async () => {
    queueReads(VM_HARDWARE, [{ orgId: ORG_ID, isEphemeral: false, isVirtual: true }]);

    await syncWarrantyForDevice(DEVICE_ID);

    expect(getProviderForManufacturerMock).not.toHaveBeenCalled();
  });

  it('still consults a provider for a physical device', async () => {
    queueReads(PHYSICAL_HARDWARE, [{ orgId: ORG_ID, isEphemeral: false, isVirtual: false }]);

    await syncWarrantyForDevice(DEVICE_ID);

    expect(getProviderForManufacturerMock).toHaveBeenCalledWith('Dell Inc.');
  });

  it('still excludes ephemeral Quick Support devices', async () => {
    queueReads(PHYSICAL_HARDWARE, [{ orgId: ORG_ID, isEphemeral: true, isVirtual: false }]);

    await syncWarrantyForDevice(DEVICE_ID);

    expect(getProviderForManufacturerMock).not.toHaveBeenCalled();
  });

  it('excludes a device that is both ephemeral and virtual', async () => {
    queueReads(VM_HARDWARE, [{ orgId: ORG_ID, isEphemeral: true, isVirtual: true }]);

    await syncWarrantyForDevice(DEVICE_ID);

    expect(getProviderForManufacturerMock).not.toHaveBeenCalled();
  });
});
