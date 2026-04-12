import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  replaceMsiPlaceholders: vi.fn(),
  buildWindowsInstallerZip: vi.fn(async () => Buffer.from('windows-zip')),
  buildMacosInstallerZip: vi.fn(async () => Buffer.from('macos-zip')),
  fetchTemplateMsi: vi.fn(async () => Buffer.from('template-msi')),
  fetchRegularMsi: vi.fn(async () => Buffer.from('regular-msi')),
  fetchMacosPkg: vi.fn(async () => Buffer.from('macos-pkg')),
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
import { enrollmentKeyRoutes, publicShortLinkRoutes } from './enrollmentKeys';
import { db } from '../db';

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
