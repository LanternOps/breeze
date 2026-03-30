import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { drRoutes } from './dr';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLAN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXECUTION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

vi.mock('../services', () => ({}));

const writeRouteAuditMock = vi.fn();

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit', 'returning', 'values', 'set']) {
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
};

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
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
  },
  drExecutions: {
    id: 'dr_executions.id',
    orgId: 'dr_executions.org_id',
    planId: 'dr_executions.plan_id',
    createdAt: 'dr_executions.created_at',
    status: 'dr_executions.status',
  },
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../middleware/auth';

describe('dr routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState = {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    });
    app = new Hono();
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
    insertMock.mockReturnValueOnce(chainMock([{
      id: EXECUTION_ID,
      planId: PLAN_ID,
      orgId: ORG_ID,
      executionType: 'rehearsal',
      status: 'pending',
      startedAt: new Date('2026-03-29T00:00:00.000Z'),
      initiatedBy: 'user-123',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));

    const res = await app.request(`/dr/plans/${PLAN_ID}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ executionType: 'rehearsal' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe(EXECUTION_ID);
    expect(body.data.executionType).toBe('rehearsal');
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
});
