import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef } = vi.hoisted(() => ({ authRef: { current: {} as any } }));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
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
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  softwareInventory: {
    deviceId: 'softwareInventory.deviceId', name: 'softwareInventory.name',
    vendor: 'softwareInventory.vendor', version: 'softwareInventory.version', lastSeen: 'softwareInventory.lastSeen',
  },
  softwarePolicies: {
    id: 'softwarePolicies.id', orgId: 'softwarePolicies.orgId', name: 'softwarePolicies.name',
    mode: 'softwarePolicies.mode', isActive: 'softwarePolicies.isActive', rules: 'softwarePolicies.rules',
  },
  configurationPolicies: {
    id: 'configurationPolicies.id', orgId: 'configurationPolicies.orgId',
    name: 'configurationPolicies.name', status: 'configurationPolicies.status',
  },
  configPolicyFeatureLinks: {
    configPolicyId: 'configPolicyFeatureLinks.configPolicyId', featureType: 'configPolicyFeatureLinks.featureType',
    featurePolicyId: 'configPolicyFeatureLinks.featurePolicyId', updatedAt: 'configPolicyFeatureLinks.updatedAt',
  },
  configPolicyAssignments: {
    configPolicyId: 'configPolicyAssignments.configPolicyId', level: 'configPolicyAssignments.level',
    targetId: 'configPolicyAssignments.targetId', priority: 'configPolicyAssignments.priority',
    assignedBy: 'configPolicyAssignments.assignedBy',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/softwarePolicyService', () => ({ recordSoftwarePolicyAudit: vi.fn().mockResolvedValue(undefined) }));

import { softwareInventoryRoutes } from './softwareInventory';
import { db } from '../db';

const ORG_ID = 'org-111';

function orgAuth(allowedSiteIds: string[] | undefined) {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'organization',
    partnerId: null,
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === ORG_ID,
  };
}

function app() {
  const instance = new Hono();
  instance.route('/software-inventory', softwareInventoryRoutes);
  return instance;
}

describe('software inventory approve/deny/clear site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['/approve', ['s1']],
    ['/approve', []],
    ['/deny', ['s1']],
    ['/clear', ['s1']],
  ] as const)('restricted caller on POST %s (%j) denied 403, no db access', async (route, allowedSiteIds) => {
    authRef.current = orgAuth([...allowedSiteIds]);
    const res = await app().request(`/software-inventory${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ softwareName: 'Acme Tool', vendor: 'Acme' }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: POST /approve proceeds', async () => {
    authRef.current = orgAuth(undefined);
    (db.select as any).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    (db.insert as any).mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([{ id: 'policy-1', name: 'Default Allowlist' }]) }),
    });
    const res = await app().request('/software-inventory/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ softwareName: 'Acme Tool', vendor: 'Acme' }),
    });
    expect(res.status).toBe(201);
    expect(db.select).toHaveBeenCalled();
  });
});
