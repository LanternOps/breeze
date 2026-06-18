import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Route-level RBAC test for POST /:id/send. The previously-vacuous
// quoteSendRbac.integration.test.ts only compared permission CONSTANTS; this
// drives the REAL requireScope + requirePermission middleware on the actual
// mounted send route, with a controllable permission set, so it would catch the
// exact regression the old test could not: the route being gated on the wrong
// permission (e.g. quotes:write) or ungated.

// Controllable grant set, read by the mocked getUserPermissions below.
const permState = vi.hoisted(() => ({ perms: ['quotes:read', 'quotes:write'] }));

// Keep the REAL requirePermission/requireScope/hasPermission; only stub the
// DB-backed getUserPermissions so requirePermission resolves a known grant set.
vi.mock('../../services/permissions', async (importActual) => {
  const actual = await importActual<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: permState.perms.map((p) => { const [resource, action] = p.split(':'); return { resource, action }; }),
      partnerId: 'p1', orgId: null, roleId: 'r1', scope: 'partner' as const,
    })),
  };
});

// Stub the services the route file imports so mounting it never touches the DB.
vi.mock('../../services/quoteLifecycle', () => ({
  sendQuote: vi.fn(async () => ({ quote: { id: 'q1', status: 'sent' }, emailed: false, acceptUrl: 'http://x/quote/t' })),
}));
vi.mock('../../services/quoteService', () => ({ getQuote: vi.fn() }));
vi.mock('../../services/quoteImageStorage', () => ({
  writeQuoteImage: vi.fn(), readQuoteImage: vi.fn(), sniffImageMime: vi.fn(), MAX_QUOTE_IMAGE_SIZE_BYTES: 5 * 1024 * 1024,
}));
vi.mock('./quotes', () => ({
  quoteActorFrom: () => ({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: null }),
  handleServiceError: (_c: unknown, err: unknown) => { throw err; },
}));

import { quoteLifecycleRoutes } from './lifecycle';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';

function appWith(scope: 'partner' | 'system' | 'organization', perms: string[]) {
  permState.perms = perms;
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope } as never); await next(); });
  a.route('/', quoteLifecycleRoutes);
  return a;
}

describe('POST /:id/send RBAC (quotes:send)', () => {
  it('403s a quotes:read + quotes:write user without quotes:send', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write']).request(`/${QUOTE_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('passes the permission gate for a quotes:send holder', async () => {
    const res = await appWith('partner', ['quotes:read', 'quotes:write', 'quotes:send']).request(`/${QUOTE_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('403s a wrong scope (organization) even with quotes:send', async () => {
    const res = await appWith('organization', ['quotes:send']).request(`/${QUOTE_ID}/send`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
