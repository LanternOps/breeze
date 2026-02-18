import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock db before importing the route module
// ---------------------------------------------------------------------------
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  deviceGroups: { id: 'id', orgId: 'orgId', name: 'name', siteId: 'siteId', type: 'type', rules: 'rules', parentId: 'parentId', updatedAt: 'updatedAt' },
  deviceGroupMemberships: { groupId: 'groupId', deviceId: 'deviceId' },
  devices: { id: 'id', orgId: 'orgId' },
  sites: { id: 'id', orgId: 'orgId' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

// Mock helpers: use inline ensureOrgAccess that mirrors the real implementation
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: async (orgId: string, auth: any) => {
    if (auth.scope === 'organization') return auth.orgId === orgId;
    if (auth.scope === 'partner') return auth.canAccessOrg(orgId);
    return true; // system scope
  },
}));

// Mock zValidator so it passes the parsed body through without Zod validation
vi.mock('@hono/zod-validator', () => ({
  zValidator: vi.fn((_target: string, _schema: any) => async (c: any, next: any) => {
    // Expose the JSON body as the validated value so c.req.valid('json') works
    const body = await c.req.json().catch(() => ({}));
    c.req.valid = (_t: string) => body;
    await next();
  }),
}));

vi.mock('./schemas', () => ({
  createGroupSchema: {},
  updateGroupSchema: {},
}));

// ---------------------------------------------------------------------------
// Import route + mocked modules after vi.mock calls
// ---------------------------------------------------------------------------
import { groupsRoutes } from './groups';
import { db } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';

// ---------------------------------------------------------------------------
// Auth factory
// ---------------------------------------------------------------------------
function makeAuth(overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'organization',
    orgId: ORG_A,
    partnerId: null,
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: { scope: 'organization' },
    accessibleOrgIds: [ORG_A],
    canAccessOrg: (orgId: string) => orgId === ORG_A,
    orgCondition: () => undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build an app that mounts groupsRoutes with the given auth context
// ---------------------------------------------------------------------------
function buildApp(authOverrides: Record<string, unknown> = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', makeAuth(authOverrides));
    await next();
  });
  // groupsRoutes uses internal paths like /groups and /groups/:id
  app.route('/', groupsRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// Shared DB mock helpers
// ---------------------------------------------------------------------------

/** Mock db.select() returning a list result (used for count + data queries) */
function mockSelectReturnsSequence(...results: any[][]): void {
  let callIndex = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const result = results[callIndex] ?? [];
    callIndex++;
    // Build a thenable where() so the route can either await it directly
    // or chain further calls (.limit(), .orderBy(), etc.)
    const whereResult = Object.assign(Promise.resolve(result), {
      limit: vi.fn().mockResolvedValue(result),
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          offset: vi.fn().mockResolvedValue(result),
        }),
      }),
    });
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(whereResult),
      }),
    } as any;
  });
}

/** Mock a single db.select() that returns the given rows */
function mockSelectReturns(rows: any[]): void {
  const whereResult = Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        offset: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(whereResult),
    }),
  } as any);
}

/** Mock a group lookup returning a group owned by a specific org */
function mockGroupLookup(orgId: string): void {
  mockSelectReturns([{ id: GROUP_ID, orgId, name: 'Test Group' }]);
}

// ===========================================================================
// Tests
// ===========================================================================

