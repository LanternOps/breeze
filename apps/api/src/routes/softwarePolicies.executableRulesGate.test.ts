/**
 * #5480 moved PAM approval/policy authority to pam:approve / pam:manage_policy.
 * Software-policy writes were still gated only on devices:write, so a
 * devices:write holder without pam:manage_policy could set rules.executable[]
 * (sha256/signer/publisher/pathGlob) on an allowlist/blocklist policy and reach
 * PAM's auto-approve/auto-deny bridge directly. This suite exercises the gate
 * through the actual POST/PATCH routes (integration-style, mocked db).
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

const { authRef, mfaRef, managePolicyRef } = vi.hoisted(() => ({
  authRef: { current: {} as Record<string, unknown> },
  mfaRef: { current: true },
  managePolicyRef: { current: true },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
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
  readSoftwarePolicyAutoInstall: () => false,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/pamActuationLifecycle', () => ({ requestPamCleanup: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
    PAM_MANAGE_POLICY: { resource: 'pam', action: 'manage_policy' },
  },
  canAccessSite: () => true,
  hasPermission: vi.fn((_perms: unknown, resource: string, action: string) => {
    if (resource === 'pam' && action === 'manage_policy') return managePolicyRef.current;
    // devices.execute (install-arming gate) is irrelevant to these tests —
    // every body here has no remediationOptions.autoInstall, so it's never checked.
    return true;
  }),
}));

import { softwarePoliciesRoutes } from './softwarePolicies';
import { EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE } from '../services/softwarePolicyExecutableRulesAuthorization';
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
    token: { mfa: true },
  } as unknown as AuthContext;
}

function app() {
  const instance = new Hono();
  instance.route('/software-policies', softwarePoliciesRoutes);
  return instance;
}

function mockInsertCapturing(captured: { values?: Record<string, unknown> }) {
  (db.insert as any).mockReturnValue({
    values: (v: Record<string, unknown>) => {
      captured.values = v;
      return { returning: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, mode: v.mode, name: v.name }]) };
    },
  });
}

function mockStoredPolicy(row: Record<string, unknown>) {
  (db.select as any).mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }),
  });
}

function mockUpdateTransaction() {
  (db.transaction as any).mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, name: 'renamed', approvalGeneration: 2 }]) }) }),
    }),
  }));
}

const EXECUTABLE_BODY = {
  orgId: ORG_ID,
  name: 'PAM allowlist',
  mode: 'allowlist',
  rules: { executable: [{ name: 'setup.exe', pathGlob: 'C:\\Users\\*\\Downloads\\*' }] },
  enforceMode: true,
};

describe('software policy executable[] rules require pam.manage_policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = orgAuth() as unknown as Record<string, unknown>;
    mfaRef.current = true;
    managePolicyRef.current = true;
  });

  it('POST refuses creating an allowlist policy with executable rules without pam.manage_policy, and writes nothing', async () => {
    managePolicyRef.current = false;
    const captured: { values?: Record<string, unknown> } = {};
    mockInsertCapturing(captured);

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(EXECUTABLE_BODY),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE,
      code: 'PAM_MANAGE_POLICY_REQUIRED',
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('POST allows creating an allowlist policy with executable rules for a caller with pam.manage_policy', async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockInsertCapturing(captured);

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(EXECUTABLE_BODY),
    });

    expect(res.status).toBe(201);
    const rules = captured.values?.rules as { executable?: unknown[] } | undefined;
    expect(rules?.executable).toHaveLength(1);
  });

  it('POST does NOT gate a software[]-only policy (no executable rules) without pam.manage_policy', async () => {
    managePolicyRef.current = false;
    mockInsertCapturing({});

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...EXECUTABLE_BODY, rules: { software: [{ name: '7-Zip' }] } }),
    });

    expect(res.status).toBe(201);
  });

  it('POST does NOT gate an audit-mode policy with executable rules (no PAM effect)', async () => {
    managePolicyRef.current = false;
    mockInsertCapturing({});

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...EXECUTABLE_BODY, mode: 'audit', enforceMode: false }),
    });

    expect(res.status).toBe(201);
  });

  it('PATCH refuses adding executable rules to an existing allowlist policy without pam.manage_policy', async () => {
    managePolicyRef.current = false;
    mockStoredPolicy({
      id: POLICY_ID, orgId: ORG_ID, isActive: true,
      mode: 'allowlist', enforceMode: true, remediationOptions: null, rules: { software: [{ name: '7-Zip' }] },
    });
    mockUpdateTransaction();

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: EXECUTABLE_BODY.rules }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PAM_MANAGE_POLICY_REQUIRED');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('PATCH refuses switching mode to allowlist on a policy that already carries executable rules', async () => {
    managePolicyRef.current = false;
    mockStoredPolicy({
      id: POLICY_ID, orgId: ORG_ID, isActive: true,
      mode: 'audit', enforceMode: false, remediationOptions: null, rules: EXECUTABLE_BODY.rules,
    });
    mockUpdateTransaction();

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'allowlist', enforceMode: true }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PAM_MANAGE_POLICY_REQUIRED');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('PATCH allows an unrelated field edit (name) on an executable-rules policy without pam.manage_policy', async () => {
    managePolicyRef.current = false;
    mockStoredPolicy({
      id: POLICY_ID, orgId: ORG_ID, isActive: true,
      mode: 'allowlist', enforceMode: true, remediationOptions: null, rules: EXECUTABLE_BODY.rules,
    });
    mockUpdateTransaction();

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed policy' }),
    });

    expect(res.status).toBe(200);
  });

  it('PATCH allows editing executable rules for a caller with pam.manage_policy', async () => {
    mockStoredPolicy({
      id: POLICY_ID, orgId: ORG_ID, isActive: true,
      mode: 'allowlist', enforceMode: true, remediationOptions: null, rules: { software: [] },
    });
    mockUpdateTransaction();

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: EXECUTABLE_BODY.rules }),
    });

    expect(res.status).toBe(200);
  });
});
