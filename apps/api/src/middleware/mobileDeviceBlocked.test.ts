import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
};

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => selectChain),
  },
  runOutsideDbContext: <T>(fn: () => Promise<T>) => fn(),
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

import { Hono } from 'hono';
import { mobileDeviceBlockedMiddleware } from './mobileDeviceBlocked';

const MOBILE_DEVICE_ID_HEADER = 'x-breeze-mobile-device-id';

type AuthShape = { user: { id: string } } | null;

function makeApp(auth: AuthShape) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.use('*', mobileDeviceBlockedMiddleware);
  app.get('/anything', (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectChain.limit.mockResolvedValue([]);
});

describe('mobileDeviceBlockedMiddleware', () => {
  it('passes through when no device-id header is present', async () => {
    const app = makeApp({ user: { id: 'u1' } });
    const res = await app.request('/anything');
    expect(res.status).toBe(200);
    expect(selectChain.limit).not.toHaveBeenCalled();
  });

  it('passes through when device-id header is empty or oversized', async () => {
    const app = makeApp({ user: { id: 'u1' } });
    const a = await app.request('/anything', { headers: { [MOBILE_DEVICE_ID_HEADER]: '   ' } });
    const b = await app.request('/anything', { headers: { [MOBILE_DEVICE_ID_HEADER]: 'x'.repeat(256) } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(selectChain.limit).not.toHaveBeenCalled();
  });

  it('passes through when there is no auth context (defense in depth)', async () => {
    const app = makeApp(null);
    const res = await app.request('/anything', { headers: { [MOBILE_DEVICE_ID_HEADER]: 'dev-1' } });
    expect(res.status).toBe(200);
    expect(selectChain.limit).not.toHaveBeenCalled();
  });

  it('passes through when no row matches (deviceId, userId)', async () => {
    selectChain.limit.mockResolvedValueOnce([]);
    const app = makeApp({ user: { id: 'u1' } });
    const res = await app.request('/anything', { headers: { [MOBILE_DEVICE_ID_HEADER]: 'dev-foreign' } });
    expect(res.status).toBe(200);
    expect(selectChain.limit).toHaveBeenCalledTimes(1);
  });

  it('passes through when the matched row is active', async () => {
    selectChain.limit.mockResolvedValueOnce([{ status: 'active' }]);
    const app = makeApp({ user: { id: 'u1' } });
    const res = await app.request('/anything', { headers: { [MOBILE_DEVICE_ID_HEADER]: 'dev-1' } });
    expect(res.status).toBe(200);
  });

  it('returns 403 with code device_blocked when the row is blocked, never echoes the admin reason', async () => {
    selectChain.limit.mockResolvedValueOnce([{ status: 'blocked' }]);
    const app = makeApp({ user: { id: 'u1' } });
    const res = await app.request('/anything', { headers: { [MOBILE_DEVICE_ID_HEADER]: 'dev-1' } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('device_blocked');
    expect(body.reason).toBeUndefined();
    expect(body.blockedReason).toBeUndefined();
  });
});