describe('device groups routes — cross-tenant isolation', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  // =========================================================================
  // GET /groups
  // =========================================================================

  describe('GET /groups', () => {
    it('denies access when orgId query param belongs to a different org (cross-tenant)', async () => {
      const res = await app.request(`/groups?orgId=${ORG_B}`);
      expect(res.status).toBe(403);
    });

    it('returns 400 when orgId query param is missing', async () => {
      const res = await app.request('/groups');
      expect(res.status).toBe(400);
    });

    it('returns 200 and paginated groups for the authenticated org', async () => {
      const fakeGroup = { id: GROUP_ID, orgId: ORG_A, name: 'My Group' };
      // First select call: count query; second: data query
      mockSelectReturnsSequence(
        [{ count: 1 }],
        [fakeGroup],
      );

      const res = await app.request(`/groups?orgId=${ORG_A}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBeDefined();
    });
  });

  // =========================================================================
  // POST /groups
  // =========================================================================

  describe('POST /groups', () => {
    it('denies creating a group in a different org (cross-tenant)', async () => {
      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_B, name: 'Evil Group', type: 'static' }),
      });
      expect(res.status).toBe(403);
    });

    it('creates a group in the authenticated org and returns 201', async () => {
      const newGroup = { id: GROUP_ID, orgId: ORG_A, name: 'New Group', type: 'static' };

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newGroup]),
        }),
      } as any);

      const res = await app.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_A, name: 'New Group', type: 'static' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.orgId).toBe(ORG_A);
      expect(writeRouteAudit).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // PATCH /groups/:id
  // =========================================================================

  describe('PATCH /groups/:id', () => {
    it('denies updating a group owned by a different org (cross-tenant)', async () => {
      // Group belongs to ORG_B; auth is for ORG_A
      mockGroupLookup(ORG_B);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hacked' }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 404 when the group does not exist', async () => {
      mockSelectReturns([]);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      expect(res.status).toBe(404);
    });

    it('updates a group belonging to the authenticated org and returns 200', async () => {
      const existing = { id: GROUP_ID, orgId: ORG_A, name: 'Old Name' };
      const updated = { ...existing, name: 'New Name' };

      // First select returns the existing group; update returns the updated row
      mockSelectReturns([existing]);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('New Name');
      expect(writeRouteAudit).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // DELETE /groups/:id
  // =========================================================================

  describe('DELETE /groups/:id', () => {
    it('denies deleting a group owned by a different org (cross-tenant)', async () => {
      mockGroupLookup(ORG_B);

      const res = await app.request(`/groups/${GROUP_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    });

    it('returns 404 when the group does not exist', async () => {
      mockSelectReturns([]);

      const res = await app.request(`/groups/${GROUP_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('deletes a group belonging to the authenticated org and returns 200', async () => {
      const existing = { id: GROUP_ID, orgId: ORG_A, name: 'To Delete' };
      mockSelectReturns([existing]);

      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(writeRouteAudit).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // POST /groups/:id/members
  // =========================================================================

  describe('POST /groups/:id/members', () => {
    it('denies adding members to a group owned by a different org (cross-tenant)', async () => {
      mockGroupLookup(ORG_B);

      const res = await app.request(`/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 400 when deviceIds is missing or empty', async () => {
      const res = await app.request(`/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 when the group does not exist', async () => {
      mockSelectReturns([]);

      const res = await app.request(`/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] }),
      });
      expect(res.status).toBe(404);
    });

    it('adds members to a group belonging to the authenticated org', async () => {
      const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const group = { id: GROUP_ID, orgId: ORG_A, name: 'Static Group' };

      // First select: group lookup; second select: valid devices check
      mockSelectReturnsSequence(
        [group],
        [{ id: DEVICE_ID }],
      );

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.added).toBe(1);
      expect(writeRouteAudit).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // DELETE /groups/:id/members
  // =========================================================================

  describe('DELETE /groups/:id/members', () => {
    it('denies removing members from a group owned by a different org (cross-tenant)', async () => {
      mockGroupLookup(ORG_B);

      const res = await app.request(`/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 400 when deviceIds is missing or empty', async () => {
      const res = await app.request(`/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 when the group does not exist', async () => {
      mockSelectReturns([]);

      const res = await app.request(`/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] }),
      });
      expect(res.status).toBe(404);
    });

    it('removes members from a group belonging to the authenticated org', async () => {
      const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const group = { id: GROUP_ID, orgId: ORG_A, name: 'Static Group' };
      mockSelectReturns([group]);

      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const res = await app.request(`/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: [DEVICE_ID] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(writeRouteAudit).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Partner scope — canAccessOrg: () => false → 403 on all routes
  // =========================================================================

  describe('partner scope with no org access', () => {
    let partnerApp: Hono;

    beforeEach(() => {
      partnerApp = buildApp({
        scope: 'partner',
        orgId: null,
        canAccessOrg: () => false,
      });
    });

    it('GET /groups returns 403', async () => {
      const res = await partnerApp.request(`/groups?orgId=${ORG_A}`);
      expect(res.status).toBe(403);
    });

    it('POST /groups returns 403', async () => {
      const res = await partnerApp.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_A, name: 'Hostile Group', type: 'static' }),
      });
      expect(res.status).toBe(403);
    });

    it('PATCH /groups/:id returns 403', async () => {
      mockGroupLookup(ORG_A);

      const res = await partnerApp.request(`/groups/${GROUP_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hostile Update' }),
      });
      expect(res.status).toBe(403);
    });

    it('DELETE /groups/:id returns 403', async () => {
      mockGroupLookup(ORG_A);

      const res = await partnerApp.request(`/groups/${GROUP_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    });

    it('POST /groups/:id/members returns 403', async () => {
      mockGroupLookup(ORG_A);

      const res = await partnerApp.request(`/groups/${GROUP_ID}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] }),
      });
      expect(res.status).toBe(403);
    });

    it('DELETE /groups/:id/members returns 403', async () => {
      mockGroupLookup(ORG_A);

      const res = await partnerApp.request(`/groups/${GROUP_ID}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] }),
      });
      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // System scope — bypasses org restrictions
  // =========================================================================

  describe('system scope', () => {
    let systemApp: Hono;

    beforeEach(() => {
      systemApp = buildApp({ scope: 'system', orgId: null });
    });

    it('GET /groups allows access to any org', async () => {
      mockSelectReturnsSequence([{ count: 0 }], []);

      const res = await systemApp.request(`/groups?orgId=${ORG_B}`);
      expect(res.status).toBe(200);
    });

    it('POST /groups allows creating a group in any org', async () => {
      const newGroup = { id: GROUP_ID, orgId: ORG_B, name: 'System Group', type: 'static' };

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newGroup]),
        }),
      } as any);

      const res = await systemApp.request('/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_B, name: 'System Group', type: 'static' }),
      });
      expect(res.status).toBe(201);
    });
  });
});
