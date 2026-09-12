/**
 * #5505 W01 — `remediationOptions.autoInstall` (the desired-state install
 * arming flag) and the authorization gate that guards arming it.
 *
 * `remediationOptionsSchema` is a NON-STRICT z.object, so before this wave an
 * `autoInstall` sent by a client was silently STRIPPED — no error, no field,
 * no way for a caller to tell. Both createPolicySchema and updatePolicySchema
 * reuse that one object, so the passthrough is asserted through both routes as
 * well as against the schema directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';

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

const { authRef, mfaRef, executeRef } = vi.hoisted(() => ({
  authRef: { current: {} as Record<string, unknown> },
  mfaRef: { current: true },
  executeRef: { current: true },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
    // requirePermission normally sets this (middleware/auth.ts:874); the mock
    // above replaces it, so inject the same shape the handler will read.
    c.set('permissions', { permissions: [], scope: 'organization', orgId: null, partnerId: null, roleId: 'role-1' });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn(() => mfaRef.current),
}));

vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));
vi.mock('../services/softwarePolicyService', () => ({
  normalizeSoftwarePolicyRules: (r: any) => ({ software: r.software ?? [], executable: r.executable, allowUnknown: r.allowUnknown }),
  recordSoftwarePolicyAudit: vi.fn(async () => undefined),
  // Faithful copy of the real helper (softwarePolicyService.ts) — the
  // authorization service imports it from this module, so the mock has to
  // supply it. Arming is opt-in: only the literal boolean `true` counts.
  readSoftwarePolicyAutoInstall: (raw: unknown) =>
    !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).autoInstall === true,
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
  hasPermission: vi.fn((_perms: unknown, resource: string, action: string) =>
    resource === 'devices' && action === 'execute' ? executeRef.current : true),
}));

import { remediationOptionsSchema, softwarePoliciesRoutes } from './softwarePolicies';
import { db } from '../db';
import type { SoftwarePolicyRemediationOptions } from '../db/schema/softwarePolicies';

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
    token: { mfa: true },
  } as unknown as AuthContext;
}

function app() {
  const instance = new Hono();
  instance.route('/software-policies', softwarePoliciesRoutes);
  return instance;
}

/** db.insert(...).values(...).returning() — captures the inserted values. */
function mockInsertCapturing(captured: { values?: Record<string, unknown> }) {
  (db.insert as any).mockReturnValue({
    values: (v: Record<string, unknown>) => {
      captured.values = v;
      return { returning: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, mode: v.mode, name: v.name }]) };
    },
  });
}

describe('#5505 remediationOptions.autoInstall reaches the server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = orgAuth() as unknown as Record<string, unknown>;
    mfaRef.current = true;
    executeRef.current = true;
  });

  it('remediationOptionsSchema keeps autoInstall instead of stripping it', () => {
    const parsed = remediationOptionsSchema.parse({ autoInstall: true, autoUninstall: false });
    expect(parsed.autoInstall).toBe(true);
    expect(parsed.autoUninstall).toBe(false);
  });

  it('remediationOptionsSchema rejects a non-boolean autoInstall', () => {
    expect(() => remediationOptionsSchema.parse({ autoInstall: 'true' })).toThrow();
    expect(() => remediationOptionsSchema.parse({ autoInstall: 1 })).toThrow();
  });

  it('autoInstall and autoUninstall are independent flags on the type', () => {
    const installOnly: SoftwarePolicyRemediationOptions = { autoInstall: true };
    const uninstallOnly: SoftwarePolicyRemediationOptions = { autoUninstall: true };
    expect(installOnly.autoUninstall).toBeUndefined();
    expect(uninstallOnly.autoInstall).toBeUndefined();
  });

  it('POST persists autoInstall into remediation_options', async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockInsertCapturing(captured);

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: ORG_ID,
        name: 'Required software',
        mode: 'allowlist',
        rules: { software: [{ name: '7-Zip' }] },
        enforceMode: true,
        remediationOptions: { autoInstall: true },
      }),
    });

    expect(res.status).toBe(201);
    expect(captured.values?.remediationOptions).toEqual({ autoInstall: true });
  });

  it('PATCH persists autoInstall into remediation_options', async () => {
    let updateSetArg: Record<string, unknown> | undefined;
    (db.select as any).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, isActive: true, mode: 'allowlist', enforceMode: true, remediationOptions: null }]) }) }),
    });
    (db.transaction as any).mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      update: () => ({
        set: (setArg: Record<string, unknown>) => {
          updateSetArg = setArg;
          return { where: () => ({ returning: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, name: 'Required software', approvalGeneration: 2 }]) }) };
        },
      }),
    }));

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remediationOptions: { autoInstall: true } }),
    });

    expect(res.status).toBe(200);
    expect(updateSetArg?.remediationOptions).toEqual({ autoInstall: true });
  });
});
