import { describe, it, expect, vi, beforeEach } from 'vitest';

// The cascade body runs in a BullMQ job — the route only validates +
// enqueues. We mock everything below it.

const { enqueueMock, createAuditLogMock, createAuditLogAsyncMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(async () => ({ id: 'mock-job-id' })),
  createAuditLogMock: vi.fn(async () => undefined),
  createAuditLogAsyncMock: vi.fn(async () => undefined),
}));

vi.mock('../../jobs/tenantErasure', () => ({
  enqueueTenantErasure: enqueueMock,
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: createAuditLogMock,
  createAuditLogAsync: createAuditLogAsyncMock,
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

// Stub authMiddleware: tests inject their own `auth` context via the
// pre-route middleware shim below.
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
    requireMfa: vi.fn(() => async (c: any, next: () => Promise<void>) => {
      const auth = c.get('auth');
      if (!auth) {
        // Mirror real behavior: 401 when no auth, 403 when MFA missing.
        return c.json({ error: 'Not authenticated' }, 401);
      }
      if (auth.token?.mfa === false) {
        return c.json({ error: 'MFA required' }, 403);
      }
      await next();
    }),
  };
});

const { orgLookup } = vi.hoisted(() => ({
  orgLookup: {
    current: null as null | { id: string; name: string; partnerId: string },
  },
}));

vi.mock('../../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(orgLookup.current ? [orgLookup.current] : []),
        }),
      }),
    })),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => ({
  // Spread the real schema so transitive imports resolve; override the tables
  // this suite asserts on with opaque tokens below.
  ...(await importOriginal<typeof import('../../db/schema')>()),
  organizations: {
    id: 'organizations.id',
    name: 'organizations.name',
    partnerId: 'organizations.partnerId',
  },
}));

import { Hono } from 'hono';
import { adminRoutes } from './index';

type FakeAuth = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

function buildApp(authToInject: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (authToInject) {
      c.set('auth', authToInject as never);
    }
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const platformAdminAuth: FakeAuth = {
  user: {
    id: 'admin-1',
    email: 'admin@breeze.test',
    name: 'PA',
    isPlatformAdmin: true,
  },
  token: { mfa: true },
};

const platformAdminAuthNoMfa: FakeAuth = {
  user: {
    id: 'admin-1',
    email: 'admin@breeze.test',
    name: 'PA',
    isPlatformAdmin: true,
  },
  token: { mfa: false },
};

const partnerAdminAuth: FakeAuth = {
  user: {
    id: 'pa-1',
    email: 'partner@x.com',
    name: 'PartnerAdmin',
    isPlatformAdmin: false,
  },
  token: { mfa: true },
};

const ORG_ID = '11111111-1111-1111-1111-111111111111';

describe('POST /admin/tenant-erasure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgLookup.current = { id: ORG_ID, name: 'Acme Inc', partnerId: 'p-1' };
  });

  it('returns 403 when caller is not a platform admin', async () => {
    const app = buildApp(partnerAdminAuth);
    const res = await app.request('/admin/tenant-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, confirmEmail: 'partner@x.com' }),
    });
    expect(res.status).toBe(403);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('returns 401/403 when caller has not completed MFA', async () => {
    const app = buildApp(platformAdminAuthNoMfa);
    const res = await app.request('/admin/tenant-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, confirmEmail: 'admin@breeze.test' }),
    });
    expect(res.status).toBe(403);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('returns 400 when confirmEmail does not match the caller email', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/tenant-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, confirmEmail: 'wrong@example.com' }),
    });
    expect(res.status).toBe(400);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid body (non-UUID orgId)', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/tenant-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'not-a-uuid', confirmEmail: 'admin@breeze.test' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the org does not exist', async () => {
    orgLookup.current = null;
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/tenant-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, confirmEmail: 'admin@breeze.test' }),
    });
    expect(res.status).toBe(404);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('enqueues a job and returns 202 with the jobId on success', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/tenant-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, confirmEmail: 'admin@breeze.test' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(body.jobId).toBe('mock-job-id');
    expect(body.orgId).toBe(ORG_ID);
    expect(body.orgName).toBe('Acme Inc');
    expect(enqueueMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      performedBy: 'admin-1',
      performedByEmail: 'admin@breeze.test',
    });
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.erasure.enqueued',
        resourceId: ORG_ID,
        resourceName: 'Acme Inc',
      }),
    );
  });

  it('treats confirmEmail comparison as case-insensitive', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/tenant-erasure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: ORG_ID,
        confirmEmail: 'ADMIN@breeze.TEST',
      }),
    });
    expect(res.status).toBe(202);
  });
});
