import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: { inserted: [] as unknown[], setPayloads: [] as Record<string, unknown>[], updates: [] as unknown[] },
}));

vi.mock('../../../db', () => ({
  db: {
    insert: () => ({
      values: (rows: unknown[]) => {
        dbMocks.inserted.push(...rows);
        return { onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
          dbMocks.setPayloads.push(cfg.set);
          return Promise.resolve();
        } };
      },
    }),
    update: () => ({ set: () => ({ where: () => { dbMocks.updates.push(true); return Promise.resolve(); } }) }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { persistIntuneDevices } from './intuneDevices';

const ctx = (existing: Array<[string, { coreHash: string; isStale: boolean }]> = []) => ({
  orgId: 'org-1', tenantId: 'tenant-1', connectionId: 'conn-1', generation: 2,
  existing: new Map(existing), now: new Date('2026-09-08T00:00:00.000Z'),
});
const device = (over = {}) => ({
  id: 'd1', deviceName: 'LAPTOP-1', operatingSystem: 'Windows', osVersion: '10.0.22631',
  complianceState: 'compliant', lastSyncDateTime: '2026-09-08T00:00:00Z',
  userPrincipalName: 'a@x.test', managedDeviceOwnerType: 'company',
  enrolledDateTime: '2025-01-01T00:00:00Z', model: 'X1', manufacturer: 'Lenovo',
  serialNumber: 'SN-1', azureADDeviceId: 'aad-1', managementAgent: 'mdm', jailBroken: 'False',
  ...over,
});
const okResult = (items: unknown[], over = {}) => ({
  success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
  truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { managedDevices: 'ok' as const }, ...over,
});

describe('persistIntuneDevices', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.inserted = []; dbMocks.setPayloads = []; dbMocks.updates = []; });

  it('NEVER writes breeze_device_id — link reconciliation is W05 (spec §5.6)', async () => {
    await persistIntuneDevices(ctx(), okResult([device()]));
    expect(dbMocks.inserted[0]).not.toHaveProperty('breezeDeviceId');
    expect(dbMocks.setPayloads[0]).not.toHaveProperty('breezeDeviceId');
  });

  it('projects every Graph field the table carries', async () => {
    await persistIntuneDevices(ctx(), okResult([device()]));
    expect(dbMocks.inserted[0]).toMatchObject({
      orgId: 'org-1', graphId: 'd1', deviceName: 'LAPTOP-1', operatingSystem: 'Windows',
      osVersion: '10.0.22631', complianceState: 'compliant', userPrincipalName: 'a@x.test',
      ownerType: 'company', model: 'X1', manufacturer: 'Lenovo', serialNumber: 'SN-1',
      azureAdDeviceId: 'aad-1', managementAgent: 'mdm', jailBroken: 'False',
    });
  });

  it('includes lastSyncDateTime in the hash — these rows churn by design', async () => {
    await persistIntuneDevices(ctx(), okResult([device()]));
    const a = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    await persistIntuneDevices(ctx(), okResult([device({ lastSyncDateTime: '2026-09-09T00:00:00Z' })]));
    expect((dbMocks.inserted[0] as { coreHash: string }).coreHash).not.toBe(a);
  });

  it('buckets compliance states into the five rollup counters', async () => {
    const out = await persistIntuneDevices(ctx(), okResult([
      device({ id: 'a', complianceState: 'compliant' }),
      device({ id: 'b', complianceState: 'noncompliant' }),
      device({ id: 'c', complianceState: 'conflict' }),
      device({ id: 'd', complianceState: 'error' }),
      device({ id: 'e', complianceState: 'inGracePeriod' }),
      device({ id: 'f', complianceState: 'unknown' }),
      device({ id: 'g', complianceState: 'configManager' }),
      device({ id: 'h', complianceState: null }),
    ]));
    expect(out.counts).toEqual({
      devices_total: 8, devices_compliant: 1, devices_noncompliant: 3,
      devices_in_grace: 1, devices_unknown: 3,
    });
  });

  it('is case-insensitive about the compliance state Graph returns', async () => {
    const out = await persistIntuneDevices(ctx(), okResult([device({ complianceState: 'Compliant' })]));
    expect(out.counts.devices_compliant).toBe(1);
  });

  it('stores the raw Graph compliance string, not the bucket', async () => {
    await persistIntuneDevices(ctx(), okResult([device({ complianceState: 'inGracePeriod' })]));
    expect(dbMocks.inserted[0]).toMatchObject({ complianceState: 'inGracePeriod' });
  });

  it('writes nothing on an identical second run', async () => {
    await persistIntuneDevices(ctx(), okResult([device()]));
    const hash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistIntuneDevices(ctx([['d1', { coreHash: hash, isStale: false }]]), okResult([device()]));
    expect(dbMocks.inserted).toEqual([]);
    expect(out.unchanged).toBe(1);
  });

  it('does not mark stale when managedDevices did not return ok', async () => {
    const out = await persistIntuneDevices(
      ctx([['gone', { coreHash: 'h', isStale: false }]]),
      okResult([device()], { sources: { managedDevices: 'permission_missing' } }),
    );
    expect(out.complete).toBe(false);
    expect(out.stale).toBe(0);
  });
});
