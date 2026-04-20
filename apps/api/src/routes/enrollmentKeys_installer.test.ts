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
}));

vi.mock('../services/installerBuilder', () => ({
  buildMacosInstallerZip: vi.fn(async () => Buffer.from('fake-zip')),
  buildWindowsInstallerZip: vi.fn(async () => Buffer.from('fake-windows-zip')),
  fetchRegularMsi: vi.fn(async () => Buffer.alloc(2048, 0xbb)),
  fetchMacosPkg: vi.fn(async () => Buffer.alloc(2048, 0xcc)),
  // Plan C — returns null so macOS tests fall through to the legacy pkg path.
  fetchMacosInstallerAppZip: vi.fn(async () => null),
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

import { enrollmentKeyRoutes } from './enrollmentKeys';
import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';
import { MsiSigningService } from '../services/msiSigning';

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

    it('returns zip bundle for windows when signing not configured', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/zip');
      expect(res.headers.get('Content-Disposition')).toContain('breeze-agent-windows.zip');
    });

    it('returns signed MSI for windows when signing configured', async () => {
      process.env.BINARY_VERSION = '0.62.24';
      const buildAndSignMsi = vi.fn(async () => Buffer.from('signed-msi-content'));
      vi.mocked(MsiSigningService.fromEnv).mockReturnValue({
        buildAndSignMsi,
        probe: vi.fn(async () => {}),
      } as any);

      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(res.headers.get('Content-Disposition')).toContain('breeze-agent.msi');

      // When signing is configured, the route must NOT fetch any local
      // binary — the signing service owns template fetching.
      const { fetchRegularMsi } = await import('../services/installerBuilder');
      expect(fetchRegularMsi).not.toHaveBeenCalled();

      delete process.env.BINARY_VERSION;
    });

    it('passes v-prefixed version and 64-hex key to buildAndSignMsi', async () => {
      process.env.BINARY_VERSION = '0.62.24';
      const buildAndSignMsi = vi.fn(async () => Buffer.from('signed-msi-content'));
      vi.mocked(MsiSigningService.fromEnv).mockReturnValue({
        buildAndSignMsi,
        probe: vi.fn(async () => {}),
      } as any);

      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);

      await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(buildAndSignMsi).toHaveBeenCalledTimes(1);
      const req = (buildAndSignMsi.mock.calls[0] as unknown as [{
        version: string;
        properties: { SERVER_URL: string; ENROLLMENT_KEY: string; ENROLLMENT_SECRET?: string };
      }])[0];
      // Signing service uses GitHub release tags (v-prefixed) as cache keys
      expect(req.version).toBe('v0.62.24');
      expect(req.properties.SERVER_URL).toBe('https://breeze.example.com');
      expect(req.properties.ENROLLMENT_KEY).toMatch(/^[a-f0-9]{64}$/);

      delete process.env.BINARY_VERSION;
    });

    it('omits ENROLLMENT_SECRET when AGENT_ENROLLMENT_SECRET is unset', async () => {
      delete process.env.AGENT_ENROLLMENT_SECRET;
      process.env.BINARY_VERSION = '0.62.24';
      const buildAndSignMsi = vi.fn(async () => Buffer.from('signed-msi-content'));
      vi.mocked(MsiSigningService.fromEnv).mockReturnValue({
        buildAndSignMsi,
        probe: vi.fn(async () => {}),
      } as any);

      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);

      await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      const req = (buildAndSignMsi.mock.calls[0] as unknown as [{
        properties: Record<string, unknown>;
      }])[0];
      expect(req.properties).not.toHaveProperty('ENROLLMENT_SECRET');

      delete process.env.BINARY_VERSION;
    });

    it('passes ENROLLMENT_SECRET when AGENT_ENROLLMENT_SECRET is set', async () => {
      process.env.AGENT_ENROLLMENT_SECRET = 'deployment-wide-secret';
      process.env.BINARY_VERSION = '0.62.24';
      const buildAndSignMsi = vi.fn(async () => Buffer.from('signed-msi-content'));
      vi.mocked(MsiSigningService.fromEnv).mockReturnValue({
        buildAndSignMsi,
        probe: vi.fn(async () => {}),
      } as any);

      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);

      await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      const req = (buildAndSignMsi.mock.calls[0] as unknown as [{
        properties: { ENROLLMENT_SECRET?: string };
      }])[0];
      expect(req.properties.ENROLLMENT_SECRET).toBe('deployment-wide-secret');

      delete process.env.AGENT_ENROLLMENT_SECRET;
      delete process.env.BINARY_VERSION;
    });

    it('returns 500 with error detail when signing configured but fails', async () => {
      vi.mocked(MsiSigningService.fromEnv).mockReturnValue({
        buildAndSignMsi: vi.fn(async () => { throw new Error('signing service returned 401: CF Access denied'); }),
        probe: vi.fn(async () => {}),
      } as any);

      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);
      mockDeleteWhere(); // for orphan cleanup

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Failed to build installer');
      // Route is MFA-gated — admin debugging a misconfig sees the cause.
      expect(body.detail).toContain('CF Access denied');
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

    it('creates child key with maxUsage=1 by default', async () => {
      const parentKey = makeEnrollmentKey();
      mockSelectFromWhereLimit([parentKey]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer)', maxUsage: 1 }),
      ]);

      await app.request(`/enrollment-keys/${KEY_ID}/installer/windows`, {
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

    it('creates child key with count query param', async () => {
      const parentKey = makeEnrollmentKey();
      mockSelectFromWhereLimit([parentKey]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer x5)', maxUsage: 5 }),
      ]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=5`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(db.insert).toHaveBeenCalledTimes(1);
      const insertMock = vi.mocked(db.insert).mock.results[0]!.value;
      const valuesFn = insertMock.values;
      expect(valuesFn).toHaveBeenCalledWith(
        expect.objectContaining({
          maxUsage: 5,
          name: 'Test Key (installer x5)',
        })
      );
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

    it('emits audit log with count for installer download', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);
      mockInsertValuesReturning([
        makeEnrollmentKey({ id: 'child-key-id', name: 'Test Key (installer x3)', maxUsage: 3 }),
      ]);

      await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=3`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'enrollment_key.installer_download',
          details: expect.objectContaining({ count: 3 }),
        })
      );
    });
  });
});
