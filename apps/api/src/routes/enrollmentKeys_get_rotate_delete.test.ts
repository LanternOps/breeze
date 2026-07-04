import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Shared mutable gates so individual tests can flip MFA/permission denial at
// request time — the route registers `requireMfa()` / `requirePermission()`
// once at import time, so the returned middleware must re-check a gate on
// every invocation rather than baking in a decision at registration.
const { mfaGate, permissionGate } = vi.hoisted(() => ({
  mfaGate: { deny: false },
  permissionGate: { deny: false },
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  enrollmentKeys: {
    id: 'enrollmentKeys.id',
    orgId: 'enrollmentKeys.orgId',
    siteId: 'enrollmentKeys.siteId',
    name: 'enrollmentKeys.name',
    key: 'enrollmentKeys.key',
    maxUsage: 'enrollmentKeys.maxUsage',
    usageCount: 'enrollmentKeys.usageCount',
    expiresAt: 'enrollmentKeys.expiresAt',
    createdAt: 'enrollmentKeys.createdAt',
    createdBy: 'enrollmentKeys.createdBy',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'orgs', action: 'read' },
    ORGS_WRITE: { resource: 'orgs', action: 'write' },
  },
}));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((key: string) => `hashed_${key}`),
  hashEnrollmentKeyCandidates: vi.fn((key: string) => [`hashed_${key}`]),
}));

vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 10, resetAt: new Date() })),
}));

import { enrollmentKeyRoutes } from './enrollmentKeys';
import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';

const ORG_ID = 'org-111';
const KEY_ID = '11111111-1111-1111-1111-111111111111';

function makeEnrollmentKey(overrides: Record<string, any> = {}) {
  return {
    id: KEY_ID,
    orgId: ORG_ID,
    siteId: null,
    name: 'Test Key',
    key: 'hashed_abc123',
    maxUsage: 10,
    usageCount: 0,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    createdBy: 'user-1',
    ...overrides,
  };
}

/** Mock for db.select().from().where().limit() — single-record lookups */
function mockSelectFromWhereLimit(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any);
}

/** Mock for db.update().set().where().returning() */
function mockUpdateSetWhereReturning(rows: any[]) {
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any);
}

/** Mock for db.delete().where() */
function mockDeleteWhere() {
  vi.mocked(db.delete).mockReturnValueOnce({
    where: vi.fn().mockResolvedValue(undefined),
  } as any);
}

/**
 * Mock for db.delete().where().returning() that captures the exact `where`
 * condition passed in, so a test can assert on the composed scope + expired
 * condition (via its JSON-serialized SQL chunks — drizzle SQL objects stringify
 * to their operator/column/value shape, e.g. `"enrollmentKeys.orgId"`, `" = "`,
 * `"enrollmentKeys.expiresAt"`, `" < "`) without needing a real DB.
 */
function mockDeleteWhereReturningCapture(rows: any[]): () => any {
  let captured: any;
  vi.mocked(db.delete).mockReturnValueOnce({
    where: vi.fn((cond: any) => {
      captured = cond;
      return { returning: vi.fn().mockResolvedValue(rows) };
    }),
  } as any);
  return () => captured;
}

