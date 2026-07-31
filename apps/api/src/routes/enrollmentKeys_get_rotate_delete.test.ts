import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

// Shared mutable gates so individual tests can flip MFA/permission denial at
// request time — the route registers `requireMfa()` / `requirePermission()`
// once at import time, so the returned middleware must re-check a gate on
// every invocation rather than baking in a decision at registration.
const { mfaGate, permissionGate } = vi.hoisted(() => ({
  mfaGate: { deny: false },
  permissionGate: { deny: false },
}));

// `db.transaction` is mocked to invoke its callback with the SAME object, so a
// nested savepoint (used by the installer-usage aggregate, #2992) routes
// straight back to the `db.select` mocks these tests already configure.
const dbMock = vi.hoisted(() => {
  const m: Record<string, any> = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  m.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(m));
  return m;
});

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock,
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
  // Referenced by the #2832 purge exemption
  // (services/enrollmentKeyPurgeGuards.ts), which the purge-expired route
  // pulls into its DELETE predicate.
  installerBootstrapTokens: {
    id: 'installerBootstrapTokens.id',
    parentEnrollmentKeyId: 'installerBootstrapTokens.parentEnrollmentKeyId',
    expiresAt: 'installerBootstrapTokens.expiresAt',
    consumedCount: 'installerBootstrapTokens.consumedCount',
    maxUsage: 'installerBootstrapTokens.maxUsage',
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

// Partner-cap enforcement (#2776 task 3.4, fix round 2). Mocked at the wiring
// level — see enrollmentKeys.test.ts's identically-named helper for
// rationale. Permissive by default so every pre-existing test in this file
// (which predates the cap gate on rotate) keeps passing.
const assertTtlWithinCapMock = vi.fn(
  async (_orgId: string, _ttlMinutes: number | undefined) => null as string | null,
);
vi.mock('../services/enrollmentDefaults', () => ({
  assertTtlWithinCap: (...args: [string, number | undefined]) =>
    assertTtlWithinCapMock(...args),
}));

/**
 * Configure the mocked partner-cap gate for the current test. Mirrors the
 * real assertTtlWithinCap contract: null when ttlMinutes is undefined or at/
 * under the cap, an error string naming the cap when it's exceeded.
 */
function mockEnrollmentDefaults(opts: { maxTtlMinutes: number }) {
  assertTtlWithinCapMock.mockImplementation(
    async (_orgId: string, ttlMinutes: number | undefined) => {
      if (ttlMinutes === undefined) return null;
      return ttlMinutes > opts.maxTtlMinutes
        ? `ttlMinutes exceeds the partner maximum of ${opts.maxTtlMinutes} minutes`
        : null;
    },
  );
}

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

/**
 * Mock for db.select().from().where().groupBy() — the installer bootstrap-token
 * aggregate GET /:id runs after loading the key (#2992).
 */
function mockSelectFromWhereGroupBy(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        groupBy: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as any);
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

/**
 * The #2832 exemption builds a correlated NOT EXISTS subquery via
 * `db.select(...).from(...).where(...)`. It never executes here (no Postgres
 * in this suite) — it only has to satisfy drizzle's `SQLWrapper` duck-typing
 * (a `getSQL()` method) so `notExists(...)` can embed it. Wrapping the REAL
 * condition production code built (via the unmocked drizzle `and`/`eq`/`gt`/
 * `lt`) means the captured WHERE genuinely reflects the generated predicate
 * rather than a canned stand-in. Mirrors the identical stub in
 * jobs/enrollmentKeyCleanup.test.ts.
 *
 * Registered with `mockReturnValue` (not `...Once`) so it stays in place for
 * however many times the guard is built, and does not consume the
 * `mockReturnValueOnce` queue the single-record `db.select` helpers rely on.
 */
/**
 * Flattens a drizzle condition to its static text. The existing purge tests
 * assert via `JSON.stringify`, which cannot see inside the #2832 exemption:
 * `notExists()` embeds the subquery as an opaque `SQLWrapper` (an object whose
 * only own property is a `getSQL` function), and JSON.stringify renders that
 * as `{}`. Recursing through `getSQL()` is what makes the subquery's columns
 * assertable. Same approach as jobs/enrollmentKeyCleanup.test.ts's `sqlText`.
 */
function sqlText(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  if (q instanceof Date) return q.toISOString();
  const obj = q as {
    queryChunks?: unknown[];
    value?: unknown;
    getSQL?: () => unknown;
  };
  if (Array.isArray(obj.queryChunks)) return obj.queryChunks.map(sqlText).join(' ');
  if (Array.isArray(obj.value)) return (obj.value as unknown[]).map(sqlText).join('');
  if (obj.value instanceof Date) return obj.value.toISOString();
  if (typeof obj.value === 'string' || typeof obj.value === 'number') return String(obj.value);
  if (typeof obj.getSQL === 'function') return sqlText(obj.getSQL());
  return '';
}

function mockBootstrapTokenExemptionSubquery() {
  vi.mocked(db.select).mockReturnValue({
    from: () => ({
      where: (cond: unknown) => ({
        getSQL: () => sql`select 1 from installer_bootstrap_tokens where ${cond}`,
      }),
    }),
  } as any);
}

describe('enrollment key routes — get, rotate, delete', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks clears call history but NOT implementations — restore
    // the permissive default every test (mirrors the other route suites).
    assertTtlWithinCapMock.mockReset();
    assertTtlWithinCapMock.mockImplementation(async () => null);
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
      mockSelectFromWhereGroupBy([]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(KEY_ID);
      expect(body.name).toBe('Test Key');
      expect(body.key).toBeUndefined();
      // Key with no installers → null, so the UI falls back to the key's own
      // counters (#2992).
      expect(body.installerTokens).toBeNull();
    });

    // #2992 — the detail route carries the same installer aggregate as the
    // list route, so a caller doesn't have to know which endpoint it read from.
    it('reports installer bootstrap-token capacity when the key has minted one', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockSelectFromWhereGroupBy([
        { parentEnrollmentKeyId: KEY_ID, consumed: 3, max: 7 },
      ]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.installerTokens).toEqual({ consumed: 3, max: 7 });
      // The key's own budget is reported unchanged — the installer figure is a
      // separate counter, not a rewrite of it.
      expect(body.maxUsage).toBe(10);
      expect(body.usageCount).toBe(0);
    });

    // #2992 review round 2 — a short_code marks an installer-link / invite
    // CHILD key, whose bootstrap tokens are one-per-DOWNLOAD (`maxUsage: 1`
    // hardcoded in serveInstaller), so Σ max_usage counts clicks rather than
    // device slots. See reportsInstallerCapacity. The detail route must apply
    // the same rule as the list route, or a caller gets a different answer
    // depending on which endpoint it read the key from.
    it('suppresses installer capacity for a short-link child key', async () => {
      mockSelectFromWhereLimit([
        makeEnrollmentKey({ shortCode: 'A1B2C3D4E5', maxUsage: 7, usageCount: 3 }),
      ]);
      // No groupBy mock: the aggregate must not be issued at all. Mutant
      // killed — drop the reportsInstallerCapacity gate here and the savepoint
      // opens and a second select fires (and, with a groupBy mock present, a
      // meaningless `Installer devices 0 / 3` reaches the wire).

      const res = await app.request(`/enrollment-keys/${KEY_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.installerTokens).toBeNull();
      expect(dbMock.transaction).not.toHaveBeenCalled();
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
      // The key's own counters — atomically claimed on every /s/:code
      // download — still carry the real story.
      expect(body.usageCount).toBe(3);
      expect(body.maxUsage).toBe(7);
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

    // #2776 task 3.4 fix round 2 — a sixth uncapped path: rotate re-mints the
    // key value via generateEnrollmentKey(), so an uncapped expiresAt here
    // would let a caller bound by a short partner cap create a key at the
    // cap and immediately rotate it past it. rotateEnrollmentKeySchema has
    // no ttlMinutes field (verified: only `maxUsage` and `expiresAt`), so
    // expiresAt is the only path to cover.
    it('rejects an expiresAt whose implied duration exceeds the partner cap', async () => {
      mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      const updateSet = vi.fn();
      vi.mocked(db.update).mockReturnValue({ set: updateSet } as any);

      // 30 days out — far above a 1440-minute (24h) cap.
      const expiresAt = new Date(Date.now() + 43200 * 60 * 1000).toISOString();

      const res = await app.request(`/enrollment-keys/${KEY_ID}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ expiresAt }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('1440');
      expect(updateSet).not.toHaveBeenCalled();
      // The route must derive an implied minutes value from expiresAt and
      // check IT against the cap — there is no ttlMinutes field on this route.
      const [, impliedMinutes] = assertTtlWithinCapMock.mock.calls[0]!;
      expect(impliedMinutes).toBeGreaterThan(43199);
      expect(impliedMinutes).toBeLessThanOrEqual(43201);
    });

    it('allows rotating with an expiresAt at or under the partner cap', async () => {
      mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockUpdateSetWhereReturning([makeEnrollmentKey({ key: 'hashed_newkey' })]);

      // Exactly at the 1440-minute cap.
      const expiresAt = new Date(Date.now() + 1440 * 60 * 1000).toISOString();

      const res = await app.request(`/enrollment-keys/${KEY_ID}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ expiresAt }),
      });

      expect(res.status).toBe(200);
    });

    it('does not consult the cap when expiresAt is omitted (preserves the existing key\'s own expiry, not a new choice)', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockUpdateSetWhereReturning([makeEnrollmentKey({ key: 'hashed_newkey' })]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ maxUsage: 5 }),
      });

      expect(res.status).toBe(200);
      expect(assertTtlWithinCapMock).toHaveBeenCalledWith(ORG_ID, undefined);
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
    beforeEach(() => {
      mockBootstrapTokenExemptionSubquery();
    });

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

    // #2832: the nightly sweep got the live-bootstrap-token exemption in
    // #2775; this route — the on-demand counterpart behind the web UI's
    // "Delete expired" button — did not, and is the FASTER path to the same
    // data loss (no grace period at all vs. the sweep's 7 days).
    //
    // This is a SQL-shape assertion: with `db` mocked there is no Postgres to
    // evaluate the correlated NOT EXISTS per row. Proof that Postgres actually
    // spares the right rows lives in
    // routes/enrollmentKeysPurgeExpired.integration.test.ts. What is
    // meaningfully verifiable here is that the predicate reaches the DELETE at
    // all and correlates on the right columns.
    it('exempts keys still backing a live, unexhausted installer bootstrap token (#2832)', async () => {
      const getCaptured = mockDeleteWhereReturningCapture([{ id: 'key-1' }]);

      const res = await app.request('/enrollment-keys/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const text = sqlText(getCaptured());

      expect(text).toContain('not exists');
      // Correlated on the outer enrollment_keys row...
      expect(text).toContain('installerBootstrapTokens.parentEnrollmentKeyId');
      expect(text).toContain('enrollmentKeys.id');
      // ...and both liveness arms are present: unexpired AND unexhausted.
      // Dropping either would silently re-open the cascade for half the
      // token population.
      expect(text).toContain('installerBootstrapTokens.expiresAt');
      expect(text).toContain('installerBootstrapTokens.consumedCount');
      expect(text).toContain('installerBootstrapTokens.maxUsage');
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
