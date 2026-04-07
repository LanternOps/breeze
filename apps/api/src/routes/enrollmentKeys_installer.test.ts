import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
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
  replaceMsiPlaceholders: vi.fn((buf: Buffer) => buf),
  buildMacosInstallerZip: vi.fn(async () => Buffer.from('fake-zip')),
}));

vi.mock('../services/binarySource', () => ({
  getBinarySource: vi.fn(() => 'local'),
  getGithubTemplateMsiUrl: vi.fn(() => 'https://example.com/template.msi'),
  getGithubAgentPkgUrl: vi.fn(() => 'https://example.com/agent.pkg'),
}));

// Mock node:fs/promises for local binary reads
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => Buffer.alloc(2048, 0xaa)),
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

/** Mock for db.insert().values().returning() */
function mockInsertValuesReturning(rows: any[]) {
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

    it('returns MSI for windows platform', async () => {
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

    it('returns 400 for count=0', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=0`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for negative count', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=-1`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for non-numeric count', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=abc`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for count exceeding max (100001)', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer/windows?count=100001`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for fractional count', async () => {
      mockSelectFromWhereLimit([makeEnrollmentKey()]);

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
