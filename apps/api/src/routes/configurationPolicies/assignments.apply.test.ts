import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * POST /:id/assignments/apply (#12466, plan W02b G4): the staged Apply.
 * Route-level unit tests with the service mocked. The rollback of a colliding
 * add on real Postgres (the 409 must not commit the first add) is proven in
 * configPolicyAssignmentApply.integration.test.ts.
 */

const {
  getConfigPolicyMock,
  assignPolicyMock,
  unassignPolicyMock,
  updateAssignmentMock,
  getAssignmentsMock,
  listAssignmentsMock,
  validateAssignmentTargetMock,
  authorizeAssignmentTargetMock,
  authorizeAssignmentTargetsMock,
  canManagePartnerWideMock,
  computeAssignmentDeltaMock,
  writeRouteAuditMock,
  invalidateCacheMock,
  withDbTransactionMock,
  mfaState,
  permState,
  callLog,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  assignPolicyMock: vi.fn(),
  unassignPolicyMock: vi.fn(),
  updateAssignmentMock: vi.fn(),
  getAssignmentsMock: vi.fn(),
  listAssignmentsMock: vi.fn(),
  validateAssignmentTargetMock: vi.fn(),
  authorizeAssignmentTargetMock: vi.fn(),
  authorizeAssignmentTargetsMock: vi.fn(),
  canManagePartnerWideMock: vi.fn(),
  computeAssignmentDeltaMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
  withDbTransactionMock: vi.fn(),
  mfaState: { satisfied: true },
  permState: { permissions: { permissions: [{ resource: 'devices', action: 'write' }] } as any },
  callLog: [] as string[],
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    assignPolicy: assignPolicyMock,
    unassignPolicy: unassignPolicyMock,
    updateAssignment: updateAssignmentMock,
    getAssignments: getAssignmentsMock,
    listAssignments: listAssignmentsMock,
    validateAssignmentTarget: validateAssignmentTargetMock,
    authorizeAssignmentTarget: authorizeAssignmentTargetMock,
    authorizeAssignmentTargets: authorizeAssignmentTargetsMock,
    canManagePartnerWidePolicies: canManagePartnerWideMock,
  };
});
vi.mock('../../services/configPolicyReach', () => ({ computeAssignmentDelta: computeAssignmentDeltaMock }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/remoteAccessPolicy', () => ({ invalidateRemoteAccessCache: invalidateCacheMock }));
vi.mock('../../db', () => ({ withDbTransaction: withDbTransactionMock }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!mfaState.satisfied) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    await next();
  }),
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));
// Real gates, wrapped so a test can count how often the arming gate runs.
vi.mock('./assignmentGates', async (importOriginal) => {
  const original = await importOriginal<typeof import('./assignmentGates')>();
  return { ...original, checkAddArming: vi.fn(original.checkAddArming) };
});

import { assignmentRoutes } from './assignments';
import { checkAddArming } from './assignmentGates';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/configurationPolicy';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const SITE_A = '33333333-3333-3333-3333-333333333331';
const SITE_B = '33333333-3333-3333-3333-333333333332';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';
const ROW_1 = '55555555-5555-5555-5555-555555555551';
const ROW_2 = '55555555-5555-5555-5555-555555555552';
const PARTNER_ID = '66666666-6666-6666-6666-666666666666';

const ARMED_OEM = {
  id: 'oem-link',
  featureType: 'oem_updates',
  inlineSettings: {
    version: 1, enabled: true,
    schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
    catchUpNights: 7, reboot: 'overnight',
    vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
  },
};
const BRANDED_HELPER = { featureType: 'helper', inlineSettings: { enabled: true, branding: { displayName: 'Example Assist' } } };

function policy(over: Record<string, unknown> = {}): any {
  return { id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Baseline', parentPolicyId: null, parentPolicy: null, featureLinks: [], ...over };
}

function storedRow(id: string, over: Record<string, unknown> = {}) {
  return { id, configPolicyId: POLICY_ID, level: 'site', targetId: SITE_A, priority: 0, roleFilter: null, osFilter: null, ...over };
}

let authOverrides: Record<string, unknown> = {};

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: 'user-1' },
      token: { scope: 'organization' },
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (o: string) => o === ORG_ID,
      ...authOverrides,
    } as any);
    c.set('permissions', permState.permissions);
    await next();
  });
  app.route('/', assignmentRoutes);
  return app;
}

