import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  assignPolicyMock,
  unassignPolicyMock,
  listAssignmentsMock,
  listAssignmentsForTargetMock,
  validateAssignmentTargetMock,
  authorizeAssignmentTargetMock,
  getAssignmentMock,
  canManagePartnerWideMock,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  assignPolicyMock: vi.fn(),
  unassignPolicyMock: vi.fn(),
  listAssignmentsMock: vi.fn(),
  listAssignmentsForTargetMock: vi.fn(),
  validateAssignmentTargetMock: vi.fn(),
  authorizeAssignmentTargetMock: vi.fn(),
  getAssignmentMock: vi.fn(),
  canManagePartnerWideMock: vi.fn(),
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  // Spread the original so PARTNER_WIDE_WRITE_DENIED_MESSAGE flows through
  // unmocked; canManagePartnerWidePolicies is mocked so each test controls
  // the capability outcome directly instead of depending on real auth shape.
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    assignPolicy: assignPolicyMock,
    unassignPolicy: unassignPolicyMock,
    listAssignments: listAssignmentsMock,
    listAssignmentsForTarget: listAssignmentsForTargetMock,
    validateAssignmentTarget: validateAssignmentTargetMock,
    authorizeAssignmentTarget: authorizeAssignmentTargetMock,
    getAssignment: getAssignmentMock,
    canManagePartnerWidePolicies: canManagePartnerWideMock,
  };
});

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
    // SR5-07 site sub-axis: default to "allowed" so existing (unrestricted)
    // cases are unaffected; individual tests override to assert denial. The real
    // helper is a no-op for callers without allowedSiteIds, so mocking it keeps
    // these route tests DB-free while still exercising the wiring.
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: true });
    // getAssignment backs the DELETE re-check; default to a partner-level row.
    getAssignmentMock.mockResolvedValue({ id: 'aid', level: 'partner', targetId: PARTNER_ID });
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', makeAuth());
      await next();
    });
    app.route('/', assignmentRoutes);
  });

  it('filters policy assignment reads through target site authorization', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
    listAssignmentsMock.mockResolvedValue([
      { id: 'allowed', level: 'device', targetId: DEVICE_ID },
      { id: 'denied', level: 'site', targetId: '55555555-5555-4555-8555-555555555555' },
    ]);
    authorizeAssignmentTargetMock.mockImplementation(async (_auth, _level, targetId) => ({
      valid: targetId === DEVICE_ID,
      error: 'Target is outside your site access',
    }));

    const res = await app.request(`/${POLICY_ID}/assignments`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: [{ id: 'allowed', level: 'device', targetId: DEVICE_ID }],
    });
    expect(authorizeAssignmentTargetMock).toHaveBeenCalledTimes(2);
  });

  it('authorizes an explicit target before listing its assignments', async () => {
    authorizeAssignmentTargetMock.mockResolvedValue({
      valid: false,
      error: 'Target device is outside your site access',
    });

    const res = await app.request(`/assignments/target?level=device&targetId=${DEVICE_ID}`);

    expect(res.status).toBe(403);
    expect(listAssignmentsForTargetMock).not.toHaveBeenCalled();
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

  it('returns 409 (not 500) when the policy is already assigned to this target at this level', async () => {
    // assignPolicy uses .onConflictDoNothing().returning() rather than raising
    // a 23505: withDbAccessContext wraps the request in a postgres.js
    // transaction that re-throws the original error at commit time even after
    // it's caught, turning a mapped 409 back into a raw 500 (see
    // createCatalogItem in catalogService.ts). A null return from the mocked
    // service is how the route detects the duplicate assignment.
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue(null);

    const res = await app.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'device', targetId: DEVICE_ID }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'This policy is already assigned to this target at this level',
    });
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
    canManagePartnerWideMock.mockReturnValue(true);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({
      id: '55555555-5555-5555-5555-555555555555',
      configPolicyId: POLICY_ID,
      level: 'partner',
      targetId: PARTNER_ID,
    });

    const appPartnerAll = new Hono();
    appPartnerAll.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'all' }));
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
    canManagePartnerWideMock.mockReturnValue(false);

    const appPartnerSelected = new Hono();
    appPartnerSelected.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID], partnerOrgAccess: 'selected' }));
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
    canManagePartnerWideMock.mockReturnValue(false);

    const appPartnerNone = new Hono();
    appPartnerNone.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [], partnerOrgAccess: 'none' }));
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
    canManagePartnerWideMock.mockReturnValue(true);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({
      id: '55555555-5555-5555-5555-555555555555',
      configPolicyId: POLICY_ID,
      level: 'partner',
      targetId: PARTNER_ID,
    });

    const appPartnerAll = new Hono();
    appPartnerAll.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'all' }));
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

  it('denies UNASSIGNING a partner-wide policy without full partner org access', async () => {
    // Removing the partner-level assignment strips config from every org under
    // the partner — same blast radius as assigning, same capability gate.
    const AID = '77777777-7777-7777-7777-777777777777';
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Partner-wide' });
    canManagePartnerWideMock.mockReturnValue(false);

    const appPartnerSelected = new Hono();
    appPartnerSelected.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID], partnerOrgAccess: 'selected' }));
      await next();
    });
    appPartnerSelected.route('/', assignmentRoutes);

    const res = await appPartnerSelected.request(`/${POLICY_ID}/assignments/${AID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(403);
    expect(unassignPolicyMock).not.toHaveBeenCalled();
  });

  it('allows unassigning a partner-wide policy with full partner org access', async () => {
    const AID = '77777777-7777-7777-7777-777777777777';
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Partner-wide' });
    canManagePartnerWideMock.mockReturnValue(true);
    unassignPolicyMock.mockResolvedValue({ id: AID, level: 'partner', targetId: PARTNER_ID });

    const appPartnerAll = new Hono();
    appPartnerAll.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'all' }));
      await next();
    });
    appPartnerAll.route('/', assignmentRoutes);

    const res = await appPartnerAll.request(`/${POLICY_ID}/assignments/${AID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(unassignPolicyMock).toHaveBeenCalledWith(AID, POLICY_ID);
  });

  // ============================================================
  // Security: partner-owned policy assignment gate, any level (#2280)
  // ============================================================

  it('rejects an org-level assignment on a partner-owned policy without partner-wide access (403)', async () => {
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Library Policy',
    });
    canManagePartnerWideMock.mockReturnValue(false);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });

    const appPartnerSelected = new Hono();
    appPartnerSelected.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID], partnerOrgAccess: 'selected' }));
      c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'selected', allowedOrgIds: [ORG_ID] }));
      await next();
    });
    appPartnerSelected.route('/', assignmentRoutes);

    const res = await appPartnerSelected.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'organization', targetId: ORG_ID, priority: 0 }),
    });

    expect(res.status).toBe(403);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('allows an org-level assignment on a partner-owned policy with partner-wide access (201)', async () => {
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Library Policy',
    });
    canManagePartnerWideMock.mockReturnValue(true);
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'assign-1', level: 'organization', targetId: ORG_ID });

    const appPartnerAll = new Hono();
    appPartnerAll.use('*', async (c, next) => {
      c.set('auth', makeAuth({ scope: 'partner', orgId: null, partnerId: PARTNER_ID, partnerOrgAccess: 'all' }));
      c.set('permissions', makePermissions({ scope: 'partner', partnerId: PARTNER_ID, orgId: null, orgAccess: 'all' }));
      await next();
    });
    appPartnerAll.route('/', assignmentRoutes);

    const res = await appPartnerAll.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'organization', targetId: ORG_ID, priority: 0 }),
    });

    expect(res.status).toBe(201);
  });

  // ============================================================
  // Security: SR5-07 site sub-axis on assignment create/delete
  // ============================================================

  it('denies a create whose target is outside the caller site access (403) before inserting', async () => {
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: false, error: 'Target device is outside your site access' });

    const res = await app.request(`/${POLICY_ID}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'device', targetId: DEVICE_ID }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Target device is outside your site access' });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('denies a delete whose stored target is outside the caller site access (403) before removing', async () => {
    const AID = '77777777-7777-7777-7777-777777777777';
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
    getAssignmentMock.mockResolvedValue({ id: AID, level: 'device', targetId: DEVICE_ID });
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: false, error: 'Target device is outside your site access' });

    const res = await app.request(`/${POLICY_ID}/assignments/${AID}`, { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(getAssignmentMock).toHaveBeenCalledWith(AID, POLICY_ID);
    expect(unassignPolicyMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the delete target assignment does not exist', async () => {
    const AID = '88888888-8888-8888-8888-888888888888';
    getConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy 1' });
    getAssignmentMock.mockResolvedValue(null);

    const res = await app.request(`/${POLICY_ID}/assignments/${AID}`, { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(unassignPolicyMock).not.toHaveBeenCalled();
  });
});
