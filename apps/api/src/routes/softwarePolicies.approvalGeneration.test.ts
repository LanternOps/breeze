import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';

// Site-ceiling gate contract §3: PATCH bumps software_policies.approval_generation
// so a queued compliance/remediation job carrying the OLD generation can tell
// it has been superseded by an edit and skip acting on stale config.

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
  softwarePolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', mode: 'mode', name: 'name', isActive: 'isActive', updatedAt: 'updatedAt', approvalGeneration: 'approvalGeneration' },
}));

const { authRef } = vi.hoisted(() => ({ authRef: { current: {} as any } }));

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
  canAccessSite: () => true,
}));

import { softwarePoliciesRoutes } from './softwarePolicies';
import { db } from '../db';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';

function orgAuth(): AuthContext {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    canAccessOrg: (id: string) => id === ORG_ID,
    orgCondition: () => null,
    user: { id: 'user-1' },
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds: undefined,
  } as unknown as AuthContext;
}

function app() {
  const instance = new Hono();
  instance.route('/software-policies', softwarePoliciesRoutes);
  return instance;
}

describe('PATCH /software-policies/:id bumps approval_generation', () => {
  let updateSetArg: Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = orgAuth();
    updateSetArg = undefined;
    (db.select as any).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, isActive: true }]) }) }),
    });
    (db.transaction as any).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        update: () => ({
          set: (setArg: Record<string, unknown>) => {
            updateSetArg = setArg;
            return {
              where: () => ({
                returning: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, name: 'renamed', approvalGeneration: 2 }]),
              }),
            };
          },
        }),
      };
      return fn(tx);
    });
  });

  it('includes an approvalGeneration bump expression in the update set payload', async () => {
    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(200);
    expect(updateSetArg).toBeDefined();
    expect(updateSetArg).toHaveProperty('approvalGeneration');
  });
});
