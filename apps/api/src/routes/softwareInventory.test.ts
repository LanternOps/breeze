import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
    osVersion: 'devices.osVersion',
  },
  softwareInventory: {
    deviceId: 'softwareInventory.deviceId',
    name: 'softwareInventory.name',
    vendor: 'softwareInventory.vendor',
    version: 'softwareInventory.version',
    lastSeen: 'softwareInventory.lastSeen',
  },
  softwarePolicies: {
    id: 'softwarePolicies.id',
    orgId: 'softwarePolicies.orgId',
    name: 'softwarePolicies.name',
    mode: 'softwarePolicies.mode',
    isActive: 'softwarePolicies.isActive',
    rules: 'softwarePolicies.rules',
  },
  configurationPolicies: {
    id: 'configurationPolicies.id',
    orgId: 'configurationPolicies.orgId',
    name: 'configurationPolicies.name',
    status: 'configurationPolicies.status',
  },
  configPolicyFeatureLinks: {
    configPolicyId: 'configPolicyFeatureLinks.configPolicyId',
    featureType: 'configPolicyFeatureLinks.featureType',
    featurePolicyId: 'configPolicyFeatureLinks.featurePolicyId',
    updatedAt: 'configPolicyFeatureLinks.updatedAt',
  },
  configPolicyAssignments: {
    configPolicyId: 'configPolicyAssignments.configPolicyId',
    level: 'configPolicyAssignments.level',
    targetId: 'configPolicyAssignments.targetId',
    priority: 'configPolicyAssignments.priority',
    assignedBy: 'configPolicyAssignments.assignedBy',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === '11111111-1111-1111-1111-111111111111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

import { softwareInventoryRoutes } from './softwareInventory';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
const DEVICE_ALLOWED = '33333333-3333-3333-3333-333333333333';
const DEVICE_DENIED = '55555555-5555-5555-5555-555555555555';

function dumpSql(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return '';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '';
  seen.add(value);

  const parts: string[] = [value.constructor?.name ?? 'Object'];
  for (const key of Reflect.ownKeys(value)) {
    const prop = (value as Record<PropertyKey, unknown>)[key];
    parts.push(String(key), dumpSql(prop, seen));
  }
  return parts.join(' ');
}

function setAuth(allowedSiteIds?: string[]) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === ORG_ID,
    });
    if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
    return next();
  });
}

function mockPolicyStatusMap(rows: any[] = []) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

function mockDrilldownCount(rows: any[], whereArgs: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn((where) => {
          whereArgs.push(where);
          return Promise.resolve(rows);
        }),
      }),
    }),
  } as any);
}

function mockDrilldownRows(rows: any[], whereArgs: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn((where) => {
          whereArgs.push(where);
          return {
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(rows),
              }),
            }),
          };
        }),
      }),
    }),
  } as any);
}

describe('softwareInventoryRoutes site-scope reads', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = new Hono();
    app.route('/software-inventory', softwareInventoryRoutes);
  });

  describe('GET /software-inventory', () => {
    it('narrows aggregate count, list, and version aggregation to allowed sites for a restricted caller', async () => {
      setAuth([SITE_ALLOWED]);
      vi.mocked(db.execute)
        .mockResolvedValueOnce([{ total: '1' }] as any)
        .mockResolvedValueOnce([
          {
            name: 'Firefox',
            vendor: 'Mozilla',
            device_count: '1',
            first_seen: '2026-01-01T00:00:00Z',
            last_seen: '2026-01-02T00:00:00Z',
            version_data: [{ version: '122.0', device_id: DEVICE_ALLOWED }],
          },
        ] as any);
      mockPolicyStatusMap();

      const res = await app.request('/software-inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);

      const countSql = dumpSql(vi.mocked(db.execute).mock.calls[0]?.[0]);
      const listSql = dumpSql(vi.mocked(db.execute).mock.calls[1]?.[0]);
      expect(countSql).toContain(SITE_ALLOWED);
      expect(listSql).toContain(SITE_ALLOWED);
      expect(listSql).not.toContain(SITE_DENIED);
    });

    it('keeps unrestricted aggregate reads unchanged with no site predicate', async () => {
      vi.mocked(db.execute)
        .mockResolvedValueOnce([{ total: '2' }] as any)
        .mockResolvedValueOnce([
          {
            name: 'Firefox',
            vendor: 'Mozilla',
            device_count: '2',
            first_seen: null,
            last_seen: null,
            version_data: [
              { version: '122.0', device_id: DEVICE_ALLOWED },
              { version: '122.0', device_id: DEVICE_DENIED },
            ],
          },
        ] as any);
      mockPolicyStatusMap();

      const res = await app.request('/software-inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(dumpSql(vi.mocked(db.execute).mock.calls[0]?.[0])).not.toContain(SITE_ALLOWED);
      expect(dumpSql(vi.mocked(db.execute).mock.calls[1]?.[0])).not.toContain(SITE_ALLOWED);
    });
  });

  describe('GET /software-inventory/:name/devices', () => {
    it('narrows drilldown count and list to allowed sites for a restricted caller', async () => {
      setAuth([SITE_ALLOWED]);
      const whereArgs: unknown[] = [];
      mockDrilldownCount([{ count: 1 }], whereArgs);
      mockDrilldownRows([{ deviceId: DEVICE_ALLOWED, hostname: 'allowed-device' }], whereArgs);

      const res = await app.request('/software-inventory/Firefox/devices', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ pagination: { total: 1 } });
      expect(whereArgs).toHaveLength(2);
      for (const where of whereArgs) {
        const rendered = dumpSql(where);
        expect(rendered).toContain('devices.siteId');
        expect(rendered).toContain(SITE_ALLOWED);
        expect(rendered).not.toContain(SITE_DENIED);
      }
    });

    it('keeps unrestricted drilldown reads unchanged with no site predicate', async () => {
      const whereArgs: unknown[] = [];
      mockDrilldownCount([{ count: 2 }], whereArgs);
      mockDrilldownRows([
        { deviceId: DEVICE_ALLOWED, hostname: 'allowed-device' },
        { deviceId: DEVICE_DENIED, hostname: 'denied-device' },
      ], whereArgs);

      const res = await app.request('/software-inventory/Firefox/devices', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(whereArgs).toHaveLength(2);
      for (const where of whereArgs) {
        expect(dumpSql(where)).not.toContain('devices.siteId');
      }
    });
  });
});
