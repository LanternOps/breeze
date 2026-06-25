import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

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
    keySecretHash: 'enrollmentKeys.keySecretHash',
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

vi.mock('../services/installerBuilder', () => ({
  buildMacosInstallerZip: vi.fn(async () => Buffer.from('fake-zip')),
  buildWindowsInstallerZip: vi.fn(async () => Buffer.from('fake-windows-zip')),
  fetchRegularMsi: vi.fn(async () => Buffer.alloc(2048, 0xbb)),
  assertMacosInstallerPkgsReachable: vi.fn(async () => {}),
  // Plan C — returns null so macOS tests fall through to the legacy pkg path.
  fetchMacosInstallerAppZip: vi.fn(async () => null),
  // Windows bootstrap path — serves static MSI with token in the filename.
  serveWindowsBootstrapMsi: vi.fn((c: any, args: { msi: Buffer; token: string; apiHost: string }) => {
    const filename = `Breeze Agent [${args.token}@${args.apiHost}].msi`;
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    c.header('Content-Length', String(args.msi.length));
    c.header('Cache-Control', 'no-store');
    return c.body(args.msi);
  }),
}));

// Plan C imports — mocked so Vitest can resolve them even though neither is
// called in the legacy (fetchMacosInstallerAppZip → null) code path.
vi.mock('../services/installerAppZip', () => ({
  renameAppInZip: vi.fn(),
}));

vi.mock('../services/installerBootstrapTokenIssuance', () => ({
  issueBootstrapTokenForKey: vi.fn(),
  BootstrapTokenIssuanceError: class BootstrapTokenIssuanceError extends Error {
    code: string;
    constructor(code: string, msg: string) { super(msg); this.code = code; }
  },
}));

vi.mock('../services/msiSigning', () => ({
  MsiSigningService: {
    fromEnv: vi.fn(() => null), // Signing disabled by default in tests
    _resetForTests: vi.fn(),
  },
}));

vi.mock('../services', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 10, resetAt: new Date() })),
}));

import { enrollmentKeyRoutes } from './enrollmentKeys';
import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';
import { MsiSigningService } from '../services/msiSigning';
import { rateLimiter } from '../services/rate-limit';
import { issueBootstrapTokenForKey } from '../services/installerBootstrapTokenIssuance';

const ORG_ID = 'org-111';
const KEY_ID = '11111111-1111-1111-1111-111111111111';

