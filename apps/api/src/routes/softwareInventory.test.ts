import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
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
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { softwareInventoryRoutes } from './softwareInventory';
import { db } from '../db';

const ORG_ID = 'org-111';
const POLICY_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Mock helper: db.select().from().where() — resolves directly (no .limit())
 * Used by: getPolicyStatusMap, clear endpoint
 */
function mockSelectFromWhere(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

/**
 * Mock helper: db.select().from().where().limit() — chained with .limit()
 * Used by: approve / deny (Default Allowlist/Blocklist lookup)
 */
function mockSelectFromWhereLimit(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any);
}

/**
 * Mock helper: db.select().from().innerJoin().where() — for joined queries
 * Used by: /:name/devices count query
 */
function mockSelectFromInnerJoinWhere(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any);
}

/**
 * Mock helper: db.select().from().innerJoin().where().orderBy().limit().offset()
 * Used by: /:name/devices data query
 */
function mockSelectFromInnerJoinWhereOrderByLimitOffset(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      }),
    }),
  } as any);
}

describe('software inventory routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/software-inventory', softwareInventoryRoutes);
  });

  // ============================================
  // GET / — Aggregate inventory
  // ============================================
  describe('GET /software-inventory/', () => {
    it('returns aggregated software list with pagination', async () => {
      // getPolicyStatusMap: db.select().from().where() => []
      mockSelectFromWhere([]);
      // Count query: db.execute
      vi.mocked(db.execute).mockResolvedValueOnce([{ total: '2' }] as any);
      // Data query: db.execute
      vi.mocked(db.execute).mockResolvedValueOnce([
        {
          name: 'Visual Studio Code',
          vendor: 'Microsoft',
          device_count: '5',
          first_seen: '2026-01-01T00:00:00Z',
          last_seen: '2026-03-01T00:00:00Z',
          version_data: [
            { version: '1.85.0', device_id: 'dev-1' },
            { version: '1.85.0', device_id: 'dev-2' },
            { version: '1.84.0', device_id: 'dev-3' },
          ],
        },
        {
          name: 'Firefox',
          vendor: 'Mozilla',
          device_count: '3',
          first_seen: '2026-02-01T00:00:00Z',
          last_seen: '2026-03-10T00:00:00Z',
          version_data: [{ version: '122.0', device_id: 'dev-1' }],
        },
      ] as any);

      const res = await app.request('/software-inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].name).toBe('Visual Studio Code');
      expect(body.data[0].deviceCount).toBe(5);
      expect(body.data[0].versions).toBeDefined();
      expect(body.data[0].policyStatus).toBe('no_policy');
      expect(body.pagination.total).toBe(2);
    });

    it('returns 400 when no org context', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-a', 'org-b'],
          canAccessOrg: () => true,
        });
        return next();
      });

      const res = await app.request('/software-inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Organization context required');
    });

    it('filters by search term', async () => {
      mockSelectFromWhere([]); // getPolicyStatusMap
      vi.mocked(db.execute)
        .mockResolvedValueOnce([{ total: '0' }] as any)
        .mockResolvedValueOnce([] as any);

      const res = await app.request('/software-inventory?search=chrome', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(0);
    });

    it('applies policy status from active policies', async () => {
      // getPolicyStatusMap - has an allowlist entry
      mockSelectFromWhere([{
        mode: 'allowlist',
        rules: { software: [{ name: 'Visual Studio Code', vendor: 'Microsoft' }] },
        isActive: true,
      }]);
      vi.mocked(db.execute)
        .mockResolvedValueOnce([{ total: '1' }] as any)
        .mockResolvedValueOnce([{
          name: 'Visual Studio Code',
          vendor: 'Microsoft',
          device_count: '5',
          first_seen: '2026-01-01T00:00:00Z',
          last_seen: '2026-03-01T00:00:00Z',
          version_data: [],
        }] as any);

      const res = await app.request('/software-inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].policyStatus).toBe('allowed');
    });
  });

  // ============================================
  // POST /approve
  // ============================================
  describe('POST /software-inventory/approve', () => {
    it('creates new allowlist policy if none exists', async () => {
      // Existing allowlist policy lookup: db.select().from().where().limit(1)
      mockSelectFromWhereLimit([]);
      // Insert new policy
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: POLICY_ID }]),
          }),
        } as any);
      // ensureDefaultConfigPolicyLink:
      // Config policy select: db.select().from().where().limit(1)
      mockSelectFromWhereLimit([]);
      // Insert config policy
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'config-1' }]),
          }),
        } as any)
        // Feature link upsert
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        } as any)
        // Assignment upsert
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          }),
        } as any);

      const res = await app.request('/software-inventory/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareName: 'Visual Studio Code', vendor: 'Microsoft' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.policyId).toBe(POLICY_ID);
    });

    it('adds to existing allowlist if one exists', async () => {
      // Existing allowlist policy lookup
      mockSelectFromWhereLimit([{
        id: POLICY_ID,
        rules: { software: [{ name: 'Firefox', vendor: 'Mozilla' }], allowUnknown: false },
      }]);
      // Update policy rules
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);
      // ensureDefaultConfigPolicyLink:
      // Config policy select
      mockSelectFromWhereLimit([{ id: 'config-1' }]);
      // Feature link upsert
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        } as any)
        // Assignment upsert
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          }),
        } as any);

      const res = await app.request('/software-inventory/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareName: 'Chrome', vendor: 'Google' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.policyId).toBe(POLICY_ID);
    });

    it('returns 400 when org context missing', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-a', 'org-b'],
          canAccessOrg: () => true,
        });
        return next();
      });

      const res = await app.request('/software-inventory/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareName: 'Test' }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects missing softwareName', async () => {
      const res = await app.request('/software-inventory/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // POST /deny
  // ============================================
  describe('POST /software-inventory/deny', () => {
    it('creates new blocklist policy if none exists', async () => {
      // Existing blocklist policy lookup
      mockSelectFromWhereLimit([]);
      // Insert new policy
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: POLICY_ID }]),
          }),
        } as any);
      // ensureDefaultConfigPolicyLink:
      mockSelectFromWhereLimit([]);
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'config-1' }]),
          }),
        } as any)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        } as any)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          }),
        } as any);

      const res = await app.request('/software-inventory/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareName: 'Malware.exe' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.policyId).toBe(POLICY_ID);
    });

    it('adds to existing blocklist', async () => {
      mockSelectFromWhereLimit([{
        id: POLICY_ID,
        rules: { software: [{ name: 'BadApp' }] },
      }]);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);
      // ensureDefaultConfigPolicyLink:
      mockSelectFromWhereLimit([{ id: 'config-1' }]);
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        } as any)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          }),
        } as any);

      const res = await app.request('/software-inventory/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareName: 'AnotherBadApp' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('rejects missing softwareName', async () => {
      const res = await app.request('/software-inventory/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // POST /clear
  // ============================================
  describe('POST /software-inventory/clear', () => {
    it('removes software from allowlist and blocklist', async () => {
      // db.select().from().where() — resolves directly to array
      mockSelectFromWhere([
        {
          id: 'policy-1',
          rules: { software: [{ name: 'TestApp', vendor: 'Vendor' }] },
        },
      ]);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request('/software-inventory/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareName: 'TestApp', vendor: 'Vendor' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.cleared).toBe(true);
    });

    it('returns cleared=false when software not found in any policy', async () => {
      mockSelectFromWhere([]);

      const res = await app.request('/software-inventory/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareName: 'UnknownApp' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cleared).toBe(false);
    });

    it('returns 400 when no org context', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-a', 'org-b'],
          canAccessOrg: () => true,
        });
        return next();
      });

      const res = await app.request('/software-inventory/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareName: 'TestApp' }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // GET /:name/devices — Device drill-down
  // ============================================
  describe('GET /software-inventory/:name/devices', () => {
    it('returns devices with a specific software installed', async () => {
      // Count: db.select().from().innerJoin().where()
      mockSelectFromInnerJoinWhere([{ count: 2 }]);
      // Data: db.select().from().innerJoin().where().orderBy().limit().offset()
      mockSelectFromInnerJoinWhereOrderByLimitOffset([
        {
          deviceId: 'dev-1',
          hostname: 'workstation-01',
          osType: 'windows',
          osVersion: '11 Pro',
          version: '1.85.0',
          lastSeen: new Date(),
        },
        {
          deviceId: 'dev-2',
          hostname: 'workstation-02',
          osType: 'windows',
          osVersion: '10 Pro',
          version: '1.84.0',
          lastSeen: new Date(),
        },
      ]);

      const res = await app.request('/software-inventory/Visual%20Studio%20Code/devices', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].hostname).toBe('workstation-01');
      expect(body.pagination.total).toBe(2);
    });

    it('returns empty when software not found', async () => {
      mockSelectFromInnerJoinWhere([{ count: 0 }]);
      mockSelectFromInnerJoinWhereOrderByLimitOffset([]);

      const res = await app.request('/software-inventory/NonexistentApp/devices', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(0);
    });

    it('returns 400 when no org context', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-a', 'org-b'],
          canAccessOrg: () => true,
        });
        return next();
      });

      const res = await app.request('/software-inventory/TestApp/devices', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });
  });
});
