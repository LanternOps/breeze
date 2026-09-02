import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
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

// Partner-cap enforcement (#2776 task 3.4, fix round 1). Mocked at the wiring
// level — see enrollmentKeys.test.ts's identically-named helper for
// rationale. None of the tests in this file exercise a partner-configured
// cap (that's covered in enrollmentKeys.test.ts's dedicated "partner cap
// enforcement" describe block); this permissive default just keeps every
// pre-existing test in this file — which predates the cap gate — passing.
const assertTtlWithinCapMock = vi.fn(
  async (_orgId: string, _ttlMinutes: number | undefined) => null as string | null,
);
vi.mock('../services/enrollmentDefaults', () => ({
  assertTtlWithinCap: (...args: [string, number | undefined]) =>
    assertTtlWithinCapMock(...args),
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

/** Mock for db.select().from().where() — resolves directly (count queries) */
function mockSelectFromWhere(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

/** Mock for db.select().from().where().orderBy().limit().offset() — paginated lists */
function mockSelectFromWhereOrderByLimitOffset(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  } as any);
}

/**
 * Mock for db.select().from().where().groupBy() — the batched installer
 * bootstrap-token aggregate the list/detail routes run after loading keys
 * (#2992). Rows are `{ parentEnrollmentKeyId, consumed, max, liveConsumed,
 * liveMax }` — the live pair being the same sums FILTERed to unexpired tokens
 * (#3039).
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

/** Mock for db.insert().values().returning() */
function mockInsertValuesReturning(rows: any[]) {
  vi.mocked(db.insert).mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

/**
 * Like mockInsertValuesReturning, but captures the exact payload the handler
 * passes to .values() so a test can assert on the server-computed expiresAt
 * directly — no reaching into vi mock internals, no conditionally-skipped
 * assertions (PR #739 review). Returns a getter for the captured row.
 */
function mockInsertCapture(rows: any[]): () => any {
  let captured: any;
  vi.mocked(db.insert).mockReturnValueOnce({
    values: vi.fn((v: any) => {
      captured = v;
      return { returning: vi.fn().mockResolvedValue(rows) };
    }),
  } as any);
  return () => captured;
}

// Server default when neither ttlMinutes nor expiresAt is supplied:
// DEFAULT_ENROLLMENT_KEY_TTL_MINUTES = envInt("ENROLLMENT_KEY_DEFAULT_TTL_MINUTES", 43200).
// The env var is unset in tests, so the literal 43200 (30 days) is the resolved value
// (the constant is captured at module import — a later env mutation cannot
// change it).
const DEFAULT_TTL_MINUTES = 43200;

describe('enrollment key routes — list & create', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks clears call history but NOT implementations — restore
    // the permissive default every test (mirrors the other route suites).
    assertTtlWithinCapMock.mockReset();
    assertTtlWithinCapMock.mockImplementation(async () => null);
    app = new Hono();
    app.route('/enrollment-keys', enrollmentKeyRoutes);
  });

  // ============================================
  // GET / — List enrollment keys
  // ============================================
  describe('GET /enrollment-keys', () => {
    // ------------------------------------------------------------------
    // #2992 — installer capacity on the list rows.
    //
    // The Add-Device / guided-setup download paths mint NO child enrollment
    // key: the device count the operator chose lives on an
    // installer_bootstrap_tokens row, so the key row alone rendered "0 / 1"
    // for an installer built for X devices. The list route now reports that
    // token capacity alongside the key's own counters.
    // ------------------------------------------------------------------
    it('attaches installer bootstrap-token capacity to the matching key only', async () => {
      mockSelectFromWhere([{ count: 2 }]);
      mockSelectFromWhereOrderByLimitOffset([
        makeEnrollmentKey({ name: 'Installer parent' }),
        makeEnrollmentKey({ id: 'key-2', name: 'Plain key' }),
      ]);
      mockSelectFromWhereGroupBy([
        { parentEnrollmentKeyId: KEY_ID, consumed: 3, max: 7, liveConsumed: 3, liveMax: 7 },
      ]);

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // One aggregate row must not fan out or reorder the page.
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);

      expect(body.data[0].installerTokens).toEqual({
        consumed: 3,
        max: 7,
        liveConsumed: 3,
        liveMax: 7,
      });
      // A key that never minted an installer reports null, so the UI keeps
      // showing its own usage_count — which IS claimed for short-link and
      // MCP-invite keys.
      expect(body.data[1].installerTokens).toBeNull();

      // The key's own budget is untouched: this is a read-side addition, and
      // max_usage stays an enforced enrollment budget, not a display label.
      expect(body.data[0].maxUsage).toBe(10);
      expect(body.data[0].usageCount).toBe(0);
    });

    it('sums capacity across several tokens minted from one key', async () => {
      mockSelectFromWhere([{ count: 1 }]);
      mockSelectFromWhereOrderByLimitOffset([makeEnrollmentKey()]);
      // Postgres SUM() comes back as a string over the wire; the route must
      // coerce or the UI renders "12" as "0"+"12" style garbage.
      mockSelectFromWhereGroupBy([
        { parentEnrollmentKeyId: KEY_ID, consumed: '4', max: '12', liveConsumed: '1', liveMax: '7' },
      ]);

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      const body = await res.json();
      expect(body.data[0].installerTokens).toEqual({
        consumed: 4,
        max: 12,
        liveConsumed: 1,
        liveMax: 7,
      });
    });

    // ------------------------------------------------------------------
    // #3039 — the liveness cut rides the same aggregate row. A key whose
    // installers have all expired reports liveMax 0 so the UI can stop
    // rendering "0 / 7" as seven usable slots (and can derive the row's
    // effective status from token liveness instead of the transient parent).
    // ------------------------------------------------------------------
    it('reports zero live capacity for a key whose installers have all expired', async () => {
      mockSelectFromWhere([{ count: 1 }]);
      mockSelectFromWhereOrderByLimitOffset([makeEnrollmentKey()]);
      mockSelectFromWhereGroupBy([
        { parentEnrollmentKeyId: KEY_ID, consumed: 3, max: 7, liveConsumed: 0, liveMax: 0 },
      ]);

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      const body = await res.json();
      // The historical totals survive (those three devices really enrolled);
      // the live pair is what withdraws the capacity claim.
      expect(body.data[0].installerTokens).toEqual({
        consumed: 3,
        max: 7,
        liveConsumed: 0,
        liveMax: 0,
      });
    });

    it('skips the aggregate query entirely when the page is empty', async () => {
      mockSelectFromWhere([{ count: 0 }]);
      mockSelectFromWhereOrderByLimitOffset([]);
      // Deliberately NO groupBy mock: an empty page must not issue the second
      // query at all (a bare `IN ()` is both wasteful and invalid SQL).
      //
      // Omitting the mock is NOT what proves that. Mutant: delete
      // `if (keyIds.length === 0) return usage`. Then `tx.select()` returns
      // undefined, `.from` throws a TypeError, fetchInstallerTokenUsage's
      // blanket catch swallows it and returns an empty map, and `data` is STILL
      // [] — the response assertion alone is green either way. The call counts
      // below are the assertions that kill it: the route may issue exactly its
      // two selects (count + page) and must never open the aggregate savepoint.

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(dbMock.transaction).not.toHaveBeenCalled();
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
    });

    // ------------------------------------------------------------------
    // #3034 — the installer line follows the TOKEN, not the parent key.
    //
    // #2992 suppressed the line for every short_code-bearing row, because
    // `/s/:code` mints a `maxUsage: 1` token per DOWNLOAD and Σ max_usage there
    // counts clicks, not device slots. But the authenticated build routes accept
    // ANY key id the caller can reach — including a short-link child, which is a
    // visible row on this very page — so that per-key proxy hid figures that
    // were real. The discriminator is now `installer_bootstrap_tokens.usage_kind`
    // and the route asks for every key on the page.
    // ------------------------------------------------------------------
    it('reports the installer line for a short-link child that has a capacity token (#3034)', async () => {
      mockSelectFromWhere([{ count: 2 }]);
      mockSelectFromWhereOrderByLimitOffset([
        makeEnrollmentKey({ name: 'Add Device parent' }),
        makeEnrollmentKey({
          id: 'key-link',
          name: 'Add Device parent (link x7)',
          shortCode: 'A1B2C3D4E5',
          maxUsage: 7,
          usageCount: 3,
        }),
      ]);
      // The operator built a 3-device installer FROM the short-link child row.
      // The aggregate — which filters `usage_kind = 'capacity'` in SQL — returns
      // a group for it, and the route must surface that group rather than
      // discarding it because the key happens to carry a short_code. This is the
      // exact regression #3034 reported; reinstating any per-key `shortCode`
      // gate on the read turns `data[1].installerTokens` back to null.
      mockSelectFromWhereGroupBy([
        { parentEnrollmentKeyId: KEY_ID, consumed: 0, max: 5, liveConsumed: 0, liveMax: 5 },
        { parentEnrollmentKeyId: 'key-link', consumed: 1, max: 3, liveConsumed: 1, liveMax: 3 },
      ]);

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // Add-Device parent (no short_code) still reports genuine capacity —
      // kills the "suppress everything" mutant.
      expect(body.data[0].installerTokens).toEqual({
        consumed: 0,
        max: 5,
        liveConsumed: 0,
        liveMax: 5,
      });
      expect(body.data[1].installerTokens).toEqual({
        consumed: 1,
        max: 3,
        liveConsumed: 1,
        liveMax: 3,
      });
      // The child's own counters are untouched and still tell their own story —
      // they are what `/s/:code` atomically claims.
      expect(body.data[1].usageCount).toBe(3);
      expect(body.data[1].maxUsage).toBe(7);
    });

    it('reports no installer line for a short-link child whose tokens are all per-download', async () => {
      mockSelectFromWhere([{ count: 1 }]);
      mockSelectFromWhereOrderByLimitOffset([
        makeEnrollmentKey({ shortCode: 'A1B2C3D4E5', maxUsage: 7, usageCount: 3 }),
      ]);
      // The aggregate runs (see the call-count assertions below) but its
      // `usage_kind = 'capacity'` predicate matches nothing, so the key gets no
      // group back and the route renders null — the same shape as a key that
      // never built an installer. This is what stops a 7-device link clicked 3
      // times from rendering "Installer devices 0 / 3" under its own "3 / 7".
      mockSelectFromWhereGroupBy([]);

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].installerTokens).toBeNull();
      // The route no longer pre-filters the id list by shortCode (#3034): no key
      // property predicts which tokens count, so every id on the page is handed
      // to the aggregate and the WHERE clause decides. Mutant killed:
      // reintroducing an id-list filter would skip the query entirely here.
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      // Three selects: count, page, aggregate. The old gate stopped at two for
      // an all-short-link page.
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(3);
    });

    it('lists enrollment keys for org-scoped user', async () => {
      mockSelectFromWhere([{ count: 2 }]);
      mockSelectFromWhereOrderByLimitOffset([
        makeEnrollmentKey({ name: 'Key 1' }),
        makeEnrollmentKey({ id: 'key-2', name: 'Key 2' }),
      ]);
      mockSelectFromWhereGroupBy([]);

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      expect(body.data[0].key).toBeUndefined();
    });

    it('returns empty for partner with no accessible orgs', async () => {
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

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });

    it('returns 403 for partner accessing denied org', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-111'],
          canAccessOrg: (id: string) => id === 'org-111',
        });
        return next();
      });

      const res = await app.request('/enrollment-keys?orgId=22222222-2222-2222-2222-222222222222', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 when org-scoped user has no orgId', async () => {
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

      const res = await app.request('/enrollment-keys', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });

    it('supports pagination parameters', async () => {
      mockSelectFromWhere([{ count: 100 }]);
      mockSelectFromWhereOrderByLimitOffset([makeEnrollmentKey()]);
      mockSelectFromWhereGroupBy([]);

      const res = await app.request('/enrollment-keys?page=3&limit=10', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.page).toBe(3);
      expect(body.pagination.limit).toBe(10);
    });
  });

  // ============================================
  // POST / — Create enrollment key
  // ============================================
  describe('POST /enrollment-keys', () => {
    it('creates a new enrollment key', async () => {
      const created = makeEnrollmentKey();
      // Capture rather than ignore the insert payload: the returned row is a
      // fixture, so asserting on the response cannot tell whether maxUsage was
      // persisted or silently swallowed by the `?? 1` default. The web
      // installer-download flow depends on that field surviving (#2992), and
      // createEnrollmentKeySchema is .strict() — a rename here 400s every
      // installer download, which nothing else in the repo would catch.
      const captured = mockInsertCapture([created]);

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Test Key', maxUsage: 10 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Test Key');
      expect(body.key).toBeDefined();
      expect(typeof body.key).toBe('string');
      expect(body.key.length).toBeGreaterThan(0);
      expect(captured().maxUsage).toBe(10);
      expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
    });

    it('defaults maxUsage to 1 when the caller omits it', async () => {
      const created = makeEnrollmentKey();
      const captured = mockInsertCapture([created]);

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Test Key' }),
      });

      expect(res.status).toBe(201);
      expect(captured().maxUsage).toBe(1);
    });

    it('rejects missing name', async () => {
      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ maxUsage: 10 }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 403 when org user creates key for different org', async () => {
      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Key', orgId: '22222222-2222-2222-2222-222222222222' }),
      });

      expect(res.status).toBe(403);
    });

    it('returns 400 when partner has multiple orgs and no orgId specified', async () => {
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

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Key' }),
      });

      expect(res.status).toBe(400);
    });

    it('auto-resolves orgId for partner with single org', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-1', email: 'test@example.com' },
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: ['org-111'],
          canAccessOrg: (id: string) => id === 'org-111',
        });
        return next();
      });
      mockInsertValuesReturning([makeEnrollmentKey()]);

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Key' }),
      });

      expect(res.status).toBe(201);
    });

    it('resolves expiresAt from ttlMinutes server-side (now + ttl)', async () => {
      const getInserted = mockInsertCapture([makeEnrollmentKey()]);
      const before = Date.now();

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'TTL key', ttlMinutes: 10080 }),
      });

      const after = Date.now();
      expect(res.status).toBe(201);
      // Unconditional: if the payload can't be captured the test must FAIL,
      // not silently pass (PR #739 review — the prior guard skipped this).
      const inserted = getInserted();
      expect(inserted?.expiresAt).toBeInstanceOf(Date);
      const ttlMs = 10080 * 60 * 1000;
      expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlMs - 50);
      expect(inserted.expiresAt.getTime()).toBeLessThanOrEqual(after + ttlMs + 50);
    });

    it('honors an explicit expiresAt when ttlMinutes is omitted (regression — pre-existing caller contract)', async () => {
      const getInserted = mockInsertCapture([makeEnrollmentKey()]);
      const explicit = new Date(Date.now() + 86_400_000); // +24h

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Explicit', expiresAt: explicit.toISOString() }),
      });

      expect(res.status).toBe(201);
      const inserted = getInserted();
      expect(inserted?.expiresAt).toBeInstanceOf(Date);
      // Exact round-trip of the supplied timestamp (ms precision).
      expect(inserted.expiresAt.getTime()).toBe(explicit.getTime());
    });

    it('falls back to DEFAULT_ENROLLMENT_KEY_TTL_MINUTES when neither ttlMinutes nor expiresAt is sent', async () => {
      const getInserted = mockInsertCapture([makeEnrollmentKey()]);
      const before = Date.now();

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Default TTL' }),
      });

      const after = Date.now();
      expect(res.status).toBe(201);
      const inserted = getInserted();
      expect(inserted?.expiresAt).toBeInstanceOf(Date);
      const ttlMs = DEFAULT_TTL_MINUTES * 60 * 1000;
      expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlMs - 50);
      expect(inserted.expiresAt.getTime()).toBeLessThanOrEqual(after + ttlMs + 50);
    });

    it('rejects when both ttlMinutes and expiresAt are sent', async () => {
      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Conflicting',
          ttlMinutes: 60,
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        }),
      });
      expect(res.status).toBe(400);
    });

    it('accepts the inclusive ttlMinutes boundaries (1 and 525_600)', async () => {
      mockInsertValuesReturning([makeEnrollmentKey()]);
      const minRes = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Min', ttlMinutes: 1 }),
      });
      expect(minRes.status).toBe(201);

      mockInsertValuesReturning([makeEnrollmentKey()]);
      const maxRes = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Max', ttlMinutes: 525_600 }),
      });
      expect(maxRes.status).toBe(201);
    });

    it('rejects ttlMinutes outside the 1..525_600 range and non-integers', async () => {
      const cases = [0, 525_601, 60.5];
      for (const ttlMinutes of cases) {
        const res = await app.request('/enrollment-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ name: 'X', ttlMinutes }),
        });
        expect(res.status, `ttlMinutes=${ttlMinutes} should be rejected`).toBe(400);
      }
    });

    it('returns 400 when system user provides no orgId', async () => {
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

      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Key' }),
      });

      expect(res.status).toBe(400);
    });
  });
});
