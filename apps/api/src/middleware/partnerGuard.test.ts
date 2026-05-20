import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/jwt', () => ({
  verifyToken: vi.fn(),
}));

const limitMock = vi.fn();
vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: limitMock,
        }),
      }),
    }),
  },
  // Passthrough — production wraps the partner lookup so that RLS doesn't
  // shadow the row under `breeze_app` (the guard fires before authMiddleware
  // sets a request-scoped context). The test exercises the same call shape.
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../db/schema', () => ({
  partners: { id: { name: 'id' }, status: { name: 'status' }, settings: { name: 'settings' } },
}));

import { Hono } from 'hono';
import { partnerGuard } from './partnerGuard';
import { verifyToken } from '../services/jwt';

function makeApp() {
  const app = new Hono();
  app.use('*', partnerGuard);
  app.get('/protected', (c) => c.json({ ok: true }));
  return app;
}

describe('partnerGuard — fail closed (SR-005)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through when there is no Authorization header', async () => {
    const res = await makeApp().request('/protected');
    expect(res.status).toBe(200);
  });

  it('passes through when the token cannot be verified (non-first-party / OAuth token)', async () => {
    vi.mocked(verifyToken).mockRejectedValueOnce(new Error('not a breeze jwt'));
    const res = await makeApp().request('/protected', {
      headers: { Authorization: 'Bearer oauth-token' },
    });
    expect(res.status).toBe(200);
  });

  it('passes through when the verified token carries no partnerId', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ partnerId: null } as never);
    const res = await makeApp().request('/protected', {
      headers: { Authorization: 'Bearer org-token' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 503 when the partner DB lookup throws (was failing open)', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ partnerId: 'p-1' } as never);
    limitMock.mockRejectedValueOnce(new Error('connection terminated'));
    const res = await makeApp().request('/protected', {
      headers: { Authorization: 'Bearer partner-token' },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('PARTNER_LOOKUP_UNAVAILABLE');
  });

  it('returns 403 when the verified token references a partner that does not exist (was failing open)', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ partnerId: 'p-missing' } as never);
    limitMock.mockResolvedValueOnce([]);
    const res = await makeApp().request('/protected', {
      headers: { Authorization: 'Bearer partner-token' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('PARTNER_NOT_FOUND');
  });

  it('returns 403 when the partner exists but is not active', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ partnerId: 'p-1' } as never);
    limitMock.mockResolvedValueOnce([{ status: 'suspended', settings: {} }]);
    const res = await makeApp().request('/protected', {
      headers: { Authorization: 'Bearer partner-token' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('PARTNER_INACTIVE');
  });

  it('passes through when the partner exists and is active', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ partnerId: 'p-1' } as never);
    limitMock.mockResolvedValueOnce([{ status: 'active', settings: {} }]);
    const res = await makeApp().request('/protected', {
      headers: { Authorization: 'Bearer partner-token' },
    });
    expect(res.status).toBe(200);
  });
});

// Regression: the production wrapper in `index.ts` previously did
// `await partnerGuard(c, next);` without returning, which silently discarded
// any Response the guard produced — Hono then threw "Context is not
// finalized" and the request collapsed to 500. This suite exercises the same
// wrapper shape used in `index.ts` to ensure that pattern can't sneak back in.
describe('partnerGuard — wrapper shape (regression for #781 wrapper-discards-Response)', () => {
  function makeWrapperApp() {
    const app = new Hono();
    // Mirrors `api.use('*', async (c, next) => { ...exempt paths...; return partnerGuard(c, next); })`
    // from `apps/api/src/index.ts`. The `return` is the bit under test.
    app.use('*', (c, next) => partnerGuard(c, next));
    app.get('/protected', (c) => c.json({ ok: true }));
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('propagates 403 PARTNER_NOT_FOUND through the wrapper instead of collapsing to 500', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ partnerId: 'p-missing' } as never);
    limitMock.mockResolvedValueOnce([]);
    const res = await makeWrapperApp().request('/protected', {
      headers: { Authorization: 'Bearer partner-token' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('PARTNER_NOT_FOUND');
  });

  it('propagates 503 PARTNER_LOOKUP_UNAVAILABLE through the wrapper', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ partnerId: 'p-1' } as never);
    limitMock.mockRejectedValueOnce(new Error('db down'));
    const res = await makeWrapperApp().request('/protected', {
      headers: { Authorization: 'Bearer partner-token' },
    });
    expect(res.status).toBe(503);
  });

  it('propagates 403 PARTNER_INACTIVE through the wrapper', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ partnerId: 'p-1' } as never);
    limitMock.mockResolvedValueOnce([{ status: 'suspended', settings: {} }]);
    const res = await makeWrapperApp().request('/protected', {
      headers: { Authorization: 'Bearer partner-token' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('PARTNER_INACTIVE');
  });

  it('lets through valid active-partner traffic and returns 200 from the downstream handler', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ partnerId: 'p-1' } as never);
    limitMock.mockResolvedValueOnce([{ status: 'active', settings: {} }]);
    const res = await makeWrapperApp().request('/protected', {
      headers: { Authorization: 'Bearer partner-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });
});
