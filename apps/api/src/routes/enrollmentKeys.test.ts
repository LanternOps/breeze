import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'crypto';

// ============================================================
// Mocks — must appear before any `import` of the source
// ============================================================

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  enrollmentKeys: {},
  installerBootstrapTokens: {},
}));

vi.mock('../db/schema/orgs', () => ({
  enrollmentKeys: {},
}));

vi.mock('../db/schema/installerBootstrapTokens', () => ({
  installerBootstrapTokens: {},
}));

vi.mock('../services/installerBootstrapToken', () => ({
  generateBootstrapToken: vi.fn(() => 'ABC1234567'),
  bootstrapTokenExpiresAt: vi.fn(() => new Date('2026-04-20T00:00:00.000Z')),
  BOOTSTRAP_TOKEN_PATTERN: /^[A-Z0-9]{10}$/,
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'system',
      orgId: null,
      user: { id: 'user-system', email: 'system@example.com' },
      canAccessOrg: () => true,
      accessibleOrgIds: [],
    });
    return next();
  }),
  requireScope: () => vi.fn((_c: any, next: any) => next()),
  requirePermission: () => vi.fn((_c: any, next: any) => next()),
  requireMfa: () => vi.fn((_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'orgs', action: 'read' },
    ORGS_WRITE: { resource: 'orgs', action: 'write' },
  },
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((raw: string) => `hashed:${raw}`),
}));

vi.mock('../services/msiSigning', () => ({
  MsiSigningService: { fromEnv: vi.fn(() => null) },
}));

vi.mock('../services/installerBuilder', () => ({
  buildWindowsInstallerZip: vi.fn(async () => Buffer.from('windows-zip')),
  buildMacosInstallerZip: vi.fn(async () => Buffer.from('macos-zip')),
  fetchRegularMsi: vi.fn(async () => Buffer.from('regular-msi')),
  fetchMacosPkg: vi.fn(async () => Buffer.from('macos-pkg')),
  fetchMacosInstallerAppZip: vi.fn(async () => null),
}));

vi.mock('../services/installerAppZip', () => ({
  renameAppInZip: vi.fn(async (buf: Buffer) => buf),
}));

// Mock dynamic imports inside serveInstaller
vi.mock('../services', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true })),
}));

// ============================================================
// Import after mocks
// ============================================================
import { enrollmentKeyRoutes, publicEnrollmentRoutes, publicShortLinkRoutes } from './enrollmentKeys';
import { db, withSystemDbAccessContext } from '../db';
import { MsiSigningService } from '../services/msiSigning';
import { fetchMacosInstallerAppZip } from '../services/installerBuilder';
import { renameAppInZip } from '../services/installerAppZip';
import * as installerBootstrapTokenIssuance from '../services/installerBootstrapTokenIssuance';

// ============================================================
// Helpers
// ============================================================

const ORG_ID = randomUUID();
const SITE_ID = randomUUID();
const KEY_ID = randomUUID();
const CHILD_KEY_ID = randomUUID();

function makeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    name: 'Test Key',
    key: 'hashed:rawkey',
    keySecretHash: null,
    shortCode: null,
    installerPlatform: null,
    maxUsage: 10,
    usageCount: 0,
    expiresAt: new Date(Date.now() + 3_600_000), // 1 hour from now
    createdBy: 'user-system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeChildKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHILD_KEY_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    name: 'Test Key (link)',
    key: 'hashed:childkey',
    keySecretHash: null,
    shortCode: 'Ab3De5Fg7H',
    installerPlatform: 'windows',
    maxUsage: 1,
    usageCount: 0,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdBy: 'user-system',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('POST /enrollment-keys/:id/installer-link', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    app = new Hono();
    app.route('/enrollment-keys', enrollmentKeyRoutes);
  });

  it('returns shortUrl in response', async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow();

    // First select: look up parent key
    vi.mocked(db.select)
      // allocateShortCode: look up existing short code (not found → unique)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    // insert: create child key
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'windows' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shortUrl).toMatch(/^https?:\/\/.+\/s\/[A-Za-z0-9]{10}$/);
  });

  it('refuses to build an installer when parent key is within 60s of expiry', async () => {
    // Parent with only 30s of life left. Previously the child inherited this
    // and was DOA. Now the route refuses with 410 so the admin can regenerate.
    // NOTE: handler returns 410 before calling db.insert. Using the persistent
    // mockReturnValue here (not mockReturnValueOnce) so unconsumed entries
    // do not leak onto the queue and poison subsequent tests.
    const parentRow = makeKeyRow({
      expiresAt: new Date(Date.now() + 30_000),
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parentRow]),
        }),
      }),
    } as any);

    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'windows' }),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toContain('expires too soon');
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('child key gets a 24h TTL when parent has enough remaining life', async () => {
    // Parent has 1h remaining (plenty) — child insert should fire with a
    // fresh ~24h expiresAt, independent of parent.
    const parentRow = makeKeyRow({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h
    });
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([childRow]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const before = Date.now();
    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'windows' }),
    });
    const after = Date.now();
    expect(res.status).toBe(200);

    expect(insertValues).toHaveBeenCalledTimes(1);
    const firstCall = insertValues.mock.calls[0]!;
    const insertedRow = firstCall[0] as { expiresAt: Date };
    const childExpiryMs = insertedRow.expiresAt.getTime();
    // Child TTL must be at least 23 hours past "before" (well above parent's 1h)
    expect(childExpiryMs).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
    // And no more than 25 hours past "after" (guards against runaway values)
    expect(childExpiryMs).toBeLessThan(after + 25 * 60 * 60 * 1000);
    // Explicitly NOT the parent's expiresAt
    expect(childExpiryMs).not.toBe(parentRow.expiresAt.getTime());
  });

  it('shortUrl and url share the same origin', async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'windows' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const urlOrigin = new URL(body.url).origin;
    const shortUrlOrigin = new URL(body.shortUrl).origin;
    expect(urlOrigin).toBe(shortUrlOrigin);
  });
});

// ============================================================
// GET /s/:code  (publicShortLinkRoutes)
// ============================================================

describe('GET /s/:code', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    app = new Hono();
    app.route('/s', publicShortLinkRoutes);
  });

  it('serves installer for valid code', async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: 'abc1234567',
      installerPlatform: 'windows',
    });
    const childRow = makeChildKeyRow({ installerPlatform: 'windows' });

    // select: look up by shortCode
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    // insert: spawn single-use child key
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // update: atomic usage increment (claimed successfully)
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);

    // serveInstaller also calls db.update to increment child key usage
    // (second update call is handled by same mock — returns the same shape)

    const res = await app.request('/s/abc1234567');

    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('returns 404 for unknown code', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.request('/s/unknowncode');
    expect(res.status).toBe(404);
  });

  it('returns 410 for expired key', async () => {
    const expiredRow = makeKeyRow({
      shortCode: 'expiredcode',
      installerPlatform: 'windows',
      expiresAt: new Date(Date.now() - 10_000), // past
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([expiredRow]),
        }),
      }),
    } as any);

    const res = await app.request('/s/expiredcode');
    expect(res.status).toBe(410);
  });

  it('returns 410 when atomic update returns empty (usage exhausted at increment)', async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: 'fullcode567',
      installerPlatform: 'windows',
      maxUsage: 1,
      usageCount: 0, // pre-check passes...
    });
    const childRow = makeChildKeyRow({ installerPlatform: 'windows' });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // Atomic update returns empty → another request beat us to it
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]), // empty = limit hit
        }),
      }),
    } as any);

    // delete: clean up orphaned child key
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as any);

    const res = await app.request('/s/fullcode567');
    expect(res.status).toBe(410);
  });

  it('returns 404 for code longer than 12 chars', async () => {
    const res = await app.request('/s/this-code-is-way-too-long-for-sure');
    expect(res.status).toBe(404);
  });

  it('returns 404 when row has null installerPlatform', async () => {
    const rowNoPlatform = makeKeyRow({
      shortCode: 'noplatform1',
      installerPlatform: null,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rowNoPlatform]),
        }),
      }),
    } as any);

    const res = await app.request('/s/noplatform1');
    expect(res.status).toBe(404);
  });
});

// ============================================================
// GET /public-download/:platform — RLS scoping regression test
// ============================================================

