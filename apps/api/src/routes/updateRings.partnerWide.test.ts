import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef, selectResult, insertResult, updateResult, dbInsertMock, dbUpdateMock } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as const,
      partnerId: 'p-1' as string | null,
      partnerOrgAccess: 'all' as 'all' | 'selected' | 'none' | null | undefined,
      orgId: null as string | null,
      accessibleOrgIds: [] as string[],
      canAccessOrg: (_orgId: string) => false,
      user: { id: 'u-1', email: 'admin@example.com' },
    },
  },
  selectResult: vi.fn(),
  insertResult: vi.fn(),
  updateResult: vi.fn(),
  dbInsertMock: vi.fn(),
  dbUpdateMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => selectResult()) })),
      })),
    })),
    insert: dbInsertMock,
    update: dbUpdateMock,
  },
}));

vi.mock('../db/schema', () => ({
  patchPolicies: {
    id: 'id', partnerId: 'partnerId', name: 'name', description: 'description', enabled: 'enabled',
    ringOrder: 'ringOrder', deferralDays: 'deferralDays', deadlineDays: 'deadlineDays',
    gracePeriodHours: 'gracePeriodHours', categories: 'categories', excludeCategories: 'excludeCategories',
    autoApprove: 'autoApprove', categoryRules: 'categoryRules', targets: 'targets',
    createdAt: 'createdAt', updatedAt: 'updatedAt', createdBy: 'createdBy', kind: 'kind',
  },
  patchApprovals: { partnerId: 'partnerId', ringId: 'ringId', status: 'status' },
  patchJobs: { id: 'id', ringId: 'ringId', name: 'name', status: 'status', createdAt: 'createdAt' },
  patches: {},
  devicePatches: {},
}));

vi.mock('./updateRingsHelpers', () => ({
  resolveRingDeviceCounts: vi.fn().mockResolvedValue(new Map()),
  resolveRingDeviceIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
}));

import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { updateRingRoutes } from './updateRings';

const RING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setPartnerOrgAccess(partnerOrgAccess: 'all' | 'selected') {
  authRef.current = {
    scope: 'partner',
    partnerId: 'p-1',
    partnerOrgAccess,
    orgId: null,
    accessibleOrgIds: [],
    canAccessOrg: () => false,
    user: { id: 'u-1', email: 'admin@example.com' },
  };
}

function makeRing(overrides: Record<string, unknown> = {}) {
  return {
    id: RING_ID,
    partnerId: 'p-1',
    name: 'Pilot Ring',
    description: null,
    enabled: true,
    ringOrder: 1,
    deferralDays: 7,
    deadlineDays: null,
    gracePeriodHours: 4,
    categories: [],
    excludeCategories: [],
    autoApprove: {},
    categoryRules: [],
    targets: {},
    ...overrides,
  };
}

function makeApp() {
  const app = new Hono();
  app.route('/update-rings', updateRingRoutes);
  return app;
}

function createRequest(app: Hono) {
  return app.request('/update-rings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Pilot Ring', deferralDays: 7 }),
  });
}

function patchRequest(app: Hono) {
  return app.request(`/update-rings/${RING_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Updated Ring' }),
  });
}

function deleteRequest(app: Hono) {
  return app.request(`/update-rings/${RING_ID}`, { method: 'DELETE' });
}

describe('update rings partner-wide capability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPartnerOrgAccess('all');
    selectResult.mockResolvedValue([makeRing()]);
    insertResult.mockResolvedValue([makeRing()]);
    updateResult.mockResolvedValue([makeRing({ name: 'Updated Ring' })]);
    dbInsertMock.mockImplementation(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => insertResult()) })),
    }));
    dbUpdateMock.mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => {
          const result = {
            returning: vi.fn(() => updateResult()),
            then: (resolve: (value: undefined) => unknown) => Promise.resolve(undefined).then(resolve),
          };
          return result;
        }),
      })),
    }));
  });

  it('POST / returns 403 for selected partner access', async () => {
    setPartnerOrgAccess('selected');

    const res = await createRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbInsertMock).not.toHaveBeenCalled();
  });

  it('POST / succeeds for all partner access', async () => {
    const res = await createRequest(makeApp());

    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe(RING_ID);
    expect(dbInsertMock).toHaveBeenCalledOnce();
  });

  it('PATCH /:id returns 403 for selected partner access', async () => {
    setPartnerOrgAccess('selected');

    const res = await patchRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('PATCH /:id succeeds for all partner access', async () => {
    const res = await patchRequest(makeApp());

    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('Updated Ring');
    expect(dbUpdateMock).toHaveBeenCalledOnce();
  });

  it('DELETE /:id returns 403 for selected partner access', async () => {
    setPartnerOrgAccess('selected');

    const res = await deleteRequest(makeApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('DELETE /:id succeeds for all partner access', async () => {
    const res = await deleteRequest(makeApp());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(dbUpdateMock).toHaveBeenCalledOnce();
  });
});
