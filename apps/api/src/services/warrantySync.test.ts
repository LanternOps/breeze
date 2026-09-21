import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// Verify upsertAgentWarranty maps agent-reported coverage kind to the right
// persisted status / is_subscription flag without a live DB (#1320).
const insertMock = vi.fn();
const selectMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...args),
    select: (...args: unknown[]) => selectMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock('../db/schema', () => ({
  deviceWarranty: { deviceId: 'deviceWarranty.deviceId' },
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
    purchaseDateSource: 'devices.purchaseDateSource',
  },
  manualAssets: {
    id: 'manualAssets.id',
    purchaseDateSource: 'manualAssets.purchaseDateSource',
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

import { syncWarrantyForDevice, syncWarrantyForSubject, upsertAgentWarranty } from './warrantySync';

const DEVICE_ID = '44444444-4444-4444-4444-444444444444';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

/** Capture the values passed to db.insert().values(...).onConflictDoUpdate(...). */
function captureUpsert() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  insertMock.mockReturnValue({ values });
  return { values, onConflictDoUpdate };
}

/** Capture db.update(table).set(...).where(...). */
function captureUpdate() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  updateMock.mockReturnValue({ set });
  return { set, where };
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Compile a captured drizzle `where(...)` condition (SQL text + bound
 *  params) so a test can assert on the actual guard, not just that `where`
 *  was called. The mocked schema (above) binds column refs as plain strings,
 *  so `sql`${col} IS DISTINCT FROM 'manual'`` compiles the column reference
 *  itself into `params`, while the operator and literal ride in `sql`. */
function compileWhere(condition: unknown): { sql: string; params: unknown[] } {
  const dialect = new PgDialect();
  return dialect.sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]);
}

describe('upsertAgentWarranty coverage-kind mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records an active subscription as subscription_active + is_subscription=true', async () => {
    const { values, onConflictDoUpdate } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'ABC123',
      coverageEndDate: inDays(28), // rolling renewal date, would otherwise read "expiring"
      coverageStartDate: inDays(-100),
      coverageType: 'AppleCare+',
      coverageKind: 'subscription',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'subscription_active', isSubscription: true })
    );
    // onConflictDoUpdate carries the same status/flag
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ status: 'subscription_active', isSubscription: true }) })
    );
  });

  it('records fixed-term coverage with a computed status + is_subscription=false', async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'XYZ789',
      coverageEndDate: inDays(400), // well in the future ⇒ active
      coverageStartDate: inDays(-100),
      coverageType: 'Limited Warranty',
      coverageKind: 'fixed',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', isSubscription: false })
    );
  });

  it('defaults to fixed-term behavior when no coverage kind is reported (back-compat)', async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'XYZ789',
      coverageEndDate: inDays(10), // within warn window ⇒ expiring
      coverageStartDate: inDays(-100),
      coverageType: 'Limited Warranty',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expiring', isSubscription: false })
    );
  });

  it("treats an empty-string coverage kind as fixed-term (the value the agent actually sends for unclassified labels)", async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'XYZ789',
      coverageEndDate: inDays(10), // within warn window ⇒ expiring
      coverageStartDate: inDays(-100),
      coverageType: 'Limited Warranty',
      coverageKind: '', // timestamp-only / labelless / localized / plist fallback
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expiring', isSubscription: false })
    );
  });
});

