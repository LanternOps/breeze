import { describe, it, expect, vi, beforeEach } from 'vitest';

const { buildOrgExportZipMock, orgLookup } = vi.hoisted(() => ({
  buildOrgExportZipMock: vi.fn(async () => ({
    manifest: {
      exportedAt: '2026-05-25T00:00:00.000Z',
      orgId: '11111111-1111-1111-1111-111111111111',
      actor: 'admin-1',
      actorEmail: 'admin@breeze.test',
      files: [{ name: 'devices.json', sha256: 'abc', rowCount: 0 }],
    },
    zipBuffer: Buffer.from('PK\x03\x04mock zip content'),
  })),
  orgLookup: { current: null as null | { id: string; name: string } },
}));

vi.mock('../../services/tenantExport', () => ({
  buildOrgExportZip: buildOrgExportZipMock,
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return {
    ...actual,
    authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
  };
});

vi.mock('../../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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

vi.mock('../../db/schema', () => ({
  organizations: {
    id: 'organizations.id',
    name: 'organizations.name',
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
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};

const partnerAdminAuth: FakeAuth = {
  user: { id: 'p-1', email: 'p@x.com', name: 'P', isPlatformAdmin: false },
  token: { mfa: true },
};

const ORG_ID = '11111111-1111-1111-1111-111111111111';

describe('GET /admin/tenant-export/:orgId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgLookup.current = { id: ORG_ID, name: 'Acme Inc' };
  });

  it('returns 403 to non-platform-admin callers', async () => {
    const app = buildApp(partnerAdminAuth);
    const res = await app.request(`/admin/tenant-export/${ORG_ID}`);
    expect(res.status).toBe(403);
    expect(buildOrgExportZipMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid (non-UUID) orgId', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/tenant-export/not-a-uuid');
    expect(res.status).toBe(400);
    expect(buildOrgExportZipMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the org does not exist', async () => {
    orgLookup.current = null;
    const app = buildApp(platformAdminAuth);
    const res = await app.request(`/admin/tenant-export/${ORG_ID}`);
    expect(res.status).toBe(404);
    expect(buildOrgExportZipMock).not.toHaveBeenCalled();
  });

  it('returns the ZIP body with the right headers on success', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request(`/admin/tenant-export/${ORG_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(
      `breeze-org-${ORG_ID}-export.zip`,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.arrayBuffer();
    expect(new TextDecoder().decode(body)).toContain('PK');
    expect(buildOrgExportZipMock).toHaveBeenCalledWith(
      ORG_ID,
      'admin-1',
      'admin@breeze.test',
    );
  });

  it('returns 500 when the export builder throws', async () => {
    buildOrgExportZipMock.mockRejectedValueOnce(new Error('boom'));
    const app = buildApp(platformAdminAuth);
    const res = await app.request(`/admin/tenant-export/${ORG_ID}`);
    expect(res.status).toBe(500);
  });
});
