/**
 * Strict-mode regression tests for enrollment-key write schemas.
 *
 * Closes #945 — a misspelled `maxUses` (canonical: `maxUsage`) used to be
 * silently dropped by Zod's permissive default, and the request returned
 * 201 with the server default for maxUsage. After `.strict()` was added to
 * each write schema, unknown fields surface as a 400 with the offending
 * key name in the response body.
 */
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

import { enrollmentKeyRoutes } from './enrollmentKeys';

const KEY_ID = '11111111-1111-1111-1111-111111111111';

const HEADERS = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer token',
} as const;

/**
 * The Hono zValidator default error hook returns `c.json({ success: false,
 * error }, 400)` where `error` is the serialized ZodError. The exact JSON
 * shape isn't part of our public contract, so this helper just stringifies
 * the body and asserts the offending key name appears somewhere in it —
 * enough to confirm the unknown-key was surfaced to the caller.
 */
async function bodyContains(res: Response, needle: string): Promise<boolean> {
  const text = await res.text();
  return text.includes(needle);
}

describe('enrollment key routes — strict mode (closes #945)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/enrollment-keys', enrollmentKeyRoutes);
  });

  describe('POST /enrollment-keys', () => {
    it('rejects misspelled maxUses with 400 and surfaces the unknown key', async () => {
      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ name: 'Typo key', maxUses: 5 }),
      });

      expect(res.status).toBe(400);
      expect(await bodyContains(res, 'maxUses')).toBe(true);
    });

    it('rejects an arbitrary unknown field with 400', async () => {
      const res = await app.request('/enrollment-keys', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ name: 'Key', somethingRandom: 'value' }),
      });

      expect(res.status).toBe(400);
      expect(await bodyContains(res, 'somethingRandom')).toBe(true);
    });
  });

  describe('POST /enrollment-keys/:id/rotate', () => {
    it('rejects misspelled maxUses with 400', async () => {
      const res = await app.request(`/enrollment-keys/${KEY_ID}/rotate`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ maxUses: 5 }),
      });

      expect(res.status).toBe(400);
      expect(await bodyContains(res, 'maxUses')).toBe(true);
    });
  });

  describe('POST /enrollment-keys/:id/installer-link', () => {
    it('rejects unknown field with 400', async () => {
      const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ platform: 'windows', maxUses: 5 }),
      });

      expect(res.status).toBe(400);
      expect(await bodyContains(res, 'maxUses')).toBe(true);
    });
  });

  describe('POST /enrollment-keys/:id/bootstrap-token', () => {
    it('rejects unknown field with 400', async () => {
      const res = await app.request(`/enrollment-keys/${KEY_ID}/bootstrap-token`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ maxUses: 5 }),
      });

      expect(res.status).toBe(400);
      expect(await bodyContains(res, 'maxUses')).toBe(true);
    });
  });
});
