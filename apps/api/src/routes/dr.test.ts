import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { drRoutes } from './dr';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXECUTION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OUT_OF_SITE_DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const SITE_A = '22222222-2222-4222-8222-222222222222';
const SITE_B = '33333333-3333-4333-8333-333333333333';

vi.mock('../services', () => ({}));

const writeRouteAuditMock = vi.fn();
const createDrExecutionAndEnqueueMock = vi.fn();
const classifyDrExecutionAuthorizationErrorMock = vi.fn(() => null as unknown);

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'for', 'returning', 'values', 'set']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const deleteMock = vi.fn(() => chainMock([]));
let authState = {
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
  principal: { kind: 'user_session' as const },
};
/** null => the caller carries no site restriction (the pre-existing default). */
let permissionsState: { allowedSiteIds: string[] | null } | null = null;

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  withDbTransaction: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  drPlans: {
    id: 'dr_plans.id',
    orgId: 'dr_plans.org_id',
    createdAt: 'dr_plans.created_at',
  },
  drPlanGroups: {
    id: 'dr_plan_groups.id',
    planId: 'dr_plan_groups.plan_id',
    orgId: 'dr_plan_groups.org_id',
    sequence: 'dr_plan_groups.sequence',
    devices: 'dr_plan_groups.devices',
  },
  drExecutions: {
    id: 'dr_executions.id',
    orgId: 'dr_executions.org_id',
    planId: 'dr_executions.plan_id',
    createdAt: 'dr_executions.created_at',
    status: 'dr_executions.status',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
  },
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

vi.mock('../services/drExecutionService', () => ({
  DrPlanDefinitionError: class DrPlanDefinitionError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  createDrExecutionAndEnqueue: (...args: unknown[]) => createDrExecutionAndEnqueueMock(...(args as [])),
  classifyDrExecutionAuthorizationError: (...args: unknown[]) =>
    classifyDrExecutionAuthorizationErrorMock(...(args as [])),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => {
    if (permissionsState) c.set('permissions', permissionsState);
    return next();
  }),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../middleware/auth';

/** drPlanWrites' reads: the plan row lock, then no pending or running execution. */
function queuePlanWriteReads() {
  selectMock
    .mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID }]))
    .mockReturnValueOnce(chainMock([]));
}

/** drPlanWrites moves the plan revision after a group write. */
function queueRevisionMove() {
  updateMock.mockReturnValueOnce(chainMock([{ id: PLAN_ID }]));
}

