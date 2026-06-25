import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  assignPolicyMock,
  unassignPolicyMock,
  listAssignmentsMock,
  listAssignmentsForTargetMock,
  validateAssignmentTargetMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  assignPolicyMock: vi.fn(),
  unassignPolicyMock: vi.fn(),
  listAssignmentsMock: vi.fn(),
  listAssignmentsForTargetMock: vi.fn(),
  validateAssignmentTargetMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', () => ({
  getConfigPolicy: getConfigPolicyMock,
  assignPolicy: assignPolicyMock,
  unassignPolicy: unassignPolicyMock,
  listAssignments: listAssignmentsMock,
  listAssignmentsForTarget: listAssignmentsForTargetMock,
  validateAssignmentTarget: validateAssignmentTargetMock,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  invalidateRemoteAccessCache: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
}));

import { assignmentRoutes } from './assignments';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const PARTNER_ID = '66666666-6666-6666-6666-666666666666';

function makeAuth(overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: null,
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: { scope: 'organization' },
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
    ...overrides,
  };
}

function makePermissions(overrides: Record<string, unknown> = {}): any {
  return {
    permissions: [{ resource: 'devices', action: 'write' }],
    partnerId: null,
    orgId: ORG_ID,
    roleId: 'role-1',
    scope: 'organization',
    orgAccess: undefined,
    ...overrides,
  };
}

describe('configurationPolicies assignment routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', makeAuth());
      await next();
    });
    app.route('/', assignmentRoutes);
  });

  it('assigns a policy when the target belongs to the policy organization', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({
      id: '44444444-4444-4444-4444-444444444444',
      configPolicyId: POLICY_ID,
      level: 'device',
      targetId: DEVICE_ID,
    });

    const res = await app.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'device', targetId: DEVICE_ID }),
    });

    expect(res.status).toBe(201);
    expect(validateAssignmentTargetMock).toHaveBeenCalledWith(
      { orgId: ORG_ID, partnerId: null },
      'device',
      DEVICE_ID
    );
    expect(assignPolicyMock).toHaveBeenCalledWith(
      POLICY_ID,
      'device',
      DEVICE_ID,
      0,
      'user-1',
      undefined,
      undefined
    );
  });

  it('denies cross-org assignment targets before inserting the assignment', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
    validateAssignmentTargetMock.mockResolvedValue({
      valid: false,
      error: 'Device target not found in the policy organization',
    });

    const res = await app.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'device', targetId: DEVICE_ID }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Device target not found in the policy organization',
    });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('derives the partner target server-side for a partner-wide assignment (#1724)', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Partner-wide' });
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({
      id: '55555555-5555-5555-5555-555555555555',
      configPolicyId: POLICY_ID,
      level: 'partner',
      targetId: PARTNER_ID,
    });

    const appPartnerAll = new Hono();
    appPartnerAll.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID }));
      // requirePermission populates permissions; simulate orgAccess='all' (full partner admin)
      c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'all' }));
      await next();
    });
    appPartnerAll.route('/', assignmentRoutes);

    // No targetId in the body — the server must fill it from the policy's partner.
    const res = await appPartnerAll.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'partner' }),
    });

    expect(res.status).toBe(201);
    expect(validateAssignmentTargetMock).toHaveBeenCalledWith(
      { orgId: null, partnerId: PARTNER_ID },
      'partner',
      PARTNER_ID
    );
    expect(assignPolicyMock).toHaveBeenCalledWith(
      POLICY_ID,
      'partner',
      PARTNER_ID,
      0,
      'user-1',
      undefined,
      undefined
    );
  });

  // ============================================================
  // Security: orgAccess escalation guard (partner org-reach fix)
  // ============================================================

  it('denies partner-level assignment when orgAccess is "selected" (attacker fails-closed)', async () => {
    // A partner user with orgAccess='selected' (limited to orgA) must NOT be allowed
    // to make a partner-level assignment that would push config to ALL orgs under
    // the partner — including orgs they cannot access.
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Partner-wide' });

    const appPartnerSelected = new Hono();
    appPartnerSelected.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID] }));
      c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'selected', allowedOrgIds: [ORG_ID] }));
      await next();
    });
    appPartnerSelected.route('/', assignmentRoutes);

    const res = await appPartnerSelected.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'partner' }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/full partner org access/);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('denies partner-level assignment when orgAccess is "none"', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Partner-wide' });

    const appPartnerNone = new Hono();
    appPartnerNone.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [] }));
      c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'none' }));
      await next();
    });
    appPartnerNone.route('/', assignmentRoutes);

    const res = await appPartnerNone.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'partner' }),
    });

    expect(res.status).toBe(403);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('allows partner-level assignment when orgAccess is "all" (legit partner admin)', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Partner-wide' });
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({
      id: '55555555-5555-5555-5555-555555555555',
      configPolicyId: POLICY_ID,
      level: 'partner',
      targetId: PARTNER_ID,
    });

    const appPartnerAll = new Hono();
    appPartnerAll.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID }));
      c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'all' }));
      await next();
    });
    appPartnerAll.route('/', assignmentRoutes);

    const res = await appPartnerAll.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'partner' }),
    });

    expect(res.status).toBe(201);
    expect(assignPolicyMock).toHaveBeenCalledWith(
      POLICY_ID,
      'partner',
      PARTNER_ID,
      0,
      'user-1',
      undefined,
      undefined
    );
  });

  it('non-partner-level assignments are unaffected by the orgAccess guard', async () => {
    // A 'selected'-access partner user can still assign at device/org/site level
    // — the guard ONLY applies to partner-level assignments.
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({
      id: '44444444-4444-4444-4444-444444444444',
      configPolicyId: POLICY_ID,
      level: 'device',
      targetId: DEVICE_ID,
    });

    const appPartnerSelected = new Hono();
    appPartnerSelected.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID], canAccessOrg: (id: string) => id === ORG_ID }));
      c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'selected', allowedOrgIds: [ORG_ID] }));
      await next();
    });
    appPartnerSelected.route('/', assignmentRoutes);

    const res = await appPartnerSelected.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'device', targetId: DEVICE_ID }),
    });

    // orgAccess guard does not apply to device-level assignments
    expect(res.status).toBe(201);
    expect(assignPolicyMock).toHaveBeenCalled();
  });
});
