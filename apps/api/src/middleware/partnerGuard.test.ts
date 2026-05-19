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
