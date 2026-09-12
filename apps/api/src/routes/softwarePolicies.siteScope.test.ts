import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';

const { authRef } = vi.hoisted(() => ({ authRef: { current: {} as any } }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId', hostname: 'devices.hostname', status: 'devices.status', osType: 'devices.osType' },
  softwareComplianceStatus: { id: 'x', policyId: 'x', deviceId: 'x', status: 'x', violations: 'x', lastChecked: 'x', remediationStatus: 'x', lastRemediationAttempt: 'x' },
  softwarePolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', mode: 'mode', name: 'name', isActive: 'isActive', updatedAt: 'updatedAt' },
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

vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));
vi.mock('../services/softwarePolicyService', () => ({
  normalizeSoftwarePolicyRules: (r: any) => ({ software: r.software ?? [], executable: r.executable, allowUnknown: r.allowUnknown }),
  recordSoftwarePolicyAudit: vi.fn(async () => undefined),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/pamActuationLifecycle', () => ({ requestPamCleanup: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  canAccessSite: (perms: any, siteId: string) => !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

import { softwarePoliciesRoutes } from './softwarePolicies';
import { db } from '../db';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';

function orgAuth(allowedSiteIds: string[] | undefined): AuthContext {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    canAccessOrg: (id: string) => id === ORG_ID,
    orgCondition: () => null,
    user: { id: 'user-1' },
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
  } as unknown as AuthContext;
}

function app() {
  const instance = new Hono();
  instance.route('/software-policies', softwarePoliciesRoutes);
  return instance;
}

describe('software policies site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: POST /software-policies denied 403, no insert', async (_label, allowedSiteIds) => {
    authRef.current = orgAuth(allowedSiteIds);
    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'p', mode: 'allowlist', rules: { software: [{ name: 'x' }] } }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('restricted caller: PATCH /software-policies/:id denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('restricted caller: DELETE /software-policies/:id denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request(`/software-policies/${POLICY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: POST proceeds to insert', async () => {
    authRef.current = orgAuth(undefined);
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, name: 'p', rules: { software: [] } }])),
      })),
    });
    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'p', mode: 'allowlist', rules: { software: [{ name: 'x' }] } }),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it('partner-scope caller with allowedSiteIds set is NOT affected by this gate', async () => {
    authRef.current = {
      scope: 'partner',
      orgId: undefined,
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => null,
      user: { id: 'user-1' },
      accessibleOrgIds: [ORG_ID],
      allowedSiteIds: ['s1'],
      partnerId: 'partner-1',
    } as unknown as AuthContext;
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, name: 'p', rules: { software: [] } }])),
      })),
    });
    const res = await app().request(`/software-policies?orgId=${ORG_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'p', mode: 'allowlist', rules: { software: [{ name: 'x' }] } }),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