function apply(body: unknown) {
  return buildApp().request(`/${POLICY_ID}/assignments/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const WRITES = () => [assignPolicyMock, unassignPolicyMock, updateAssignmentMock];
function expectNoWrites() {
  for (const write of WRITES()) expect(write).not.toHaveBeenCalled();
  expect(withDbTransactionMock).not.toHaveBeenCalled();
  expect(writeRouteAuditMock).not.toHaveBeenCalled();
  expect(invalidateCacheMock).not.toHaveBeenCalled();
}

describe('POST /:id/assignments/apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callLog.length = 0;
    authOverrides = {};
    mfaState.satisfied = true;
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    canManagePartnerWideMock.mockReturnValue(true);
    getConfigPolicyMock.mockResolvedValue(policy());
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: true });
    authorizeAssignmentTargetsMock.mockImplementation(async (_auth: unknown, targets: Array<{ level: string; targetId: string }>) =>
      new Map(targets.map((t) => [`${t.level}:${t.targetId}`, true])));
    getAssignmentsMock.mockResolvedValue([storedRow(ROW_1), storedRow(ROW_2, { level: 'device', targetId: DEVICE_ID })]);
    listAssignmentsMock.mockResolvedValue([storedRow(ROW_1), storedRow(ROW_2, { level: 'device', targetId: DEVICE_ID })]);
    // A pass-through savepoint that records when it opened and closed.
    withDbTransactionMock.mockImplementation(async (fn: () => Promise<unknown>) => {
      callLog.push('tx:open');
      const result = await fn();
      callLog.push('tx:close');
      return result;
    });
    assignPolicyMock.mockImplementation(async (_p: string, level: string, targetId: string, priority: number) => {
      callLog.push(`add:${level}:${targetId}`);
      return { id: `new-${targetId}`, configPolicyId: POLICY_ID, level, targetId, priority };
    });
    unassignPolicyMock.mockImplementation(async (aid: string) => {
      callLog.push(`remove:${aid}`);
      return storedRow(aid);
    });
    updateAssignmentMock.mockImplementation(async (aid: string, _p: string, patch: Record<string, unknown>) => {
      callLog.push(`update:${aid}`);
      return { ...storedRow(aid), ...patch };
    });
    computeAssignmentDeltaMock.mockResolvedValue({ added: 4, removed: 2 });
  });

  it('refuses before any work without MFA', async () => {
    mfaState.satisfied = false;
    const res = await apply({ remove: [ROW_1] });
    expect(res.status).toBe(403);
    expect(getConfigPolicyMock).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('answers 404 for a policy the caller cannot read', async () => {
    getConfigPolicyMock.mockResolvedValue(null);
    const res = await apply({ remove: [ROW_1] });
    expect(res.status).toBe(404);
    expectNoWrites();
  });

  it('refuses an empty Apply', async () => {
    const res = await apply({});
    expect(res.status).toBe(400);
    expectNoWrites();
  });

  it('Apply refuses a partner-owned policy without full partner access', async () => {
    getConfigPolicyMock.mockResolvedValue(policy({ orgId: null, partnerId: PARTNER_ID }));
    canManagePartnerWideMock.mockReturnValue(false);

    for (const body of [{ add: [{ level: 'site', targetId: SITE_A }] }, { remove: [ROW_1] }, { update: [{ id: ROW_1, priority: 2 }] }, { remove: [ROW_1], dryRun: true }]) {
      const res = await apply(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    }
    expectNoWrites();
    expect(computeAssignmentDeltaMock).not.toHaveBeenCalled();
  });

  it('Apply runs every check before any write', async () => {
    const res = await apply({
      add: [{ level: 'site', targetId: SITE_B }],
      update: [{ id: ROW_2, priority: 7 }],
      remove: [ROW_1],
    });

    expect(res.status).toBe(201);
    // Every check ran, and the savepoint opened only after them.
    expect(validateAssignmentTargetMock).toHaveBeenCalledWith({ orgId: ORG_ID, partnerId: null }, 'site', SITE_B);
    expect(authorizeAssignmentTargetsMock).toHaveBeenCalled();
    const checkOrder = Math.max(
      ...validateAssignmentTargetMock.mock.invocationCallOrder,
      ...authorizeAssignmentTargetsMock.mock.invocationCallOrder,
      ...getAssignmentsMock.mock.invocationCallOrder,
    );
    expect(withDbTransactionMock.mock.invocationCallOrder[0]).toBeGreaterThan(checkOrder);
    // Remove, then update, then add, all inside the one savepoint.
    expect(callLog).toEqual(['tx:open', `remove:${ROW_1}`, `update:${ROW_2}`, `add:site:${SITE_B}`, 'tx:close']);
    const body = await res.json();
    expect(body.added).toHaveLength(1);
    expect(body.updated).toHaveLength(1);
    expect(body.removed).toHaveLength(1);
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);
  });

  it('Apply names the failing entry', async () => {
    validateAssignmentTargetMock.mockImplementation(async (_o: unknown, _l: string, targetId: string) =>
      targetId === SITE_B ? { valid: false, error: 'Site target not found in the policy organization' } : { valid: true });

    const res = await apply({ add: [{ level: 'site', targetId: SITE_A }, { level: 'site', targetId: SITE_B }], remove: [ROW_1] });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'Site target not found in the policy organization', entry: { op: 'add', index: 1 } });
    expectNoWrites();
  });

  it('names a missing target id on an add', async () => {
    const res = await apply({ add: [{ level: 'device' }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ entry: { op: 'add', index: 0 } });
    expectNoWrites();
  });

  it('keeps an unsupported partner device group at its own status', async () => {
    validateAssignmentTargetMock.mockResolvedValue({ valid: false, error: 'unsupported', code: 'PARTNER_GROUP_TARGET_UNSUPPORTED', status: 422 });
    const res = await apply({ add: [{ level: 'device_group', targetId: SITE_A }] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'PARTNER_GROUP_TARGET_UNSUPPORTED', entry: { op: 'add', index: 0 } });
  });

  it('refuses an add outside the caller site access and names it', async () => {
    authorizeAssignmentTargetsMock.mockImplementation(async (_a: unknown, targets: Array<{ level: string; targetId: string }>) =>
      new Map(targets.map((t) => [`${t.level}:${t.targetId}`, t.targetId !== SITE_B])));
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: false, error: 'Target site is outside your site access' });

    const res = await apply({ add: [{ level: 'site', targetId: SITE_A }, { level: 'site', targetId: SITE_B }] });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Target site is outside your site access', entry: { op: 'add', index: 1 } });
    // The per-target read runs only for the denied entry, for its message.
    expect(authorizeAssignmentTargetMock).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it('refuses an update or remove whose stored target is outside the caller site access', async () => {
    authorizeAssignmentTargetsMock.mockImplementation(async (_a: unknown, targets: Array<{ level: string; targetId: string }>) =>
      new Map(targets.map((t) => [`${t.level}:${t.targetId}`, t.targetId !== DEVICE_ID])));
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: false, error: 'Target device is outside your site access' });

    const updateRes = await apply({ update: [{ id: ROW_2, priority: 1 }] });
    expect(updateRes.status).toBe(403);
    expect(await updateRes.json()).toMatchObject({ entry: { op: 'update', index: 0 } });

    const removeRes = await apply({ remove: [ROW_1, ROW_2] });
    expect(removeRes.status).toBe(403);
    expect(await removeRes.json()).toMatchObject({ entry: { op: 'remove', index: 1 } });
    // The site check ran on the STORED target, read in one statement.
    expect(getAssignmentsMock).toHaveBeenCalledWith([ROW_1, ROW_2], POLICY_ID);
    expectNoWrites();
  });

  it('Apply derives the partner target server-side', async () => {
    getConfigPolicyMock.mockResolvedValue(policy({ orgId: null, partnerId: PARTNER_ID }));
    authOverrides = { scope: 'partner', orgId: null, partnerId: PARTNER_ID };
    const OTHER_PARTNER = '77777777-7777-7777-7777-777777777777';

    const res = await apply({ add: [{ level: 'partner', targetId: OTHER_PARTNER }] });

    expect(res.status).toBe(201);
    expect(validateAssignmentTargetMock).toHaveBeenCalledWith({ orgId: null, partnerId: PARTNER_ID }, 'partner', PARTNER_ID);
    expect(assignPolicyMock).toHaveBeenCalledWith(POLICY_ID, 'partner', PARTNER_ID, 0, 'user-1', undefined, undefined);
  });

  it('refuses a partner-level add with no partner to derive', async () => {
    const res = await apply({ add: [{ level: 'partner' }] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ entry: { op: 'add', index: 0 } });
    expectNoWrites();
  });

  it('Apply runs the arming gates once when it adds', async () => {
    getConfigPolicyMock.mockResolvedValue(policy({ featureLinks: [ARMED_OEM] }));

    const refused = await apply({ add: [{ level: 'site', targetId: SITE_A }, { level: 'site', targetId: SITE_B }] });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'oem_updates_execute_required' });
    expect(checkAddArming).toHaveBeenCalledTimes(1);
    expectNoWrites();

    vi.mocked(checkAddArming).mockClear();
    permState.permissions = { permissions: [{ resource: 'devices', action: 'execute' }] } as any;
    const allowed = await apply({ add: [{ level: 'site', targetId: SITE_A }, { level: 'site', targetId: SITE_B }] });
    expect(allowed.status).toBe(201);
    expect(checkAddArming).toHaveBeenCalledTimes(1);
  });

  it('Apply skips the arming gates for removes and unchanged updates only', async () => {
    getConfigPolicyMock.mockResolvedValue(policy({ featureLinks: [ARMED_OEM] }));

    // ROW_2 is stored with priority 0 and no filters: this update changes nothing.
    const res = await apply({ update: [{ id: ROW_2, priority: 0, roleFilter: [] }], remove: [ROW_1] });

    expect(res.status).toBe(201);
    expect(checkAddArming).not.toHaveBeenCalled();
  });

  // Priority and filters decide which devices an armed policy reaches and where
  // it wins, so editing them in place is the same door as adding a row.
  it.each([
    ['widens a filter', { roleFilter: null }, { roleFilter: ['server'] }],
    ['changes a filter', { osFilter: ['windows', 'linux'] }, { osFilter: ['windows'] }],
    ['changes the priority', { priority: 1 }, {}],
  ])('an update that %s runs the arming gates once', async (_label, patch, stored) => {
    getConfigPolicyMock.mockResolvedValue(policy({ featureLinks: [ARMED_OEM] }));
    getAssignmentsMock.mockResolvedValue([storedRow(ROW_1, stored), storedRow(ROW_2, stored)]);

    const res = await apply({ update: [{ id: ROW_1, ...patch }, { id: ROW_2, ...patch }] });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'oem_updates_execute_required' });
    expect(checkAddArming).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it('Apply refuses a branding-incompatible level', async () => {
    getConfigPolicyMock.mockResolvedValue(policy({ featureLinks: [BRANDED_HELPER] }));

    const res = await apply({ add: [{ level: 'organization', targetId: ORG_ID }, { level: 'device', targetId: DEVICE_ID }] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ entry: { op: 'add', index: 1 } });
    expectNoWrites();
  });

  it("Apply refuses another policy's assignment id", async () => {
    getAssignmentsMock.mockResolvedValue([storedRow(ROW_1)]); // ROW_2 is not this policy's

    const res = await apply({ remove: [ROW_1], update: [{ id: ROW_2, priority: 1 }] });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Assignment not found', entry: { op: 'update', index: 0 } });
    expectNoWrites();
  });

  it('a colliding add answers 409, names the entry, and audits nothing', async () => {
    assignPolicyMock.mockImplementation(async (_p: string, level: string, targetId: string) =>
      targetId === SITE_B ? null : { id: 'new', level, targetId });

    const res = await apply({ remove: [ROW_1], add: [{ level: 'site', targetId: SITE_A }, { level: 'site', targetId: SITE_B }] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'assignment_conflict', entry: { op: 'add', index: 1 } });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });

  it('a remove or update that matches nothing answers 409 and names it', async () => {
    unassignPolicyMock.mockResolvedValue(null);
    const removeRes = await apply({ remove: [ROW_1] });
    expect(removeRes.status).toBe(409);
    expect(await removeRes.json()).toMatchObject({ error: 'assignment_conflict', entry: { op: 'remove', index: 0 } });

    updateAssignmentMock.mockResolvedValue(null);
    const updateRes = await apply({ update: [{ id: ROW_2, priority: 1 }] });
    expect(updateRes.status).toBe(409);
    expect(await updateRes.json()).toMatchObject({ error: 'assignment_conflict', entry: { op: 'update', index: 0 } });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('an unexpected write failure is not mapped to a 409', async () => {
    unassignPolicyMock.mockRejectedValue(new Error('connection reset'));
    const res = await apply({ remove: [ROW_1] });
    expect(res.status).toBe(500);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('dry run writes nothing and returns the device delta', async () => {
    const res = await apply({
      add: [{ level: 'site', targetId: SITE_B, roleFilter: ['server'] }],
      update: [{ id: ROW_2, osFilter: ['windows'] }],
      remove: [ROW_1],
      dryRun: true,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: true, delta: { added: 4, removed: 2 } });
    expectNoWrites();
    // Checks still ran: a dry run is not a way around them.
    expect(validateAssignmentTargetMock).toHaveBeenCalled();
    const [, owner, current, proposed] = computeAssignmentDeltaMock.mock.calls[0]!;
    expect(owner).toEqual({ orgId: ORG_ID, partnerId: null });
    expect(current).toEqual([
      { level: 'site', targetId: SITE_A, roleFilter: null, osFilter: null },
      { level: 'device', targetId: DEVICE_ID, roleFilter: null, osFilter: null },
    ]);
    expect(proposed).toEqual([
      { level: 'device', targetId: DEVICE_ID, roleFilter: null, osFilter: ['windows'] },
      { level: 'site', targetId: SITE_B, roleFilter: ['server'], osFilter: null },
    ]);
  });

  it('a dry run surfaces a partial delta', async () => {
    computeAssignmentDeltaMock.mockResolvedValue({ added: 9, removed: 0, partial: true });
    const res = await apply({ add: [{ level: 'site', targetId: SITE_B }], dryRun: true });
    expect(await res.json()).toEqual({ dryRun: true, delta: { added: 9, removed: 0, partial: true } });
  });

  it('a dry run runs every check, and a refused one never computes a delta', async () => {
    getAssignmentsMock.mockResolvedValue([]);
    const res = await apply({ remove: [ROW_1], dryRun: true });
    expect(res.status).toBe(404);
    expect(computeAssignmentDeltaMock).not.toHaveBeenCalled();
  });

  it('a dry run predicts a colliding add', async () => {
    // SITE_A is already a kept row; a second add of SITE_B collides with the first.
    const kept = await apply({ add: [{ level: 'site', targetId: SITE_A }], dryRun: true });
    expect(kept.status).toBe(409);
    expect(await kept.json()).toMatchObject({ error: 'assignment_conflict', entry: { op: 'add', index: 0 } });

    const twice = await apply({ add: [{ level: 'site', targetId: SITE_B }, { level: 'site', targetId: SITE_B }], dryRun: true });
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({ entry: { op: 'add', index: 1 } });

    // Removing the row first frees its target, as the real Apply orders it.
    const freed = await apply({ remove: [ROW_1], add: [{ level: 'site', targetId: SITE_A }], dryRun: true });
    expect(freed.status).toBe(200);
    expect(computeAssignmentDeltaMock).toHaveBeenCalledTimes(1);
  });

  it('Apply audits one row per change', async () => {
    const res = await apply({
      add: [{ level: 'site', targetId: SITE_B, priority: 4 }],
      update: [{ id: ROW_2, priority: 7, roleFilter: null }],
      remove: [ROW_1],
    });

    expect(res.status).toBe(201);
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(3);
    const actions = writeRouteAuditMock.mock.calls.map((call) => call[1].action);
    expect(actions.sort()).toEqual(['config_policy.assign', 'config_policy.assignment_update', 'config_policy.unassign']);
    for (const call of writeRouteAuditMock.mock.calls) {
      expect(call[1]).toMatchObject({ orgId: ORG_ID, resourceType: 'configuration_policy', resourceId: POLICY_ID, resourceName: 'Baseline' });
    }
    const update = writeRouteAuditMock.mock.calls.find((call) => call[1].action === 'config_policy.assignment_update')!;
    expect(update[1].details).toMatchObject({ assignmentId: ROW_2, priority: 7, roleFilter: null });
    // The audit rows are written after the savepoint closed.
    expect(writeRouteAuditMock.mock.invocationCallOrder[0]).toBeGreaterThan(withDbTransactionMock.mock.invocationCallOrder[0]!);
  });

  it('passes an update patch through without inventing fields', async () => {
    await apply({ update: [{ id: ROW_2, osFilter: ['linux'] }] });
    expect(updateAssignmentMock).toHaveBeenCalledWith(ROW_2, POLICY_ID, { osFilter: ['linux'] });
  });
});
