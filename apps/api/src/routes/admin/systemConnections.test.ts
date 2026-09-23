/**
 * GET /api/v1/admin/system/connections — invariant 6 (access) and the HTTP
 * half of invariant 2 (secret canary through the real route + gate).
 * Auth mocking mirrors routes/admin/deprecations.test.ts (#6744) and
 * aiToolUsage.test.ts: the real adminRoutes + platformAdminMiddleware, with
 * authMiddleware stubbed to 401 when no auth is set.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: auditMock,
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
import { CONNECTION_REGISTRY } from '../../system/connections/registry';

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

const PATH = '/admin/system/connections';
const touchedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const [name, original] of touchedEnv) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  touchedEnv.clear();
});

describe('GET /admin/system/connections — access (invariant 6)', () => {
  it('401 without an authenticated session', async () => {
    expect((await buildApp(null).request(PATH)).status).toBe(401);
  });

  it('403 for a partner admin who is not a platform admin', async () => {
    expect((await buildApp(partnerAdmin).request(PATH)).status).toBe(403);
  });

  it('403 for an organization user', async () => {
    expect((await buildApp(orgUser).request(PATH)).status).toBe(403);
  });

  it('200 for a platform admin, with Cache-Control: no-store and the { data } wrapper', async () => {
    const res = await buildApp(platformAdmin).request(PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.data.scope).toBe('api');
    expect(body.data.groups.length).toBeGreaterThan(0);
  });

  it('exposes GET only — POST, PUT, PATCH and DELETE are 404', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await buildApp(platformAdmin).request(PATH, { method });
      expect(res.status, method).toBe(404);
    }
  });

  it('the gate audit row records method and path only', async () => {
    await buildApp(platformAdmin).request(PATH);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform_admin.system.connections',
        details: { method: 'GET', path: PATH },
      }),
    );
  });
});

describe('GET /admin/system/connections — secret canary over HTTP (invariant 2)', () => {
  it('no secret value appears in the HTTP body', async () => {
    const canaries: string[] = [];
    for (const entry of CONNECTION_REGISTRY) {
      for (const v of entry.vars) {
        if (v.secret === false) continue;
        const canary = `CANARY_${v.name}_${randomUUID()}`;
        canaries.push(canary);
        setEnv(v.name, canary);
      }
    }
    const res = await buildApp(platformAdmin).request(PATH);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(canaries.filter((c) => text.includes(c))).toEqual([]);
  });
});