describe('GET /public-download/:platform', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    app = new Hono();
    app.route('/enrollment-keys', publicEnrollmentRoutes);
  });

  it('does not bump child key usage_count on download — leaves the slot for the agent enroll call', async () => {
    // Regression test for the root cause of the MSI "401 Invalid or
    // expired enrollment key" bug. Previously serveInstaller ran
    // `UPDATE enrollment_keys SET usage_count = usage_count + 1 WHERE
    // id = :keyRow.id` right after a successful build. Combined with
    // max_usage = 1 on single-use child keys (short-link downloads and
    // single-count installer links), this burned the enrollment slot
    // at *download* time: by the time the agent POSTed to
    // /agents/enroll, the child row already had usage_count >=
    // max_usage, the enroll endpoint's `usage_count < max_usage`
    // filter rejected the row, and the agent saw the deliberately-opaque
    // "Invalid or expired enrollment key" 401. The enroll endpoint
    // itself owns the slot-consuming UPDATE under a TOCTOU-safe
    // `UPDATE ... WHERE usage_count < max_usage`, so downloads must
    // NOT bump usage_count. max_usage is "max successful enrollments,"
    // not "max downloads."
    const row = makeKeyRow({
      shortCode: 'pubcode1234',
      installerPlatform: 'windows',
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    // Fail loudly if anything inside the download path touches
    // db.update — the whole point of the fix is that the download path
    // is now read-only against the enrollment_keys row.
    vi.mocked(db.update).mockImplementation(() => {
      throw new Error('db.update called on public-download — regression of the usage_count-burn bug');
    });

    const res = await app.request(
      '/enrollment-keys/public-download/windows?token=abc123',
    );

    expect(res.status).toBe(200);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('uses the remote signing service (no local binary fetch) when configured', async () => {
    // Regression guard for the most-hit installer path in production. When
    // MsiSigningService is configured, serveInstaller must:
    //   1. NOT call fetchRegularMsi / fetchMacosPkg / anything local,
    //   2. call buildAndSignMsi with the correct version + properties,
    //   3. serve the result as application/octet-stream.
    process.env.BINARY_VERSION = '0.62.24';

    const buildAndSignMsi = vi.fn(async () => Buffer.from('signed-msi-bytes'));
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue({
      buildAndSignMsi,
      probe: vi.fn(async () => {}),
    } as any);

    const row = makeKeyRow({
      shortCode: 'pubcode1234',
      installerPlatform: 'windows',
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    const { fetchRegularMsi, fetchMacosPkg } = await import('../services/installerBuilder');

    const res = await app.request(
      '/enrollment-keys/public-download/windows?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toContain('breeze-agent.msi');

    expect(fetchRegularMsi).not.toHaveBeenCalled();
    expect(fetchMacosPkg).not.toHaveBeenCalled();

    expect(buildAndSignMsi).toHaveBeenCalledTimes(1);
    const req = (buildAndSignMsi.mock.calls[0] as unknown as [{
      version: string;
      properties: { SERVER_URL: string; ENROLLMENT_KEY: string; ENROLLMENT_SECRET?: string };
    }])[0];
    // Signing service uses GitHub release tags (v-prefixed) as cache keys
    expect(req.version).toBe('v0.62.24');
    expect(req.properties.SERVER_URL).toBe('https://api.example.com');
    // The token from ?token= is embedded verbatim as ENROLLMENT_KEY.
    expect(req.properties.ENROLLMENT_KEY).toBe(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );

    delete process.env.BINARY_VERSION;
  });
});

// ============================================================
// POST /:id/bootstrap-token
// ============================================================

describe('POST /:id/bootstrap-token', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    app = new Hono();
    app.route('/enrollment-keys', enrollmentKeyRoutes);
  });

  it('issues a bootstrap token for a valid parent key', async () => {
    const parent = makeKeyRow();

    // select x2: route's access-control lookup + helper's business-rule lookup
    const parentSelectMock = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any;
    vi.mocked(db.select)
      .mockReturnValueOnce(parentSelectMock)
      .mockReturnValueOnce(parentSelectMock);

    // insert: create bootstrap token row — helper now uses .returning() to get the row id
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'token-row-uuid-1' }]),
      }),
    } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/bootstrap-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUsage: 1 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^[A-Z0-9]{10}$/);
    expect(body.expiresAt).toBeTypeOf('string');
    expect(body.maxUsage).toBe(1);
  });

  it('rejects unknown parent key with 404', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.request('/enrollment-keys/missing/bootstrap-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUsage: 1 }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects when caller has no org access (403)', async () => {
    // Override authMiddleware to return a scope where canAccessOrg returns false
    const { authMiddleware: mockAuth } = await import('../middleware/auth');
    vi.mocked(mockAuth).mockImplementationOnce((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        orgId: null,
        user: { id: 'user-partner', email: 'partner@example.com' },
        canAccessOrg: () => false,
        accessibleOrgIds: [],
      });
      return next();
    });

    const restrictedApp = new Hono();
    restrictedApp.route('/enrollment-keys', enrollmentKeyRoutes);

    const parent = makeKeyRow();

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any);

    const res = await restrictedApp.request(`/enrollment-keys/${KEY_ID}/bootstrap-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUsage: 1 }),
    });

    expect(res.status).toBe(403);
  });

  it('rejects expired parent key with 410', async () => {
    const expiredParent = makeKeyRow({
      expiresAt: new Date(Date.now() - 10_000), // past
    });

    // select x2: route's access-control lookup + helper's business-rule lookup
    const expiredSelectMock = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([expiredParent]),
        }),
      }),
    } as any;
    vi.mocked(db.select)
      .mockReturnValueOnce(expiredSelectMock)
      .mockReturnValueOnce(expiredSelectMock);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/bootstrap-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUsage: 1 }),
    });

    expect(res.status).toBe(410);
  });
});

// ============================================================
// GET /:id/installer/macos — app-bundle path
// ============================================================

describe('GET /:id/installer/macos — app-bundle path', () => {
  let app: Hono;
  let issueSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    app = new Hono();
    app.route('/enrollment-keys', enrollmentKeyRoutes);

    // Default: issueBootstrapTokenForKey succeeds with a fixed token
    issueSpy = vi.spyOn(installerBootstrapTokenIssuance, 'issueBootstrapTokenForKey').mockResolvedValue({
      id: 'token-row-uuid-1',
      token: 'ABC1234567',
      expiresAt: new Date('2026-04-20T00:00:00.000Z'),
      parentKeyName: 'Test Key',
    });
  });

  afterEach(() => {
    issueSpy.mockRestore();
  });

  it('returns a renamed app zip when installer app is available', async () => {
    const parentRow = makeKeyRow();

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parentRow]),
        }),
      }),
    } as any);

    // fetchMacosInstallerAppZip returns a fixture buffer
    vi.mocked(fetchMacosInstallerAppZip).mockResolvedValueOnce(Buffer.from('fixture-app-zip'));

    // renameAppInZip returns a renamed buffer
    vi.mocked(renameAppInZip).mockResolvedValueOnce(Buffer.from('renamed-app-zip'));

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer/macos?count=1`,
      { headers: { authorization: 'Bearer jwt' } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    const cd = res.headers.get('Content-Disposition') ?? '';
    // Should contain the bootstrap token + api host embedded in the filename
    expect(cd).toMatch(/Breeze Installer \[ABC1234567@api\.example\.com\]\.app\.zip/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    // renameAppInZip was called with correct args
    expect(vi.mocked(renameAppInZip)).toHaveBeenCalledWith(
      Buffer.from('fixture-app-zip'),
      expect.objectContaining({
        oldAppName: 'Breeze Installer.app',
        newAppName: 'Breeze Installer [ABC1234567@api.example.com].app',
      }),
    );
  });

  it('falls back to legacy zip when ?legacy=1 is passed', async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow({ installerPlatform: 'macos' });

    // select: parent key lookup + allocateShortCode dedup check
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]), // no existing short code → unique
          }),
        }),
      } as any);

    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // fetchMacosInstallerAppZip is NOT called when ?legacy=1 is passed
    // (wantLegacy=true → appZip=null without calling the function)

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer/macos?count=1&legacy=1`,
      { headers: { authorization: 'Bearer jwt' } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('breeze-agent-macos.zip');
    // The app-bundle path must NOT have been called
    expect(vi.mocked(renameAppInZip)).not.toHaveBeenCalled();
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it('falls back to legacy zip when installer app asset is missing (returns null)', async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow({ installerPlatform: 'macos' });

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // fetchMacosInstallerAppZip default mock returns null → falls back to legacy path

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer/macos?count=1`,
      { headers: { authorization: 'Bearer jwt' } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('breeze-agent-macos.zip');
    expect(vi.mocked(renameAppInZip)).not.toHaveBeenCalled();
    expect(issueSpy).not.toHaveBeenCalled();
  });
});