describe('dr routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of [selectMock, insertMock, updateMock, deleteMock]) {
      mock.mockReset();
      mock.mockImplementation(() => chainMock([]));
    }
    permissionsState = null;
    classifyDrExecutionAuthorizationErrorMock.mockReturnValue(null);
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
      principal: { kind: 'user_session' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/dr', drRoutes);
  });

  it('returns an empty DR plan list', async () => {
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/dr/plans', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it('creates a DR plan', async () => {
    insertMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Primary Site Failover',
      description: 'Recover critical workloads',
      status: 'draft',
      rpoTargetMinutes: 15,
      rtoTargetMinutes: 60,
      createdBy: 'user-123',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      updatedAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));

    const res = await app.request('/dr/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Primary Site Failover',
        description: 'Recover critical workloads',
        rpoTargetMinutes: 15,
        rtoTargetMinutes: 60,
      }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).data.id).toBe(PLAN_ID);
  });

  it('adds a group to a DR plan', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Primary Site Failover',
      status: 'draft',
    }]));
    // device-ownership check returns the assigned device as owned by this org
    selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID }]));
    queuePlanWriteReads();
    queueRevisionMove();
    insertMock.mockReturnValueOnce(chainMock([{
      id: GROUP_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      name: 'Tier 1 Apps',
      sequence: 1,
      devices: [DEVICE_ID],
      restoreConfig: {},
      estimatedDurationMinutes: 30,
    }]));

    const res = await app.request(`/dr/plans/${PLAN_ID}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Tier 1 Apps',
        sequence: 1,
        devices: [DEVICE_ID],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(GROUP_ID);
    expect(body.data.planId).toBe(PLAN_ID);
  });

  it('creates a DR execution', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Primary Site Failover',
      status: 'active',
    }]));
    createDrExecutionAndEnqueueMock.mockResolvedValueOnce({
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'pending',
      startedAt: new Date('2026-03-29T00:00:00.000Z'),
      initiatedBy: 'user-123',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
    });

    const res = await app.request(`/dr/plans/${PLAN_ID}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ executionType: 'rehearsal' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(EXECUTION_ID);
    expect(body.data.executionType).toBe('rehearsal');
    expect(createDrExecutionAndEnqueueMock).toHaveBeenCalledWith({
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      initiatedBy: 'user-123',
      auth: authState,
      validateDefinition: expect.any(Function),
    });
  });

  it('should get single plan with groups', async () => {
    // First select returns the plan
    selectMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Primary Site Failover',
      description: 'Recover critical workloads',
      status: 'active',
      rpoTargetMinutes: 15,
      rtoTargetMinutes: 60,
      createdBy: 'user-123',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      updatedAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));
    // Second select returns the groups
    selectMock.mockReturnValueOnce(chainMock([{
      id: GROUP_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      name: 'Tier 1 Apps',
      sequence: 1,
      devices: [DEVICE_ID],
    }]));

    const res = await app.request(`/dr/plans/${PLAN_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(PLAN_ID);
    expect(body.data.groups).toHaveLength(1);
    expect(body.data.groups[0].id).toBe(GROUP_ID);
  });

  it('should update plan', async () => {
    // First select verifies the plan exists
    selectMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Primary Site Failover',
      status: 'draft',
    }]));
    queuePlanWriteReads();
    // Update returns the updated plan
    updateMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Updated Plan Name',
      description: 'New description',
      status: 'active',
      rpoTargetMinutes: 10,
      rtoTargetMinutes: 30,
      createdBy: 'user-123',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      updatedAt: new Date('2026-03-29T01:00:00.000Z'),
    }]));

    const res = await app.request(`/dr/plans/${PLAN_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Updated Plan Name', status: 'active' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Updated Plan Name');
    expect(body.data.status).toBe('active');
  });

  it('should archive plan on delete', async () => {
    // First select verifies the plan exists
    selectMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Primary Site Failover',
      status: 'active',
    }]));
    queuePlanWriteReads();
    // Update sets status to archived
    updateMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Primary Site Failover',
      status: 'archived',
      updatedAt: new Date('2026-03-29T01:00:00.000Z'),
    }]));

    const res = await app.request(`/dr/plans/${PLAN_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('archived');
  });

  it('should update recovery group', async () => {
    // First select verifies the group exists
    selectMock.mockReturnValueOnce(chainMock([{
      id: GROUP_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      name: 'Tier 1 Apps',
      sequence: 1,
    }]));
    queuePlanWriteReads();
    // Update returns updated group
    updateMock.mockReturnValueOnce(chainMock([{
      id: GROUP_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      name: 'Tier 1 Critical',
      sequence: 2,
      devices: [DEVICE_ID],
    }]));
    queueRevisionMove();

    const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Tier 1 Critical', sequence: 2 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Tier 1 Critical');
    expect(body.data.sequence).toBe(2);
  });

  it('should delete recovery group', async () => {
    // First select verifies the group exists
    selectMock.mockReturnValueOnce(chainMock([{
      id: GROUP_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
    }]));
    queuePlanWriteReads();
    deleteMock.mockReturnValueOnce(chainMock([{ id: GROUP_ID }]));
    queueRevisionMove();

    const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('returns DR execution history', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'completed',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));

    const res = await app.request('/dr/executions', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(EXECUTION_ID);
  });

  it('should get single execution', async () => {
    // First select returns the execution
    selectMock.mockReturnValueOnce(chainMock([{
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'running',
      startedAt: new Date('2026-03-29T00:00:00.000Z'),
      initiatedBy: 'user-123',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));
    // Second select returns the plan
    selectMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Primary Site Failover',
      status: 'active',
    }]));
    // Third select returns the groups
    selectMock.mockReturnValueOnce(chainMock([{
      id: GROUP_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      name: 'Tier 1 Apps',
      sequence: 1,
    }]));

    const res = await app.request(`/dr/executions/${EXECUTION_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(EXECUTION_ID);
    expect(body.data.plan.id).toBe(PLAN_ID);
    expect(body.data.groups).toHaveLength(1);
  });

  it('should abort a running execution', async () => {
    // First select returns the execution
    selectMock.mockReturnValueOnce(chainMock([{
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'running',
      startedAt: new Date('2026-03-29T00:00:00.000Z'),
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));
    // Update returns the aborted execution
    updateMock.mockReturnValueOnce(chainMock([{
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'aborted',
      completedAt: new Date('2026-03-29T01:00:00.000Z'),
    }]));

    const res = await app.request(`/dr/executions/${EXECUTION_ID}/abort`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('aborted');
  });

  it('rejects group create with a foreign-org device', async () => {
    // plan exists and belongs to org
    selectMock.mockReturnValueOnce(chainMock([{
      id: PLAN_ID,
      orgId: ORG_ID,
      name: 'Primary Site Failover',
      status: 'draft',
    }]));
    // device-ownership check returns 0 rows: device is not in this org
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request(`/dr/plans/${PLAN_ID}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Tier 1 Apps',
        devices: [DEVICE_ID],
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('do not belong to this organization');
    // must not persist the foreign device
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects group update with a foreign-org device', async () => {
    // group exists and belongs to org
    selectMock.mockReturnValueOnce(chainMock([{
      id: GROUP_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      name: 'Tier 1 Apps',
      sequence: 1,
    }]));
    // device-ownership check returns 0 rows: device is not in this org
    selectMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ devices: [DEVICE_ID] }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('do not belong to this organization');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('allows group update that does not change devices (no ownership check)', async () => {
    // group exists and belongs to org
    selectMock.mockReturnValueOnce(chainMock([{
      id: GROUP_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      name: 'Tier 1 Apps',
      sequence: 1,
    }]));
    queuePlanWriteReads();
    updateMock.mockReturnValueOnce(chainMock([{
      id: GROUP_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      name: 'Renamed',
      sequence: 1,
    }]));
    queueRevisionMove();

    const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ name: 'Renamed' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Renamed');
    // the group-existence select plus the plan write path's lock and
    // execution check; no device-ownership select
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it('should reject aborting a completed execution', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'completed',
      startedAt: new Date('2026-03-29T00:00:00.000Z'),
      completedAt: new Date('2026-03-29T01:00:00.000Z'),
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));

    const res = await app.request(`/dr/executions/${EXECUTION_ID}/abort`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Cannot abort execution');
  });

  // ── Site scoping (#3653) ──────────────────────────────────────────────────
  //
  // RLS enforces the ORG axis only. The SITE axis is app-layer, so these routes
  // are the sole barrier between a site-restricted technician and another
  // site's disaster-recovery configuration.
  describe('site scoping', () => {
    /** Rows the org+site lookup returns for the ids a handler asks about. */
    const deviceRows = [
      { id: DEVICE_ID, siteId: SITE_A },
      { id: OUT_OF_SITE_DEVICE_ID, siteId: SITE_B },
    ];

    function restrictToSiteA() {
      permissionsState = { allowedSiteIds: [SITE_A] };
    }

    it('rejects a group create that includes an out-of-site device', async () => {
      restrictToSiteA();
      selectMock.mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]));
      selectMock.mockReturnValueOnce(chainMock(deviceRows));

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Tier 1', devices: [DEVICE_ID, OUT_OF_SITE_DEVICE_ID] }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('site_access_denied');
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('allows a group create whose devices are all inside the caller sites', async () => {
      restrictToSiteA();
      selectMock.mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]));
      selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]));
      queuePlanWriteReads();
      queueRevisionMove();
      insertMock.mockReturnValueOnce(chainMock([{ id: GROUP_ID, planId: PLAN_ID, orgId: ORG_ID }]));

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Tier 1', devices: [DEVICE_ID] }),
      });

      expect(res.status).toBe(201);
      expect(insertMock).toHaveBeenCalled();
    });

    // The bypass that makes "validate the submitted array" insufficient: every
    // id the caller submits is inside their grant, yet the write silently drops
    // the out-of-site device already stored on the group.
    it('rejects a group update that silently drops a stored out-of-site device', async () => {
      restrictToSiteA();
      selectMock.mockReturnValueOnce(chainMock([{
        id: GROUP_ID,
        planId: PLAN_ID,
        orgId: ORG_ID,
        devices: [DEVICE_ID, OUT_OF_SITE_DEVICE_ID],
      }]));
      selectMock.mockReturnValueOnce(chainMock(deviceRows));

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ devices: [DEVICE_ID] }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('site_access_denied');
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('rejects deleting a group that holds an out-of-site device', async () => {
      restrictToSiteA();
      selectMock.mockReturnValueOnce(chainMock([{
        id: GROUP_ID,
        devices: [DEVICE_ID, OUT_OF_SITE_DEVICE_ID],
      }]));
      selectMock.mockReturnValueOnce(chainMock(deviceRows));

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('site_access_denied');
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('rejects archiving a plan whose groups span sites the caller cannot reach', async () => {
      restrictToSiteA();
      selectMock.mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]));
      selectMock.mockReturnValueOnce(chainMock([{ devices: [DEVICE_ID, OUT_OF_SITE_DEVICE_ID] }]));
      selectMock.mockReturnValueOnce(chainMock(deviceRows));

      const res = await app.request(`/dr/plans/${PLAN_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('site_access_denied');
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('rejects updating a plan whose groups span sites the caller cannot reach', async () => {
      restrictToSiteA();
      selectMock.mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]));
      selectMock.mockReturnValueOnce(chainMock([{ devices: [DEVICE_ID, OUT_OF_SITE_DEVICE_ID] }]));
      selectMock.mockReturnValueOnce(chainMock(deviceRows));

      const res = await app.request(`/dr/plans/${PLAN_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ status: 'archived' }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('site_access_denied');
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('rejects aborting a recovery that targets out-of-site devices', async () => {
      restrictToSiteA();
      selectMock.mockReturnValueOnce(chainMock([{
        id: EXECUTION_ID,
        planId: PLAN_ID,
        orgId: ORG_ID,
        status: 'running',
      }]));
      selectMock.mockReturnValueOnce(chainMock([{ devices: [DEVICE_ID, OUT_OF_SITE_DEVICE_ID] }]));
      selectMock.mockReturnValueOnce(chainMock(deviceRows));

      const res = await app.request(`/dr/executions/${EXECUTION_ID}/abort`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('site_access_denied');
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('allows aborting a recovery confined to the caller sites', async () => {
      restrictToSiteA();
      selectMock.mockReturnValueOnce(chainMock([{
        id: EXECUTION_ID,
        planId: PLAN_ID,
        orgId: ORG_ID,
        status: 'running',
      }]));
      selectMock.mockReturnValueOnce(chainMock([{ devices: [DEVICE_ID] }]));
      selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]));
      updateMock.mockReturnValueOnce(chainMock([{ id: EXECUTION_ID, status: 'aborted' }]));

      const res = await app.request(`/dr/executions/${EXECUTION_ID}/abort`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe('aborted');
    });

    // The stored guard runs first, so a group whose stored membership is fully
    // in-site must still have its PROPOSED additions checked. Without this the
    // proposed guard could be deleted and every other test would stay green.
    it('rejects a group update that adds an out-of-site device', async () => {
      restrictToSiteA();
      selectMock.mockReturnValueOnce(chainMock([{
        id: GROUP_ID,
        planId: PLAN_ID,
        orgId: ORG_ID,
        devices: [DEVICE_ID],
      }]));
      selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]));
      selectMock.mockReturnValueOnce(chainMock([{ id: OUT_OF_SITE_DEVICE_ID, siteId: SITE_B }]));

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ devices: [OUT_OF_SITE_DEVICE_ID] }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('site_access_denied');
      expect(updateMock).not.toHaveBeenCalled();
    });

    // An empty grant is the most locked-down state and the one a truthiness
    // slip (`!allowedSiteIds`) would silently turn into "unrestricted".
    it('denies a technician granted zero sites', async () => {
      permissionsState = { allowedSiteIds: [] };
      selectMock.mockReturnValueOnce(chainMock([{ id: GROUP_ID, devices: [DEVICE_ID] }]));
      selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]));

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('site_access_denied');
      expect(deleteMock).not.toHaveBeenCalled();
    });

    // authorizeStoredDevices deliberately omits the row-count parity check that
    // authorizeProposedDevices has: an id whose device row is gone cannot be a
    // restore target, and must not wedge maintenance of the group holding it.
    it('does not let a deleted device block maintenance of its group', async () => {
      restrictToSiteA();
      const deletedDeviceId = '44444444-4444-4444-8444-444444444444';
      selectMock.mockReturnValueOnce(chainMock([{
        id: GROUP_ID,
        devices: [DEVICE_ID, deletedDeviceId],
      }]));
      selectMock.mockReturnValueOnce(chainMock([{ id: DEVICE_ID, siteId: SITE_A }]));
      queuePlanWriteReads();
      queueRevisionMove();
      deleteMock.mockReturnValueOnce(chainMock([{ id: GROUP_ID }]));

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(deleteMock).toHaveBeenCalled();
    });

    // A device outside the org must report the org mismatch, never the site
    // grant — the site verdict would confirm the id exists somewhere in-org.
    it('reports an org mismatch ahead of the site grant', async () => {
      restrictToSiteA();
      const foreignDeviceId = '55555555-5555-4555-8555-555555555555';
      selectMock.mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]));
      selectMock.mockReturnValueOnce(chainMock([]));

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Tier 1', devices: [foreignDeviceId] }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/do not belong to this organization/);
      expect(insertMock).not.toHaveBeenCalled();
    });

    // An unrestricted principal must not pay for the site barrier, and must not
    // change behaviour: no extra lookup beyond the group existence check.
    it('costs an unrestricted caller no additional device lookup', async () => {
      selectMock.mockReturnValueOnce(chainMock([{ id: GROUP_ID, devices: [OUT_OF_SITE_DEVICE_ID] }]));
      queuePlanWriteReads();
      queueRevisionMove();
      deleteMock.mockReturnValueOnce(chainMock([{ id: GROUP_ID }]));

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      // the group existence check plus the plan write path's lock, execution
      // check and dependent-group check; no device lookup
      expect(selectMock).toHaveBeenCalledTimes(4);
    });
  });

  // ── W05b Task 7: BARE_METAL_REBUILD needs BACKUP_WRITE on the trigger ────
  describe('execution trigger with a BARE_METAL_REBUILD group', () => {
    const bmrGroup = { id: GROUP_ID, planId: PLAN_ID, orgId: ORG_ID, devices: [DEVICE_ID], restoreConfig: { commandType: 'BARE_METAL_REBUILD' } };

    it('returns 403 when the caller lacks backup:write', async () => {
      permissionsState = { allowedSiteIds: null, permissions: [{ resource: 'devices', action: 'execute' }] } as any;
      selectMock
        .mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]))
        .mockReturnValueOnce(chainMock([bmrGroup]));

      const res = await app.request(`/dr/plans/${PLAN_ID}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ executionType: 'failover' }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('backup_write_required');
      expect(createDrExecutionAndEnqueueMock).not.toHaveBeenCalled();
    });

    it('proceeds (201) when the caller holds backup:write', async () => {
      permissionsState = { allowedSiteIds: null, permissions: [{ resource: 'devices', action: 'execute' }, { resource: 'backup', action: 'write' }] } as any;
      selectMock
        .mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]))
        .mockReturnValueOnce(chainMock([bmrGroup]));
      createDrExecutionAndEnqueueMock.mockImplementationOnce(async (input: any) => {
        await input.validateDefinition([bmrGroup]);
        return { id: EXECUTION_ID, planId: PLAN_ID, orgId: ORG_ID, executionType: 'failover', status: 'pending' };
      });

      const res = await app.request(`/dr/plans/${PLAN_ID}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ executionType: 'failover' }),
      });

      expect(res.status).toBe(201);
    });

    it('checks backup:write against the definition the execution captured', async () => {
      permissionsState = { allowedSiteIds: null, permissions: [{ resource: 'devices', action: 'execute' }] } as any;
      selectMock
        .mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]))
        .mockReturnValueOnce(chainMock([{ ...bmrGroup, restoreConfig: { commandType: 'vm_restore_from_backup' } }]));
      let captured: unknown;
      createDrExecutionAndEnqueueMock.mockImplementationOnce(async (input: any) => {
        captured = await Promise.resolve(input.validateDefinition([bmrGroup])).then(() => 'allowed', (e: unknown) => e);
        throw captured;
      });
      classifyDrExecutionAuthorizationErrorMock.mockImplementation(((error: any) =>
        error?.code === 'backup_write_required' ? { status: 403, code: 'backup_write_required' } : null) as any);

      const res = await app.request(`/dr/plans/${PLAN_ID}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ executionType: 'failover' }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('backup_write_required');
    });

    it('does not require backup:write for a plan without the step', async () => {
      permissionsState = { allowedSiteIds: null, permissions: [{ resource: 'devices', action: 'execute' }] } as any;
      selectMock
        .mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]))
        .mockReturnValueOnce(chainMock([{ ...bmrGroup, restoreConfig: { commandType: 'vm_restore_from_backup' } }]));
      createDrExecutionAndEnqueueMock.mockResolvedValueOnce({ id: EXECUTION_ID, planId: PLAN_ID, orgId: ORG_ID, executionType: 'failover', status: 'pending' });

      const res = await app.request(`/dr/plans/${PLAN_ID}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ executionType: 'failover' }),
      });

      expect(res.status).toBe(201);
    });
  });

  // Every plan and group write goes through drPlanWrites: the plan row is
  // locked (execution creation takes the same lock), the write is refused
  // while an execution is pending or running, and the plan revision moves.
  describe('plan and group writes under an active execution', () => {
    const planRow = { id: PLAN_ID, orgId: ORG_ID, name: 'Primary Site Failover', status: 'active' };
    const groupRow = { id: GROUP_ID, planId: PLAN_ID, orgId: ORG_ID, name: 'Tier 1 Apps', sequence: 1, devices: [] };
    // [method, path, body, the route's own reads before the write path]
    const WRITES = [
      ['POST', `/dr/plans/${PLAN_ID}/groups`, { name: 'Tier 2' }, [[planRow]]],
      ['PATCH', `/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, { devices: [DEVICE_ID] }, [[groupRow], [{ id: DEVICE_ID, siteId: null }]]],
      ['DELETE', `/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, undefined, [[groupRow]]],
      ['PATCH', `/dr/plans/${PLAN_ID}`, { name: 'Renamed' }, [[planRow]]],
      ['DELETE', `/dr/plans/${PLAN_ID}`, undefined, [[planRow]]],
    ] as const;

    function send(method: string, path: string, body: unknown) {
      return app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    function queueReads(routeReads: readonly (readonly unknown[])[], lockChain: unknown, active: unknown[]) {
      selectMock.mockReset();
      for (const rows of routeReads) selectMock.mockReturnValueOnce(chainMock([...rows]));
      selectMock
        .mockReturnValueOnce(lockChain as any)
        .mockReturnValueOnce(chainMock(active))
        .mockImplementation(() => chainMock([]));
    }

    it.each(WRITES)('%s %s is refused while an execution is pending or running', async (method, path, body, routeReads) => {
      const lockChain = chainMock([{ id: PLAN_ID, orgId: ORG_ID }]);
      queueReads(routeReads, lockChain, [{ id: EXECUTION_ID }]);

      const res = await send(method, path, body);

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('dr_plan_execution_in_progress');
      expect(lockChain.for).toHaveBeenCalledWith('update');
      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it.each(WRITES)('%s %s moves the plan revision with the write', async (method, path, body, routeReads) => {
      const lockChain = chainMock([{ id: PLAN_ID, orgId: ORG_ID }]);
      queueReads(routeReads, lockChain, []);
      insertMock.mockReturnValueOnce(chainMock([groupRow]));
      deleteMock.mockReturnValueOnce(chainMock([groupRow]));
      const planSets: Array<Record<string, unknown>> = [];
      updateMock.mockImplementation(((table: { id?: string }) => {
        const isPlan = table?.id === 'dr_plans.id';
        const chain = chainMock([isPlan ? planRow : groupRow]);
        const set = chain.set;
        chain.set = vi.fn((values: Record<string, unknown>) => {
          if (isPlan) planSets.push(values);
          return set(values);
        });
        return chain;
      }) as any);

      const res = await send(method, path, body);

      expect(res.status).toBeLessThan(300);
      expect(lockChain.for).toHaveBeenCalledWith('update');
      expect(planSets.some((values) => values.updatedAt instanceof Date)).toBe(true);
    });
  });

  // A group's predecessor must be another group of the same plan, checked by
  // drPlanWrites under the plan lock; a group others depend on is not deleted.
  describe('recovery group dependencies', () => {
    const OTHER_GROUP_ID = '99999999-9999-4999-8999-999999999999';
    const planRow = { id: PLAN_ID, orgId: ORG_ID, name: 'Primary Site Failover', status: 'active' };
    const groupRow = { id: GROUP_ID, planId: PLAN_ID, orgId: ORG_ID, name: 'Tier 1 Apps', sequence: 1, devices: [] };

    it.each([
      ['POST', `/dr/plans/${PLAN_ID}/groups`, { name: 'Tier 2', dependsOnGroupId: OTHER_GROUP_ID }, planRow],
      ['PATCH', `/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, { dependsOnGroupId: OTHER_GROUP_ID }, groupRow],
    ] as const)('%s %s refuses a predecessor that is not a group of the same plan', async (method, path, body, first) => {
      selectMock.mockReturnValueOnce(chainMock([first]));
      queuePlanWriteReads();
      selectMock.mockReturnValueOnce(chainMock([])); // predecessor lookup in this plan and org finds nothing

      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify(body),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_group_dependency');
      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('refuses to delete a group another group depends on', async () => {
      selectMock.mockReturnValueOnce(chainMock([groupRow]));
      queuePlanWriteReads();
      selectMock.mockReturnValueOnce(chainMock([{ id: OTHER_GROUP_ID }])); // a dependent group

      const res = await app.request(`/dr/plans/${PLAN_ID}/groups/${GROUP_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('dr_plan_group_has_dependents');
      expect(deleteMock).not.toHaveBeenCalled();
    });
  });

  describe('execution responses', () => {
    const stored = {
      id: EXECUTION_ID, planId: PLAN_ID, orgId: ORG_ID, executionType: 'rehearsal', status: 'running',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      results: { dispatchStatus: 'running', groupResults: [], definition: { version: 1, groups: [{ devices: [DEVICE_ID] }] } },
    };

    it('keep the stored execution definition out of the list, detail, start and abort bodies', async () => {
      selectMock.mockReturnValueOnce(chainMock([stored]));
      const list = await (await app.request('/dr/executions', { headers: { Authorization: 'Bearer token' } })).json();
      expect(list.data[0].results).toEqual({ dispatchStatus: 'running', groupResults: [] });

      selectMock
        .mockReturnValueOnce(chainMock([stored]))
        .mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID }]))
        .mockReturnValueOnce(chainMock([]));
      const detail = await (await app.request(`/dr/executions/${EXECUTION_ID}`, { headers: { Authorization: 'Bearer token' } })).json();
      expect(detail.data.results).toEqual({ dispatchStatus: 'running', groupResults: [] });

      selectMock.mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]));
      createDrExecutionAndEnqueueMock.mockResolvedValueOnce(stored);
      const started = await (await app.request(`/dr/plans/${PLAN_ID}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ executionType: 'rehearsal' }),
      })).json();
      expect(started.data.results).toEqual({ dispatchStatus: 'running', groupResults: [] });

      selectMock.mockReturnValueOnce(chainMock([stored]));
      updateMock.mockReturnValueOnce(chainMock([{ ...stored, status: 'aborted' }]));
      const aborted = await (await app.request(`/dr/executions/${EXECUTION_ID}/abort`, {
        method: 'POST', headers: { Authorization: 'Bearer token' },
      })).json();
      expect(aborted.data.results).toEqual({ dispatchStatus: 'running', groupResults: [] });
    });
  });

  // ── Execution authorization errors (#3653) ────────────────────────────────
  describe('execution authorization failures', () => {
    it('reports a site-denied execution as 403 rather than a 500', async () => {
      selectMock.mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]));
      createDrExecutionAndEnqueueMock.mockRejectedValueOnce(new Error('site_access_denied'));
      classifyDrExecutionAuthorizationErrorMock.mockReturnValue({
        status: 403,
        code: 'site_access_denied',
      });

      const res = await app.request(`/dr/plans/${PLAN_ID}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ executionType: 'failover' }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('site_access_denied');
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    });

    // Only recognised authorization denials may be converted. A genuine fault
    // must keep propagating, or this catch would swallow real breakage.
    it('rethrows an unrecognised execution failure', async () => {
      selectMock.mockReturnValueOnce(chainMock([{ id: PLAN_ID, orgId: ORG_ID, status: 'active' }]));
      createDrExecutionAndEnqueueMock.mockRejectedValueOnce(new Error('redis is on fire'));
      classifyDrExecutionAuthorizationErrorMock.mockReturnValue(null);

      const res = await app.request(`/dr/plans/${PLAN_ID}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ executionType: 'failover' }),
      });

      expect(res.status).toBe(500);
    });
  });
});
