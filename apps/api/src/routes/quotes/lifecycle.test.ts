import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  fetchRemoteImage: vi.fn(),
  RemoteImageError: class RemoteImageError extends Error {
    constructor(public reason: string, msg: string) { super(msg); this.name = 'RemoteImageError'; }
  },
}));
vi.mock('./quotes', () => ({
  quoteActorFrom: () => ({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: null }),
  handleServiceError: (_c: unknown, err: unknown) => { throw err; },
}));

import { quoteLifecycleRoutes } from './lifecycle';
import { getQuote } from '../../services/quoteService';
import { fetchRemoteImage, writeQuoteImage, RemoteImageError } from '../../services/quoteImageStorage';

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

describe('POST /:id/images — from URL (JSON body)', () => {
  const PERMS = ['quotes:read', 'quotes:write'];
  const jsonReq = (url: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQuote).mockResolvedValue({ quote: { orgId: 'org-1' } } as never);
    vi.mocked(writeQuoteImage).mockResolvedValue({ id: 'img-9', byteSize: 1234, sha256: 'x' } as never);
  });

  it('copies the remote image and returns the new imageId', async () => {
    vi.mocked(fetchRemoteImage).mockResolvedValue({ mime: 'image/png', buffer: Buffer.from([1, 2, 3]) });
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://cdn.example.com/a.png'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { imageId: 'img-9', mime: 'image/png', byteSize: 1234 } });
    expect(fetchRemoteImage).toHaveBeenCalledWith('https://cdn.example.com/a.png');
    expect(writeQuoteImage).toHaveBeenCalledWith(QUOTE_ID, 'org-1', 'image/png', expect.any(Buffer));
  });

  it('400s a non-http(s) scheme without fetching', async () => {
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('ftp://cdn/a.png'));
    expect(res.status).toBe(400);
    expect(fetchRemoteImage).not.toHaveBeenCalled();
  });

  it('413s an oversized remote image', async () => {
    vi.mocked(fetchRemoteImage).mockRejectedValue(new RemoteImageError('too_large', 'Image is larger than 5 MB'));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://cdn/big.png'));
    expect(res.status).toBe(413);
  });

  it('415s a URL whose bytes are not a supported image', async () => {
    vi.mocked(fetchRemoteImage).mockRejectedValue(new RemoteImageError('not_image', "That URL isn't a PNG, JPEG, or WebP image"));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://cdn/page.png'));
    expect(res.status).toBe(415);
  });

  it('502s an unreachable / blocked URL', async () => {
    vi.mocked(fetchRemoteImage).mockRejectedValue(new RemoteImageError('unreachable', "Couldn't reach that URL"));
    const res = await appWith('partner', PERMS).request(`/${QUOTE_ID}/images`, jsonReq('https://internal/a.png'));
    expect(res.status).toBe(502);
  });
});
