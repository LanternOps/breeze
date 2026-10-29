import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { groupRoutes } from './groups';

const GROUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SITE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SITE_ID_2 = '12121212-1212-4121-8121-121212121212';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/filterEngine', () => ({
  evaluateFilterWithPreview: vi.fn().mockResolvedValue({
    totalCount: 1,
    devices: [{
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      hostname: 'host-1',
      displayName: 'Host One',
      osType: 'windows',
      status: 'online',
      lastSeenAt: new Date('2026-01-01')
    }],
    evaluatedAt: new Date('2026-01-01')
  }),
  extractFieldsFromFilter: vi.fn().mockReturnValue(['osType']),
  validateFilter: vi.fn().mockReturnValue({ valid: true, errors: [] })
}));

vi.mock('../services/groupMembership', async () => {
  const actual = await vi.importActual<typeof import('../services/groupMembership')>(
    '../services/groupMembership'
  );
  return {
    evaluateGroupMembership: vi.fn().mockResolvedValue(undefined),
    pinDeviceToGroup: vi.fn().mockResolvedValue(undefined),
    pruneGroupMembershipsOutsideSite: vi.fn().mockResolvedValue(undefined),
    // Real: the extracted tenancy guard + membership insert that group-create
    // (#3159) and POST /:id/devices now share. These tests are that logic's
    // coverage, exercised against the already-mocked `../db` / `../db/schema`.
    validateManualMembershipDevices: actual.validateManualMembershipDevices,
    addManualGroupMemberships: actual.addManualGroupMemberships
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  deviceGroups: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    name: 'name',
    type: 'type',
    rules: 'rules',
    filterConditions: 'filterConditions',
    filterFieldsUsed: 'filterFieldsUsed',
    parentId: 'parentId',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  },
  deviceGroupMemberships: {
    deviceId: 'deviceId',
    groupId: 'groupId',
    isPinned: 'isPinned',
    addedAt: 'addedAt',
    addedBy: 'addedBy'
  },
  devices: {
    id: 'id',
    orgId: 'orgId',
    hostname: 'hostname',
    displayName: 'displayName',
    status: 'status',
    osType: 'osType'
  },
  sites: {
    id: 'id',
    orgId: 'orgId'
  },
  configPolicyAssignments: {
    id: 'id',
    configPolicyId: 'configPolicyId',
    level: 'level',
    targetId: 'targetId',
    priority: 'priority',
    createdAt: 'createdAt',
  },
  configurationPolicies: {
    id: 'id',
    name: 'name',
    status: 'status',
  },
  groupMembershipLog: {
    id: 'id',
    groupId: 'groupId',
    deviceId: 'deviceId',
    action: 'action',
    reason: 'reason',
    createdAt: 'createdAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { writeRouteAudit } from '../services/auditEvents';
import { authMiddleware } from '../middleware/auth';
import { validateFilter } from '../services/filterEngine';
import { evaluateGroupMembership } from '../services/groupMembership';

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: GROUP_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    siteId: null,
    name: 'Test Group',
    type: 'dynamic',
    rules: { legacy: true },
    filterConditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] },
    filterFieldsUsed: [],
    parentId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides
  };
}



function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(), where: vi.fn(), innerJoin: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  for (const method of ['from', 'where', 'innerJoin', 'orderBy', 'limit'] as const) chain[method].mockReturnValue(chain);
  return chain;
}

describe('partner-owned group reads and write refusals', () => {
  let app: Hono;
  const setScope = (scope: 'organization' | 'partner' | 'system') => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', { scope, orgId: ORG_ID, partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID], canAccessOrg: () => true });
      return next();
    });
  };
  beforeEach(() => {
    vi.resetAllMocks();
    setScope('organization');
    app = new Hono();
    app.route('/groups', groupRoutes);
  });

  it('org scope GET /:id of a partner group of its own partner returns name, partnerId, orgId null; filterConditions and rules are null', async () => {
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never)
      .mockReturnValueOnce(query([{ count: 2 }]) as never)
      .mockReturnValueOnce(query([]) as never);
    const res = await app.request(`/groups/${GROUP_ID}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ name: 'Test Group', partnerId: PARTNER_ID, orgId: null, filterConditions: null, rules: null });
  });

  it("org scope GET /:id of another partner's group returns 404", async () => {
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup({ partnerId: ORG_ID_2 })]) as never);
    const res = await app.request(`/groups/${GROUP_ID}`);
    expect(res.status).toBe(404);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('partner scope GET /:id returns the filter', async () => {
    setScope('partner');
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never)
      .mockReturnValueOnce(query([{ count: 2 }]) as never)
      .mockReturnValueOnce(query([]) as never);
    const res = await app.request(`/groups/${GROUP_ID}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ filterConditions: makeGroup().filterConditions, rules: makeGroup().rules });
  });

  it.each([
    ['PATCH', '', { name: 'Updated' }],
    ['DELETE', '', undefined],
    ['POST', '/devices', { deviceIds: [DEVICE_ID] }],
    ['DELETE', `/devices/${DEVICE_ID}`, undefined],
    ['POST', `/devices/${DEVICE_ID}/pin`, undefined],
    ['DELETE', `/devices/${DEVICE_ID}/pin`, undefined],
    ['POST', '/preview', undefined],
  ])('%s /:id%s refuses partner groups with PARTNER_GROUP_READ_ONLY before any write', async (method, suffix, body) => {
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    const res = await app.request(`/groups/${GROUP_ID}${suffix}`, {
      method: String(method), headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PARTNER_GROUP_READ_ONLY' });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(evaluateGroupMembership).not.toHaveBeenCalled();
  });

  it('GET /:id/devices includes an orgId column', async () => {
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never)
      .mockReturnValueOnce(query([{ deviceId: DEVICE_ID, orgId: ORG_ID, hostname: 'host', addedAt: new Date('2026-01-01') }]) as never);
    const res = await app.request(`/groups/${GROUP_ID}/devices`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([expect.objectContaining({ deviceId: DEVICE_ID, orgId: ORG_ID })]);
    expect(db.select).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: 'orgId' }));
  });
});