describe('enrollment key routes — get, rotate, delete', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mfaGate.deny = false;
    permissionGate.deny = false;
    app = new Hono();
    app.route('/enrollment-keys', enrollmentKeyRoutes);
  });

  // ============================================
  // GET /:id — Get enrollment key details
  // ============================================
  describe('GET /enrollment-keys/:id', () => {
    it('returns enrollment key details without raw key', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(KEY_ID);
      expect(body.name).toBe('Test Key');
      expect(body.key).toBeUndefined();
    });

    it('returns 404 for nonexistent key', async () => {
      mockSelectFromWhereLimit([]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 when accessing key from different org', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey({ orgId: 'other-org' })]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });
  });

  // ============================================
  // POST /:id/rotate — Rotate enrollment key
  // ============================================
  describe('POST /enrollment-keys/:id/rotate', () => {
    it('rotates key material and resets usage count', async () => {
      const existing = makeEnrollmentKey({ usageCount: 5 });
      mockSelectFromWhereLimit([existing]);
      mockUpdateSetWhereReturning([
        makeEnrollmentKey({ usageCount: 0, key: 'hashed_newkey' }),
      ]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.key).toBeDefined();
      expect(typeof body.key).toBe('string');
      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'enrollment_key.rotate' })
      );
    });

    it('allows updating maxUsage during rotation', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockUpdateSetWhereReturning([makeEnrollmentKey({ maxUsage: 50 })]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ maxUsage: 50 }),
      });

      expect(res.status).toBe(200);
    });

    it('returns 404 for nonexistent key', async () => {
      mockSelectFromWhereLimit([]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 when key belongs to another org', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey({ orgId: 'other-org' })]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
    });
  });

  // ============================================
  // DELETE /:id — Delete enrollment key
  // ============================================
  describe('DELETE /enrollment-keys/:id', () => {
    it('deletes an enrollment key', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockDeleteWhere();

      const res = await app.request(`/enrollment-keys/${KEY_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'enrollment_key.delete' })
      );
    });

    it('returns 404 for nonexistent key', async () => {
      mockSelectFromWhereLimit([]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 when key belongs to another org', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey({ orgId: 'other-org' })]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });
  });

  // ============================================
  // POST /purge-expired — Bulk-delete expired enrollment keys in caller scope
  // ============================================
  describe('POST /enrollment-keys/purge-expired', () => {
    it('purges expired keys within the org-scoped caller\'s org and returns the count', async () => {
      const getCaptured = mockDeleteWhereReturningCapture([
        { id: 'key-1' },
        { id: 'key-2' },
      ]);

      const res = await app.request('/enrollment-keys/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, deletedCount: 2 });

      // Composed condition scopes to the caller's org AND filters expired —
      // asserted via the serialized SQL chunk shape (see helper docstring).
      const conditionJson = JSON.stringify(getCaptured());
      expect(conditionJson).toContain('enrollmentKeys.orgId');
      expect(conditionJson).toContain(ORG_ID);
      expect(conditionJson).toContain('enrollmentKeys.expiresAt');
      expect(conditionJson).toContain(' < ');

      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'enrollment_key.purge_expired',
          details: { deletedCount: 2 },
        }),
      );
    });

    it('returns deletedCount 0 when the delete matches nothing', async () => {
      const getCaptured = mockDeleteWhereReturningCapture([]);

      const res = await app.request('/enrollment-keys/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, deletedCount: 0 });
      expect(getCaptured()).toBeDefined();
      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({ details: { deletedCount: 0 } }),
      );
    });

    it('returns 403 when org-scoped caller has no orgId', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'organization',
          orgId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false,
        });
        return next();
      });

      const res = await app.request('/enrollment-keys/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('scopes to all accessible orgs for a partner-scoped caller', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-a', 'org-b'],
          canAccessOrg: (id: string) => ['org-a', 'org-b'].includes(id),
        });
        return next();
      });
      const getCaptured = mockDeleteWhereReturningCapture([{ id: 'key-1' }]);

      const res = await app.request('/enrollment-keys/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, deletedCount: 1 });
      const conditionJson = JSON.stringify(getCaptured());
      expect(conditionJson).toContain('org-a');
      expect(conditionJson).toContain('org-b');
    });

    it('returns deletedCount 0 without querying when partner caller has no accessible orgs', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => false,
        });
        return next();
      });

      const res = await app.request('/enrollment-keys/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, deletedCount: 0 });
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('purges across all orgs (no org restriction) for a system-scoped caller', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'admin-1', email: 'admin@example.com' },
          scope: 'system',
          orgId: null,
          accessibleOrgIds: null,
          canAccessOrg: () => true,
        });
        return next();
      });
      const getCaptured = mockDeleteWhereReturningCapture([
        { id: 'key-1' },
        { id: 'key-2' },
        { id: 'key-3' },
      ]);

      const res = await app.request('/enrollment-keys/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, deletedCount: 3 });
      const conditionJson = JSON.stringify(getCaptured());
      // No org-scoping column present — only the expired condition.
      expect(conditionJson).not.toContain('enrollmentKeys.orgId');
      expect(conditionJson).toContain('enrollmentKeys.expiresAt');
    });

    it('is blocked without MFA (requireMfa)', async () => {
      mfaGate.deny = true;

      const res = await app.request('/enrollment-keys/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('is blocked without the required permission (requirePermission)', async () => {
      permissionGate.deny = true;

      const res = await app.request('/enrollment-keys/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
      expect(db.delete).not.toHaveBeenCalled();
    });
  });
});
