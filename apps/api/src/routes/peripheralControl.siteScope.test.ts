import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authRef } = vi.hoisted(() => ({ authRef: { current: {} as any } }));

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  peripheralDeviceClassEnum: { enumValues: ['storage', 'all_usb', 'bluetooth', 'thunderbolt'] },
  peripheralEventTypeEnum: { enumValues: ['connected', 'disconnected', 'blocked', 'mounted_read_only', 'policy_override'] },
  peripheralPolicyActionEnum: { enumValues: ['allow', 'block', 'read_only', 'alert'] },
  peripheralPolicyTargetTypeEnum: { enumValues: ['organization', 'site', 'group', 'device'] },
  peripheralEvents: { id: 'id', orgId: 'orgId', deviceId: 'deviceId', policyId: 'policyId', eventType: 'eventType', peripheralType: 'peripheralType', vendor: 'vendor', product: 'product', serialNumber: 'serialNumber', occurredAt: 'occurredAt', createdAt: 'createdAt' },
  peripheralPolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', name: 'name', deviceClass: 'deviceClass', action: 'action', targetType: 'targetType', priority: 'priority', targetIds: 'targetIds', isActive: 'isActive', updatedAt: 'updatedAt' },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceGroups: { id: 'deviceGroups.id', orgId: 'deviceGroups.orgId', siteId: 'deviceGroups.siteId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: vi.fn(async () => []),
  schedulePeripheralPolicyDevices: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' },
  },
  canAccessSite: () => true,
}));

import { peripheralControlRoutes } from './peripheralControl';
import { db } from '../db';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';

function orgAuth(allowedSiteIds: string[] | undefined) {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    canAccessOrg: (id: string) => id === ORG_ID,
    orgCondition: () => undefined,
    user: { id: 'user-123', email: 'test@example.com' },
  };
}

function app() {
  const instance = new Hono();
  instance.route('/peripherals', peripheralControlRoutes);
  return instance;
}

describe('peripheral policy routes site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: POST /peripherals/policies (create) denied 403, no insert', async (_label, allowedSiteIds) => {
    authRef.current = orgAuth(allowedSiteIds);
    const res = await app().request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'p', deviceClass: 'storage', action: 'block', targetType: 'organization',
      }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /peripherals/policies with id (update) denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: POLICY_ID, name: 'p', deviceClass: 'storage', action: 'block', targetType: 'organization',
      }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /peripherals/policies/:id/disable denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request(`/peripherals/policies/${POLICY_ID}/disable`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /peripherals/exceptions denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request('/peripherals/exceptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policyId: POLICY_ID, operation: 'add', exception: { vendor: '0x1234' } }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: create proceeds to insert', async () => {
    authRef.current = orgAuth(undefined);
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, name: 'p', deviceClass: 'storage', action: 'block', targetType: 'organization' }])),
      })),
    });
    const res = await app().request('/peripherals/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'p', deviceClass: 'storage', action: 'block', targetType: 'organization' }),
    });
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

// Chainable, thenable query-builder mock that records every call.
type CapturedCall = { method: string; args: unknown[] };
function chain(result: unknown, capture?: CapturedCall[]) {
  const record = (method: string) => (...args: unknown[]) => {
    capture?.push({ method, args });
    return obj;
  };
  const obj: any = {
    from: record('from'),
    where: record('where'),
    orderBy: record('orderBy'),
    limit: record('limit'),
    offset: record('offset'),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return obj;
}

function text(calls: CapturedCall[]): string {
  return JSON.stringify(calls.filter((c) => c.method === 'where').map((c) => c.args), (_k, v) =>
    typeof v === 'function' ? '[function]' : v,
  );
}

describe('peripheral policy reads for site-restricted callers', () => {
  const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const S2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const D1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
  const D2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
  const G1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
  const G2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';

  beforeEach(() => {
    vi.clearAllMocks();
    (db.select as any).mockReset();
  });

  it('list and count only include policies that reach one of the caller\'s sites', async () => {
    authRef.current = orgAuth([S1]);
    const countCalls: CapturedCall[] = [];
    const rowCalls: CapturedCall[] = [];
    (db.select as any)
      .mockReturnValueOnce(chain([{ count: 0 }], countCalls))
      .mockReturnValueOnce(chain([], rowCalls));

    const res = await app().request('/peripherals/policies');

    expect(res.status).toBe(200);
    for (const calls of [countCalls, rowCalls]) {
      const where = text(calls);
      expect(where).toContain('targetType');
      expect(where).toContain(S1);
    }
  });

  it('list narrows each policy\'s targets to the caller\'s sites', async () => {
    authRef.current = orgAuth([S1]);
    (db.select as any)
      .mockReturnValueOnce(chain([{ count: 3 }]))
      .mockReturnValueOnce(chain([
        { id: 'p-site', orgId: ORG_ID, targetType: 'site', targetIds: { siteIds: [S1, S2] } },
        { id: 'p-dev', orgId: ORG_ID, targetType: 'device', targetIds: { deviceIds: [D1, D2] } },
        { id: 'p-grp', orgId: ORG_ID, targetType: 'group', targetIds: { groupIds: [G1, G2] } },
      ]))
      // visible-device lookup, visible-group lookup
      .mockReturnValueOnce(chain([{ id: D1, siteId: S1 }, { id: D2, siteId: S2 }]))
      .mockReturnValueOnce(chain([{ id: G1, siteId: S1 }, { id: G2, siteId: S2 }]));

    const res = await app().request('/peripherals/policies');

    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.data.map((p: any) => [p.id, p.targetIds]));
    expect(byId['p-site']).toEqual({ siteIds: [S1] });
    expect(byId['p-dev']).toEqual({ deviceIds: [D1] });
    expect(byId['p-grp']).toEqual({ groupIds: [G1] });
  });

  it('detail 404s a policy that reaches none of the caller\'s sites', async () => {
    authRef.current = orgAuth([S1]);
    (db.select as any)
      .mockReturnValueOnce(chain([{ id: POLICY_ID, orgId: ORG_ID, targetType: 'site', targetIds: { siteIds: [S2] } }]));

    const res = await app().request(`/peripherals/policies/${POLICY_ID}`);

    expect(res.status).toBe(404);
  });

  it('detail narrows targets to the caller\'s sites', async () => {
    authRef.current = orgAuth([S1]);
    (db.select as any)
      .mockReturnValueOnce(chain([{ id: POLICY_ID, orgId: ORG_ID, targetType: 'site', targetIds: { siteIds: [S1, S2] } }]));

    const res = await app().request(`/peripherals/policies/${POLICY_ID}`);

    expect(res.status).toBe(200);
    expect((await res.json()).data.targetIds).toEqual({ siteIds: [S1] });
  });

  it('an org-wide policy stays visible to a site-restricted caller', async () => {
    authRef.current = orgAuth([S1]);
    (db.select as any)
      .mockReturnValueOnce(chain([{ id: POLICY_ID, orgId: ORG_ID, targetType: 'organization', targetIds: {} }]));

    const res = await app().request(`/peripherals/policies/${POLICY_ID}`);

    expect(res.status).toBe(200);
  });

  it('unrestricted callers get rows unchanged', async () => {
    authRef.current = orgAuth(undefined);
    const row = { id: POLICY_ID, orgId: ORG_ID, targetType: 'site', targetIds: { siteIds: [S1, S2] } };
    (db.select as any).mockReturnValueOnce(chain([row]));

    const res = await app().request(`/peripherals/policies/${POLICY_ID}`);

    expect(res.status).toBe(200);
    expect((await res.json()).data.targetIds).toEqual({ siteIds: [S1, S2] });
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