function makeEnrollmentKey(overrides: Record<string, any> = {}) {
  return {
    id: KEY_ID,
    orgId: ORG_ID,
    siteId: 'site-111',
    name: 'Test Key',
    key: 'hashed_abc123',
    keySecretHash: null,
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

/** Mock for db.insert().values().returning()
 *
 * Also queues a single empty db.select().from().where().limit() ahead of
 * the insert to satisfy allocateShortCode()'s uniqueness probe — the
 * installer-download route now generates a short code via a DB lookup
 * before creating the child enrollment key, and returning an empty row
 * set signals "this code is free, use it".
 */
function mockInsertValuesReturning(rows: any[]) {
  mockSelectFromWhereLimit([]); // allocateShortCode uniqueness probe
  vi.mocked(db.insert).mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

/** Mock for db.delete().where() */
function mockDeleteWhere() {
  vi.mocked(db.delete).mockReturnValueOnce({
    where: vi.fn().mockResolvedValue(undefined),
  } as any);
}

describe('enrollment key routes — installer download', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks clears call history but NOT implementations — tests
    // that set mockReturnValue for fromEnv would otherwise leak into
    // subsequent tests. Explicitly reset fromEnv to "signing disabled".
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    // Default: Windows bootstrap token issuance succeeds.
    vi.mocked(issueBootstrapTokenForKey).mockResolvedValue({
      id: 'tok-1',
      token: 'ABCDE12345',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      parentKeyName: 'Test Key',
    } as any);
    process.env.PUBLIC_API_URL = 'https://breeze.example.com';
    app = new Hono();
    app.route('/enrollment-keys', enrollmentKeyRoutes);
  });

  // ============================================
  // GET /:id/installer/:platform
  // ============================================
  describe('GET /enrollment-keys/:id/installer/:platform', () => {
    it('returns 400 for invalid platform', async () => {
      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/linux`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/invalid platform/i);
    });

    it('returns 404 when enrollment key not found', async () => {
      mockSelectFromWhereLimit([]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });

    it('returns 403 for cross-org access', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey({ orgId: 'other-org' })]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(403);
    });

    it('returns 410 for expired key', async () => {
      mockSelectFromWhereLimit([
        makeEnrollmentKey({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) }),
      ]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.error).toMatch(/expired/i);
    });

    it('returns 410 for exhausted key', async () => {
      mockSelectFromWhereLimit([
        makeEnrollmentKey({ usageCount: 10, maxUsage: 10 }),
      ]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.error).toMatch(/exhausted/i);
    });

    it('returns 400 when key has no siteId', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey({ siteId: null })]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/siteId/i);
    });

    it('returns 500 when PUBLIC_API_URL not set', async () => {
      delete process.env.PUBLIC_API_URL;
      delete process.env.API_URL;
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/server url/i);
    });

    it('windows download serves a static MSI named with the bootstrap token', async () => {
      // issueBootstrapTokenForKey default mock returns { token: 'ABCDE12345', ... }
      // PUBLIC_API_URL = 'https://breeze.example.com' → apiHost = 'breeze.example.com'
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="Breeze Agent [ABCDE12345@breeze.example.com].msi"',
      );
      // The static signed MSI bytes are served as-is.
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.length).toBeGreaterThan(0);
    });

    it('windows bootstrap download does not create a child enrollment key', async () => {
      // Windows early-returns after issueBootstrapTokenForKey — no db.insert for a child key.
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('windows bootstrap download uses issueBootstrapTokenForKey with windows platform', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(issueBootstrapTokenForKey).toHaveBeenCalledWith(
        expect.objectContaining({ installerPlatform: 'windows' }),
      );
    });

    it('windows bootstrap returns 503 when MSI fetch fails', async () => {
      const { fetchRegularMsi } = await import('../services/installerBuilder');
      vi.mocked(fetchRegularMsi).mockRejectedValueOnce(new Error('GitHub 404'));

      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/MSI not available/i);
    });

    it('windows bootstrap returns 404 when issueBootstrapTokenForKey reports parent_not_found', async () => {
      const { BootstrapTokenIssuanceError } = await import('../services/installerBootstrapTokenIssuance');
      vi.mocked(issueBootstrapTokenForKey).mockRejectedValueOnce(
        new BootstrapTokenIssuanceError('parent_not_found', 'Key not found'),
      );

      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(404);
    });

    it('windows bootstrap returns 410 when issueBootstrapTokenForKey reports key_expired', async () => {
      const { BootstrapTokenIssuanceError } = await import('../services/installerBootstrapTokenIssuance');
      vi.mocked(issueBootstrapTokenForKey).mockRejectedValueOnce(
        new BootstrapTokenIssuanceError('key_expired', 'Key expired'),
      );

      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(410);
    });

    it('returns zip for macos platform', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/macos`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/zip');
      expect(res.headers.get('Content-Disposition')).toContain('breeze-agent-macos.zip');
    });

    it('creates child key with maxUsage=1 by default (macos)', async () => {
      const parentKey = makeEnrollmentKey();
      mockSelectFromWhereLimit([parentKey]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);

      await app.request(`/enrollment-keys/${KEY_ID}/installer/macos`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(db.insert).toHaveBeenCalledTimes(1);
      const insertMock = vi.mocked(db.insert).mock.results[0]!.value;
      const valuesFn = insertMock.values;
      expect(valuesFn).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: ORG_ID,
          siteId: 'site-111',
          maxUsage: 1,
          name: 'Test Key (installer)',
        })
      );
    });

    it('windows bootstrap passes maxUsage to issueBootstrapTokenForKey (count query param)', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=5`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(issueBootstrapTokenForKey).toHaveBeenCalledWith(
        expect.objectContaining({ maxUsage: 5 }),
      );
      // Windows bootstrap does NOT create a child key (no db.insert)
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('child key honors the ttlMinutes query param (per-link picker) (macos)', async () => {
      const parentKey = makeEnrollmentKey(); // parent: 1h remaining
      mockSelectFromWhereLimit([parentKey]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);

      const ttlMinutes = 43200; // 30 days
      const before = Date.now();
      const res = await app.request(
        `/enrollment-keys/${KEY_ID}/installer/macos?ttlMinutes=${ttlMinutes}`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } },
      );
      const after = Date.now();

      expect(res.status).toBe(200);
      const valuesFn = vi.mocked(db.insert).mock.results[0]!.value.values;
      const insertedRow = valuesFn.mock.calls[0]![0] as { expiresAt: Date };
      const childExpiryMs = insertedRow.expiresAt.getTime();
      const ttlMs = ttlMinutes * 60 * 1000;
      // Fresh window from mint time = the admin's choice, not the 24h
      // CHILD_ENROLLMENT_KEY_TTL_MINUTES default, not the parent's 1h.
      expect(childExpiryMs).toBeGreaterThanOrEqual(before + ttlMs - 50);
      expect(childExpiryMs).toBeLessThanOrEqual(after + ttlMs + 50);
    });

    it('returns 400 for ttlMinutes above the 525_600 cap', async () => {
      const res = await app.request(
        `/enrollment-keys/${KEY_ID}/installer/windows?ttlMinutes=525601`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } },
      );
      expect(res.status).toBe(400);
    });

    // Query-param validation is enforced by the Hono zValidator middleware
    // before any route-body code runs, so these tests do NOT need to stage
    // db.select mocks. Staging them caused `mockReturnValueOnce` queues to
    // leak into the next test (the audit-log test) and the parent-key
    // lookup there would consume the stale mock instead of its own.
    it('returns 400 for count=0', async () => {
      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=0`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for negative count', async () => {
      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=-1`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for non-numeric count', async () => {
      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=abc`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for count exceeding max (100001)', async () => {
      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=100001`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for fractional count', async () => {
      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=1.5`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('emits audit log with count for windows bootstrap installer download', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=3`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'enrollment_key.installer_download',
          details: expect.objectContaining({ count: 3, mode: 'bootstrap-msi' }),
        })
      );
    });

    // ============================================================
    // Signing-spend cap tests (per-user and per-parent-key limits)
    // ============================================================
    describe('signing-spend cap', () => {
      beforeEach(() => {
        // clearAllMocks does NOT drain mockResolvedValueOnce queues — reset rateLimiter
        // and restore the allowed-by-default impl so an unconsumed `Once` value from a
        // prior cap test cannot bleed into the next one's per-user/per-key sequence.
        vi.mocked(rateLimiter).mockReset();
        vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 10, resetAt: new Date() });
      });

      // Signing-spend cap applies to the macOS legacy path (child key creation).
      // Windows early-returns before the cap — it does not go through signing.

      it('allows macOS installer when both per-user and per-key caps are under limit', async () => {
        // Default mock: rateLimiter always returns allowed=true
        mockSelectFromWhereLimit([makeEnrollmentKey()]);
        mockInsertValuesReturning([
          makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
        ]);

        const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/macos`, {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(200);
        // Child key was created
        expect(db.insert).toHaveBeenCalledTimes(1);
      });

      it('returns 429 and does NOT create child key when per-user cap is exceeded (macos)', async () => {
        // First rateLimiter call (per-user) returns denied; second should never be reached
        vi.mocked(rateLimiter)
          .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 3600_000) })
          .mockResolvedValueOnce({ allowed: true, remaining: 20, resetAt: new Date() });

        mockSelectFromWhereLimit([makeEnrollmentKey()]);
        // No insert mock needed — child key must NOT be created

        const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/macos`, {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.error).toMatch(/rate limit/i);
        expect(body.retryAfter).toBeDefined();
        // No child enrollment key created, no signing triggered
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('returns 429 and does NOT create child key when per-parent-key cap is exceeded (macos)', async () => {
        // First rateLimiter call (per-user) passes; second (per-key) is denied
        vi.mocked(rateLimiter)
          .mockResolvedValueOnce({ allowed: true, remaining: 5, resetAt: new Date() })
          .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 3600_000) });

        mockSelectFromWhereLimit([makeEnrollmentKey()]);
        // No insert mock needed — child key must NOT be created

        const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/macos`, {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.error).toMatch(/rate limit/i);
        expect(body.retryAfter).toBeDefined();
        // No child enrollment key created, no signing triggered
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('returns 503 and does NOT create child key when Redis is unavailable (macos)', async () => {
        const { getRedis } = await import('../services');
        vi.mocked(getRedis).mockReturnValueOnce(null as any);

        mockSelectFromWhereLimit([makeEnrollmentKey()]);

        const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/macos`, {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(503);
        // No child enrollment key created
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('windows download bypasses signing-spend cap entirely', async () => {
        // Windows early-returns before the rate limiter — rateLimiter should not be called.
        mockSelectFromWhereLimit([makeEnrollmentKey()]);

        const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(200);
        expect(rateLimiter).not.toHaveBeenCalled();
      });
    });
  });
});
