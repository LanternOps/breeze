import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// #5351 — GET /devices/:id/hardware returns the per-slot memory modules
// (ordered by slot_index) alongside the hardware row that carries the
// memory_* summary columns. The org/site authorization chokepoint is mocked
// at the helper boundary; core.permissions.test.ts covers the RBAC gate.

const m = vi.hoisted(() => ({
  select: vi.fn(),
  deviceCheck: vi.fn(),
  builders: [] as any[],
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: m.select },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'], canAccessOrg: () => true });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  SITE_ACCESS_DENIED: Symbol.for('test-site-denied'),
  getDeviceWithOrgAndSiteCheck: m.deviceCheck,
}));

import { hardwareRoutes } from './hardware';
import { SITE_ACCESS_DENIED } from './helpers';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

/** A chainable, awaitable Drizzle query stand-in resolving to `rows`. */
function query(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const builder: any = {
    from: vi.fn(() => builder), where: vi.fn(() => builder), orderBy: vi.fn(() => builder),
    limit: vi.fn(() => builder), then: promise.then.bind(promise),
  };
  m.builders.push(builder);
  return builder;
}

const HARDWARE = {
  deviceId: DEVICE_ID, orgId: 'org-1', ramTotalMb: 32768,
  memorySlotsTotal: 4, memoryMaxCapacityMb: 131072, memorySoldered: false,
  memoryObservedAt: '2026-09-26T00:00:00.000Z',
};
const MODULES = [
  { id: 'm1', slotKey: 'smbios:0x1100', slotIndex: 0, locator: 'DIMM_A1', populated: true, capacityMb: 16384 },
  { id: 'm2', slotKey: 'smbios:0x1101', slotIndex: 1, locator: 'DIMM_A2', populated: false, capacityMb: null },
];

function app() {
  return new Hono().route('/devices', hardwareRoutes);
}

describe('GET /devices/:id/hardware memory modules (#5351)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.builders.length = 0;
  });

  it('returns memoryModules ordered by slot_index next to the hardware memory summary', async () => {
    m.deviceCheck.mockResolvedValue({ id: DEVICE_ID, orgId: 'org-1' });
    const byTable: Record<string, unknown[]> = {
      device_hardware: [HARDWARE], device_disks: [], device_network: [], device_memory_modules: MODULES,
    };
    m.select.mockImplementation(() => {
      const builder = query([]);
      builder.from = vi.fn((table: any) => {
        const name = table[Symbol.for('drizzle:Name')] as string;
        const rows = byTable[name] ?? [];
        const promise = Promise.resolve(rows);
        builder.then = promise.then.bind(promise);
        builder.table = name;
        return builder;
      });
      return builder;
    });

    const res = await app().request(`/devices/${DEVICE_ID}/hardware`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hardware).toMatchObject({ memorySlotsTotal: 4, memoryMaxCapacityMb: 131072, memorySoldered: false });
    expect(body.memoryModules).toEqual(MODULES);

    const memoryQuery = m.builders.find((b: any) => b.table === 'device_memory_modules')!;
    expect(memoryQuery).toBeDefined();
    const orderBy = memoryQuery.orderBy.mock.calls[0]!.map((part: unknown) =>
      new PgDialect().sqlToQuery(part as SQL).sql);
    expect(orderBy[0]).toContain('"slot_index"');
    const where = new PgDialect().sqlToQuery(memoryQuery.where.mock.calls[0]![0] as SQL);
    expect(where.sql).toContain('"device_memory_modules"."device_id"');
    expect(where.params).toEqual([DEVICE_ID]);
  });

  it('returns an empty memoryModules list for a device that has not reported memory yet', async () => {
    m.deviceCheck.mockResolvedValue({ id: DEVICE_ID, orgId: 'org-1' });
    m.select.mockImplementation(() => query([]));

    const body = await (await app().request(`/devices/${DEVICE_ID}/hardware`)).json();

    expect(body).toMatchObject({ hardware: null, memoryModules: [] });
  });

  it('404s for a device outside the caller org and reads no inventory', async () => {
    m.deviceCheck.mockResolvedValue(null);
    const res = await app().request(`/devices/${DEVICE_ID}/hardware`);
    expect(res.status).toBe(404);
    expect(m.select).not.toHaveBeenCalled();
  });

  it('403s for a device on a site the caller cannot access and reads no inventory', async () => {
    m.deviceCheck.mockResolvedValue(SITE_ACCESS_DENIED);
    const res = await app().request(`/devices/${DEVICE_ID}/hardware`);
    expect(res.status).toBe(403);
    expect(m.select).not.toHaveBeenCalled();
  });
});
