/**
 * #6605 wave 2 — GET /api/v1/admin/deprecations, the read-only deployment
 * deprecations report behind Settings → System → Deprecations.
 *
 * Pins the posture: platform admins only (the data is deployment-wide, not per
 * tenant — decision on #6605, 2026-09-22), partner and org users get 403, the
 * route reads through the request DB reader only, and a failed read degrades
 * to the broad report rather than an error or "no issues".
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { readStateMock } = vi.hoisted(() => ({ readStateMock: vi.fn() }));

vi.mock('../../upgrade/deprecationsReport', async () => {
  const actual = await vi.importActual<typeof import('../../upgrade/deprecationsReport')>(
    '../../upgrade/deprecationsReport',
  );
  return { ...actual, readRequestDeploymentState: readStateMock };
});

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});

import { Hono } from 'hono';
import { adminRoutes } from './index';
import { BREAKING_CHANGES_MANIFEST } from '../../upgrade/breakingChangesManifest';

type FakeAuth = {
  scope: 'system' | 'partner' | 'organization';
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

const platformAdmin: FakeAuth = {
  scope: 'partner',
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};
const partnerAdmin: FakeAuth = {
  scope: 'partner',
  user: { id: 'pa-1', email: 'partner@x.com', name: 'Partner', isPlatformAdmin: false },
  token: { mfa: true },
};
const orgUser: FakeAuth = {
  scope: 'organization',
  user: { id: 'ou-1', email: 'org@x.com', name: 'Org', isPlatformAdmin: false },
  token: { mfa: true },
};

function buildApp(auth: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const ORIGINAL_APP_VERSION = process.env.APP_VERSION;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_VERSION = '0.116.0';
  readStateMock.mockImplementation(async (currentVersion: string) => ({
    currentVersion,
    history: {
      status: 'ok',
      versions: [
        { version: '0.115.0', firstSeenAt: new Date('2026-09-01T00:00:00Z') },
        { version: '0.116.0', firstSeenAt: new Date('2026-09-23T00:00:00Z') },
      ],
    },
    ledger: { status: 'ok', appliedCount: 610, pendingCount: 0 },
  }));
});

afterAll(() => {
  if (ORIGINAL_APP_VERSION === undefined) delete process.env.APP_VERSION;
  else process.env.APP_VERSION = ORIGINAL_APP_VERSION;
});

describe('GET /admin/deprecations — access', () => {
  it('401 without an authenticated session', async () => {
    const res = await buildApp(null).request('/admin/deprecations');
    expect(res.status).toBe(401);
    expect(readStateMock).not.toHaveBeenCalled();
  });

  it('403 for a partner admin who is not a platform admin', async () => {
    const res = await buildApp(partnerAdmin).request('/admin/deprecations');
    expect(res.status).toBe(403);
    expect(readStateMock).not.toHaveBeenCalled();
  });

  it('403 for an organization user', async () => {
    const res = await buildApp(orgUser).request('/admin/deprecations');
    expect(res.status).toBe(403);
    expect(readStateMock).not.toHaveBeenCalled();
  });

  it('200 for a platform admin', async () => {
    const res = await buildApp(platformAdmin).request('/admin/deprecations');
    expect(res.status).toBe(200);
    expect(readStateMock).toHaveBeenCalledWith('0.116.0');
  });

  it('exposes GET only — no write verb exists on the report', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await buildApp(platformAdmin).request('/admin/deprecations', { method });
      expect(res.status, method).toBe(404);
    }
  });
});

describe('GET /admin/deprecations — report', () => {
  it('returns every manifest entry with its status for this deployment, plus history and ledger', async () => {
    const res = await buildApp(platformAdmin).request('/admin/deprecations');
    const body = await res.json();
    const data = body.data;
    expect(data.currentVersion).toBe('0.116.0');
    expect(data.lastRecordedVersion).toBe('0.116.0');
    expect(data.historyKnown).toBe(true);
    expect(data.ledger).toEqual({ status: 'ok', appliedCount: 610, pendingCount: 0 });
    expect(data.history.versions.map((v: { version: string }) => v.version)).toEqual(['0.116.0', '0.115.0']);
    expect(data.entries.map((e: { id: string }) => e.id)).toEqual(
      BREAKING_CHANGES_MANIFEST.entries.map((e) => e.id),
    );
    const seed = data.entries.find((e: { id: string }) => e.id === 'ticket-labour-pricing-fields');
    expect(seed.status).toBe('in_effect');
    expect(seed.replacement).toMatch(/billing profile/i);
  });

  it('degrades to the broad report when the history read reports missing', async () => {
    readStateMock.mockResolvedValueOnce({
      currentVersion: '0.116.0',
      history: { status: 'missing', reason: 'could not read breeze_version_history: permission denied' },
      ledger: { status: 'missing', reason: 'could not read the migration ledger: permission denied' },
    });
    const res = await buildApp(platformAdmin).request('/admin/deprecations');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.historyKnown).toBe(false);
    expect(data.historyNote).toMatch(/permission denied/);
    const seed = data.entries.find((e: { id: string }) => e.id === 'ticket-labour-pricing-fields');
    expect(seed.status).toBe('possibly_crossed');
  });

  it('degrades to the broad report (never a 500, never "no issues") when the DB read throws', async () => {
    readStateMock.mockRejectedValueOnce(new Error('connection terminated'));
    const res = await buildApp(platformAdmin).request('/admin/deprecations');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.historyKnown).toBe(false);
    expect(data.historyNote).toMatch(/connection terminated/);
    expect(data.ledger.status).toBe('missing');
    const seed = data.entries.find((e: { id: string }) => e.id === 'ticket-labour-pricing-fields');
    expect(seed.status).toBe('possibly_crossed');
  });
});
