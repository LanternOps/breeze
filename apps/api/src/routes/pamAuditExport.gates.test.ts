/**
 * The export's gates, exercised through the REAL requirePermission and
 * requireMfa middleware (#4910). Only the permission lookup and the 2FA
 * switch are stubbed; the middleware decides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const mocks = vi.hoisted(() => ({
  getUserPermissions: vi.fn(),
  fetchPage: vi.fn(),
  writeRouteAudit: vi.fn(),
}));

vi.mock('./auth/schemas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth/schemas')>()),
  ENABLE_2FA: true,
}));
vi.mock('../services/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/permissions')>()),
  getUserPermissions: mocks.getUserPermissions,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: mocks.writeRouteAudit }));
vi.mock('../services/pamAuditExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/pamAuditExport')>()),
  fetchElevationAuditExportPage: mocks.fetchPage,
}));

import { pamAuditExportRoutes } from './pamAuditExport';

const ORG = '11111111-1111-4111-8111-111111111111';
const Q = 'from=2026-09-01T00:00:00Z&to=2026-09-25T00:00:00Z';

type Principal = 'user_session' | 'ai_agent' | 'api_key';

function app(opts: { authed?: boolean; mfa?: boolean; principal?: Principal } = {}) {
  const a = new Hono();
  a.onError((err, c) => (err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: 'x' }, 500)));
  a.use('*', async (c, next) => {
    if (opts.authed !== false) {
      c.set('auth', {
        scope: 'organization',
        orgId: ORG,
        partnerId: null,
        principal: { kind: opts.principal ?? 'user_session' },
        token: { mfa: opts.mfa ?? true },
        user: { id: 'u1' },
        canAccessOrg: (id: string) => id === ORG,
        orgCondition: () => undefined,
      } as never);
    }
    await next();
  });
  a.route('/pam', pamAuditExportRoutes);
  return a;
}

function grant(...perms: Array<[string, string]>) {
  mocks.getUserPermissions.mockResolvedValue({
    permissions: perms.map(([resource, action]) => ({ resource, action })),
    partnerId: null,
    orgId: ORG,
    roleId: 'r',
    scope: 'organization',
  });
}

const BOTH: Array<[string, string]> = [['devices', 'read'], ['audit', 'export']];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchPage.mockResolvedValue({ records: [], hasMore: false, nextCursor: '', windowComplete: true, settledThrough: '2026-09-25 00:00:00+00' });
});

describe('GET /pam/elevation-audit/export gates (real middleware, #4910)', () => {
  it('admits a caller with devices:read + audit:export and a satisfied MFA claim', async () => {
    grant(...BOTH);
    const res = await app().request(`/pam/elevation-audit/export?${Q}`);
    expect(res.status).toBe(200);
    expect(mocks.fetchPage).toHaveBeenCalledOnce();
  });

  it('401s an unauthenticated request', async () => {
    const res = await app({ authed: false }).request(`/pam/elevation-audit/export?${Q}`);
    expect(res.status).toBe(401);
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });

  it('403s without audit:export, and without devices:read', async () => {
    grant(['devices', 'read']);
    expect((await app().request(`/pam/elevation-audit/export?${Q}`)).status).toBe(403);
    grant(['audit', 'export']);
    expect((await app().request(`/pam/elevation-audit/export?${Q}`)).status).toBe(403);
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });

  it('403s MFA_REQUIRED when the session has not satisfied MFA', async () => {
    grant(...BOTH);
    const res = await app({ mfa: false }).request(`/pam/elevation-audit/export?${Q}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });

  it('403s an AI agent principal even with both permissions', async () => {
    grant(...BOTH);
    const res = await app({ principal: 'ai_agent' }).request(`/pam/elevation-audit/export?${Q}`);
    expect(res.status).toBe(403);
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });
});
