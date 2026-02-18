import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Hoisted mock functions — available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockSelect,
  mockInsert,
  mockUpdate,
  mockDelete,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../../db', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'id', orgId: 'orgId' },
  deviceGroups: { id: 'id', orgId: 'orgId', name: 'name' },
  deviceGroupMemberships: { groupId: 'groupId', deviceId: 'deviceId' },
  sites: { id: 'id', orgId: 'orgId' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  requireScope: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

// Let ensureOrgAccess run for real; only mock getPagination
vi.mock('./helpers', async () => {
  const actual = await vi.importActual('./helpers');
  return {
    ...actual,
    getPagination: vi.fn(({ page, limit }: any) => ({
      page: Number(page) || 1,
      limit: Number(limit) || 50,
      offset: ((Number(page) || 1) - 1) * (Number(limit) || 50),
    })),
  };
});

// Stub the zod validator so it passes the JSON body through without validation
// (we're testing route logic, not schema validation)
vi.mock('@hono/zod-validator', () => ({
  zValidator: vi.fn((_target: string, _schema: any) => {
    return async (c: any, next: any) => {
      if (_target === 'json') {
        const body = await c.req.json();
        c.req.valid = () => body;
      }
      await next();
    };
  }),
}));

import { groupsRoutes } from './groups';
import { writeRouteAudit } from '../../services/auditEvents';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ORG_A = 'aaaa0000-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbb0000-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_1 = 'dddd0001-dddd-dddd-dddd-dddddddddddd';
const DEVICE_2 = 'dddd0002-dddd-dddd-dddd-dddddddddddd';
const SITE_ID = 'ssss0001-ssss-ssss-ssss-ssssssssssss';
const PARENT_ID = 'pppp0001-pppp-pppp-pppp-pppppppppppp';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------
function makeAuth(overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'organization',
    orgId: ORG_A,
    partnerId: null,
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: { scope: 'organization' },
    accessibleOrgIds: [ORG_A],
    canAccessOrg: (id: string) => id === ORG_A,
    orgCondition: () => undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB mock chain helpers
// ---------------------------------------------------------------------------

/**
 * Build a chainable select mock.
 *
 * Drizzle's select chain is: select(cols?).from(table).where(cond)
 * Depending on usage the chain might continue with .limit() / .offset() / .orderBy()
 *
 * We make the final step in the *expected* chain resolve with `rows`.
 * For calls that end with `.where()` but may optionally continue with
 * `.orderBy().limit().offset()`, we make `.where()` return a thenable
 * that also exposes the next chain methods.
 */
function chainSelect(rows: any[]) {
  // Terminal thenable that also exposes .limit() / .offset() / .orderBy()
  const makeThenable = (r: any[]) => {
    const obj: any = {
      then: (res: any, rej?: any) => Promise.resolve(r).then(res, rej),
      limit: vi.fn().mockReturnValue({
        then: (res: any, rej?: any) => Promise.resolve(r).then(res, rej),
        offset: vi.fn().mockReturnValue({
          then: (res: any, rej?: any) => Promise.resolve(r).then(res, rej),
        }),
      }),
      orderBy: vi.fn().mockReturnValue({
        then: (res: any, rej?: any) => Promise.resolve(r).then(res, rej),
        limit: vi.fn().mockReturnValue({
          then: (res: any, rej?: any) => Promise.resolve(r).then(res, rej),
          offset: vi.fn().mockReturnValue({
            then: (res: any, rej?: any) => Promise.resolve(r).then(res, rej),
          }),
        }),
      }),
    };
    return obj;
  };

  const where = vi.fn().mockReturnValue(makeThenable(rows));
  const from = vi.fn().mockReturnValue({ where });

  return { from };
}

function chainInsert(rows: any[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ returning, onConflictDoNothing });
  return { values };
}

function chainUpdate(rows: any[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  return { set };
}

function chainDelete() {
  const where = vi.fn().mockResolvedValue(undefined);
  return { where };
}

// ---------------------------------------------------------------------------
// Build app helper
// ---------------------------------------------------------------------------
function buildApp(auth: any): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/devices', groupsRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Device Groups routes — multi-tenant isolation', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp(makeAuth());
  });

  // ========================================================================
  // GET /devices/groups
  // ========================================================================
  describe('GET /devices/groups', () => {
    it('returns groups for the authed org (happy path)', async () => {
      const groups = [{ id: GROUP_ID, orgId: ORG_A, name: 'Servers' }];

      // First select() call = count query
      // Second select() call = data query
      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainSelect([{ count: 1 }]);
        return chainSelect(groups);
      });

      const res = await app.request(`/devices/groups?orgId=${ORG_A}`);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].name).toBe('Servers');
      expect(json.pagination.total).toBe(1);
    });

    it('returns 400 when orgId query param is missing', async () => {
      const res = await app.request('/devices/groups');
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/orgId/i);
    });

    it('returns 403 when org-scoped user requests a different org', async () => {
      const res = await app.request(`/devices/groups?orgId=${ORG_B}`);
      expect(res.status).toBe(403);
    });

    it('returns 403 when partner cannot access the requested org', async () => {
      const partnerApp = buildApp(
        makeAuth({
          scope: 'partner',
          orgId: null,
          canAccessOrg: () => false,
        })
      );

      const res = await partnerApp.request(`/devices/groups?orgId=${ORG_A}`);
      expect(res.status).toBe(403);
    });

    it('allows system scope to access any org', async () => {
      const systemApp = buildApp(
        makeAuth({ scope: 'system', orgId: null })
      );

      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainSelect([{ count: 0 }]);
        return chainSelect([]);
      });

      const res = await systemApp.request(`/devices/groups?orgId=${ORG_B}`);
      expect(res.status).toBe(200);
    });
  });

  // ========================================================================
  // POST /devices/groups
  // ========================================================================
  describe('POST /devices/groups', () => {
    const validBody = { orgId: ORG_A, name: 'Workstations', type: 'static' };

    it('creates a group in the authed org (happy path)', async () => {
      const created = { id: GROUP_ID, ...validBody };
      mockInsert.mockReturnValue(chainInsert([created]));

      const res = await app.request('/devices/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.id).toBe(GROUP_ID);
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 403 when org-scoped user targets a different org', async () => {
      const res = await app.request('/devices/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, orgId: ORG_B }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when partner cannot access target org', async () => {
      const partnerApp = buildApp(
        makeAuth({
          scope: 'partner',
          orgId: null,
          canAccessOrg: () => false,
        })
      );

      const res = await partnerApp.request('/devices/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(403);
    });

    it('allows system scope to create in any org', async () => {
      const systemApp = buildApp(
        makeAuth({ scope: 'system', orgId: null })
      );

      const created = { id: GROUP_ID, orgId: ORG_B, name: 'Remote', type: 'static' };
      mockInsert.mockReturnValue(chainInsert([created]));

      const res = await systemApp.request('/devices/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_B, name: 'Remote', type: 'static' }),
      });

      expect(res.status).toBe(201);
    });

    it('verifies site belongs to org when siteId is provided', async () => {
      // Mock the site lookup returning a valid site
      mockSelect.mockReturnValue(
        chainSelect([{ id: SITE_ID, orgId: ORG_A }])
      );
      const created = { id: GROUP_ID, ...validBody, siteId: SITE_ID };
      mockInsert.mockReturnValue(chainInsert([created]));

      const res = await app.request('/devices/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, siteId: SITE_ID }),
      });

      expect(res.status).toBe(201);
    });

    it('returns 400 when site does not belong to org', async () => {
      // Site lookup returns nothing
      mockSelect.mockReturnValue(chainSelect([]));

      const res = await app.request('/devices/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, siteId: SITE_ID }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/[Ss]ite/);
    });

    it('returns 400 when parentId group does not belong to org', async () => {
      mockSelect.mockReturnValue(chainSelect([]));

      const res = await app.request('/devices/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, parentId: PARENT_ID }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/[Pp]arent/);
    });
  });

  // ========================================================================
  // PATCH /devices/groups/:id
  // ========================================================================
  describe('PATCH /devices/groups/:id', () => {
    const groupInOrgA = { id: GROUP_ID, orgId: ORG_A, name: 'Old Name', type: 'static' };

    it('updates a group the authed user owns (happy path)', async () => {
      // First select = lookup group by id
      mockSelect.mockReturnValue(chainSelect([groupInOrgA]));

      const updated = { ...groupInOrgA, name: 'New Name' };
      mockUpdate.mockReturnValue(chainUpdate([updated]));

      const res = await app.request(`/devices/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.name).toBe('New Name');
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 404 when group does not exist', async () => {
      mockSelect.mockReturnValue(chainSelect([]));

      const res = await app.request(`/devices/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 when org-scoped user tries to update group in another org', async () => {
      const groupInOrgB = { id: GROUP_ID, orgId: ORG_B, name: 'B Group', type: 'static' };
      mockSelect.mockReturnValue(chainSelect([groupInOrgB]));

      const res = await app.request(`/devices/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijack' }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when partner cannot access the group org', async () => {
      const partnerApp = buildApp(
        makeAuth({
          scope: 'partner',
          orgId: null,
          canAccessOrg: () => false,
        })
      );

      const groupInOrgA = { id: GROUP_ID, orgId: ORG_A, name: 'Some Group', type: 'static' };
      mockSelect.mockReturnValue(chainSelect([groupInOrgA]));

      const res = await partnerApp.request(`/devices/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijack' }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 400 when no update fields are provided', async () => {
      const res = await app.request(`/devices/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/[Nn]o updates/);
    });

    it('allows system scope to update any group', async () => {
      const systemApp = buildApp(makeAuth({ scope: 'system', orgId: null }));

      const groupInOrgB = { id: GROUP_ID, orgId: ORG_B, name: 'B Group', type: 'static' };
      mockSelect.mockReturnValue(chainSelect([groupInOrgB]));
      mockUpdate.mockReturnValue(chainUpdate([{ ...groupInOrgB, name: 'Updated' }]));

      const res = await systemApp.request(`/devices/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });

      expect(res.status).toBe(200);
    });
  });

  // ========================================================================
  // DELETE /devices/groups/:id
  // ========================================================================
  describe('DELETE /devices/groups/:id', () => {
    const groupInOrgA = { id: GROUP_ID, orgId: ORG_A, name: 'Delete Me', type: 'static' };

    it('deletes a group the authed user owns (happy path)', async () => {
      mockSelect.mockReturnValue(chainSelect([groupInOrgA]));
      mockDelete.mockReturnValue(chainDelete());

      const res = await app.request(`/devices/groups/${GROUP_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(writeRouteAudit).toHaveBeenCalled();
      // delete called twice: memberships first, then group
      expect(mockDelete).toHaveBeenCalledTimes(2);
    });

    it('returns 404 when group does not exist', async () => {
      mockSelect.mockReturnValue(chainSelect([]));

      const res = await app.request(`/devices/groups/${GROUP_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 when org-scoped user tries to delete group in another org', async () => {
      const groupInOrgB = { id: GROUP_ID, orgId: ORG_B, name: 'B Group' };
      mockSelect.mockReturnValue(chainSelect([groupInOrgB]));

      const res = await app.request(`/devices/groups/${GROUP_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when partner cannot access the group org', async () => {
      const partnerApp = buildApp(
        makeAuth({
          scope: 'partner',
          orgId: null,
          canAccessOrg: () => false,
        })
      );

      mockSelect.mockReturnValue(chainSelect([groupInOrgA]));

      const res = await partnerApp.request(`/devices/groups/${GROUP_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
    });

    it('allows system scope to delete any group', async () => {
      const systemApp = buildApp(makeAuth({ scope: 'system', orgId: null }));

      const groupInOrgB = { id: GROUP_ID, orgId: ORG_B, name: 'B Group' };
      mockSelect.mockReturnValue(chainSelect([groupInOrgB]));
      mockDelete.mockReturnValue(chainDelete());

      const res = await systemApp.request(`/devices/groups/${GROUP_ID}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
    });
  });

  // ========================================================================
  // POST /devices/groups/:id/members
  // ========================================================================
  describe('POST /devices/groups/:id/members', () => {
    const groupInOrgA = { id: GROUP_ID, orgId: ORG_A, name: 'Servers' };

    it('adds devices to a group (happy path)', async () => {
      // select #1 = group lookup, select #2 = device validation
      let selectCall = 0;
      mockSelect.mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return chainSelect([groupInOrgA]);
        return chainSelect([{ id: DEVICE_1 }, { id: DEVICE_2 }]);
      });

      mockInsert.mockReturnValue(chainInsert([]));

      const res = await app.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1, DEVICE_2] }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.added).toBe(2);
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 400 when deviceIds is missing or empty', async () => {
      const res = await app.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/deviceIds/);
    });

    it('returns 404 when group does not exist', async () => {
      mockSelect.mockReturnValue(chainSelect([]));

      const res = await app.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 when org-scoped user targets a group in another org', async () => {
      const groupInOrgB = { id: GROUP_ID, orgId: ORG_B, name: 'B Group' };
      mockSelect.mockReturnValue(chainSelect([groupInOrgB]));

      const res = await app.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when partner cannot access the group org', async () => {
      const partnerApp = buildApp(
        makeAuth({
          scope: 'partner',
          orgId: null,
          canAccessOrg: () => false,
        })
      );

      mockSelect.mockReturnValue(chainSelect([groupInOrgA]));

      const res = await partnerApp.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 400 when no valid devices are found', async () => {
      let selectCall = 0;
      mockSelect.mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return chainSelect([groupInOrgA]);
        // No valid devices found for this org
        return chainSelect([]);
      });

      const res = await app.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/[Nn]o valid devices/);
    });

    it('allows system scope to add members to any group', async () => {
      const systemApp = buildApp(makeAuth({ scope: 'system', orgId: null }));

      const groupInOrgB = { id: GROUP_ID, orgId: ORG_B, name: 'B Group' };
      let selectCall = 0;
      mockSelect.mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) return chainSelect([groupInOrgB]);
        return chainSelect([{ id: DEVICE_1 }]);
      });

      mockInsert.mockReturnValue(chainInsert([]));

      const res = await systemApp.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(200);
    });
  });

  // ========================================================================
  // DELETE /devices/groups/:id/members
  // ========================================================================
  describe('DELETE /devices/groups/:id/members', () => {
    const groupInOrgA = { id: GROUP_ID, orgId: ORG_A, name: 'Servers' };

    it('removes devices from a group (happy path)', async () => {
      mockSelect.mockReturnValue(chainSelect([groupInOrgA]));
      mockDelete.mockReturnValue(chainDelete());

      const res = await app.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(writeRouteAudit).toHaveBeenCalled();
    });

    it('returns 400 when deviceIds is missing or empty', async () => {
      const res = await app.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 when group does not exist', async () => {
      mockSelect.mockReturnValue(chainSelect([]));

      const res = await app.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 when org-scoped user targets a group in another org', async () => {
      const groupInOrgB = { id: GROUP_ID, orgId: ORG_B, name: 'B Group' };
      mockSelect.mockReturnValue(chainSelect([groupInOrgB]));

      const res = await app.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when partner cannot access the group org', async () => {
      const partnerApp = buildApp(
        makeAuth({
          scope: 'partner',
          orgId: null,
          canAccessOrg: () => false,
        })
      );

      mockSelect.mockReturnValue(chainSelect([groupInOrgA]));

      const res = await partnerApp.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(403);
    });

    it('allows system scope to remove members from any group', async () => {
      const systemApp = buildApp(makeAuth({ scope: 'system', orgId: null }));

      const groupInOrgB = { id: GROUP_ID, orgId: ORG_B, name: 'B Group' };
      mockSelect.mockReturnValue(chainSelect([groupInOrgB]));
      mockDelete.mockReturnValue(chainDelete());

      const res = await systemApp.request(`/devices/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_1] }),
      });

      expect(res.status).toBe(200);
    });
  });
});