describe('syncWarrantyForDevice — virtual machine exclusion (#3201)', () => {
  // Reuses the file-level insertMock/db mock; adds a select chain, since the
  // sync path reads hardware then the device row before touching a provider.
  function queueReads(...results: unknown[][]) {
    const queue = [...results];
    selectMock.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }) }),
    }));
  }

  const VM_HARDWARE = [{
    serialNumber: 'VMware-42 0f 1a',
    manufacturer: 'VMware, Inc.',
    model: 'VMware Virtual Platform',
  }];
  const PHYSICAL_HARDWARE = [{
    serialNumber: 'ABC1234',
    manufacturer: 'Dell Inc.',
    model: 'Latitude 7420',
  }];

  beforeEach(() => {
    selectMock.mockReset();
    providerMock.mockReset();
    providerMock.mockReturnValue(undefined);
    insertMock.mockReturnValue({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve(undefined) }),
    });
  });

  it('never consults a vendor provider for a virtual machine', async () => {
    queueReads(VM_HARDWARE, [{ orgId: ORG_ID, isEphemeral: false, isVirtual: true }]);
    await syncWarrantyForDevice(DEVICE_ID);
    expect(providerMock).not.toHaveBeenCalled();
  });

  it('still consults a provider for a physical device', async () => {
    queueReads(PHYSICAL_HARDWARE, [{ orgId: ORG_ID, isEphemeral: false, isVirtual: false }]);
    await syncWarrantyForDevice(DEVICE_ID);
    expect(providerMock).toHaveBeenCalledWith('Dell Inc.');
  });

  it('still excludes ephemeral Quick Support devices', async () => {
    queueReads(PHYSICAL_HARDWARE, [{ orgId: ORG_ID, isEphemeral: true, isVirtual: false }]);
    await syncWarrantyForDevice(DEVICE_ID);
    expect(providerMock).not.toHaveBeenCalled();
  });

  it('force: an explicit user refresh DOES sync a virtual machine', async () => {
    queueReads(VM_HARDWARE, [{ orgId: ORG_ID, isEphemeral: false, isVirtual: true }]);
    await syncWarrantyForDevice(DEVICE_ID, { force: true });
    expect(providerMock).toHaveBeenCalledWith('VMware, Inc.');
  });

  it('force does NOT bypass the ephemeral skip — that is an ownership rule', async () => {
    queueReads(PHYSICAL_HARDWARE, [{ orgId: ORG_ID, isEphemeral: true, isVirtual: false }]);
    await syncWarrantyForDevice(DEVICE_ID, { force: true });
    expect(providerMock).not.toHaveBeenCalled();
  });
});

describe('vendor ship date → purchase date (Hardware Lifecycle)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a vendor-sourced purchase date on the device when the lookup reports a ship date', async () => {
    captureUpsert();
    const { set, where } = captureUpdate();
    providerMock.mockReturnValue({
      lookup: vi.fn().mockResolvedValue(new Map([['SN1', {
        found: true, entitlements: [], warrantyStartDate: '2024-01-10', warrantyEndDate: inDays(400), shipDate: '2024-01-05',
      }]])),
    });

    await syncWarrantyForSubject({ orgId: ORG_ID, manufacturer: 'Dell', serialNumber: 'SN1', subject: { kind: 'device', deviceId: DEVICE_ID } });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ purchaseDate: '2024-01-05', purchaseDateSource: 'vendor' }));

    // The manual-value guard: a caller-typed purchase date must never be
    // silently overwritten by a vendor ship date. Deleting the guard from
    // the source's `where(...)` must fail this assertion, not just the
    // `set` shape above.
    expect(where).toHaveBeenCalledTimes(1);
    const compiled = compileWhere(where.mock.calls[0]![0]);
    expect(compiled.sql).toContain("IS DISTINCT FROM 'manual'");
    expect(compiled.params).toContain('devices.purchaseDateSource');
    expect(compiled.params).toContain(DEVICE_ID);
  });

  it('does not touch the purchase date when the vendor reports none', async () => {
    captureUpsert();
    captureUpdate();
    providerMock.mockReturnValue({
      lookup: vi.fn().mockResolvedValue(new Map([['SN1', {
        found: true, entitlements: [], warrantyStartDate: '2024-01-10', warrantyEndDate: inDays(400),
      }]])),
    });

    await syncWarrantyForSubject({ orgId: ORG_ID, manufacturer: 'Dell', serialNumber: 'SN1', subject: { kind: 'device', deviceId: DEVICE_ID } });

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('targets the manual asset row for a manual-asset subject', async () => {
    captureUpsert();
    const { set, where } = captureUpdate();
    providerMock.mockReturnValue({
      lookup: vi.fn().mockResolvedValue(new Map([['SN2', {
        found: true, entitlements: [], warrantyStartDate: null, warrantyEndDate: inDays(100), shipDate: '2023-06-01',
      }]])),
    });

    await syncWarrantyForSubject({ orgId: ORG_ID, manufacturer: 'Lenovo', serialNumber: 'SN2', subject: { kind: 'manualAsset', manualAssetId: 'ma-1' } });

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'manualAssets.id' }));
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ purchaseDate: '2023-06-01', purchaseDateSource: 'vendor' }));

    expect(where).toHaveBeenCalledTimes(1);
    const compiled = compileWhere(where.mock.calls[0]![0]);
    expect(compiled.sql).toContain("IS DISTINCT FROM 'manual'");
    expect(compiled.params).toContain('manualAssets.purchaseDateSource');
    expect(compiled.params).toContain('ma-1');
  });
});
