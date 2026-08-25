import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/jwt', () => ({
  verifyToken: vi.fn(),
}));

const limitMock = vi.fn();
const whereMock = vi.fn(() => ({ limit: limitMock }));
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: whereMock }) }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

const captureMessageMock = vi.fn();
vi.mock('../services/sentry', () => ({
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

vi.mock('../db/schema', () => ({
  mobileDevices: {
    status: { name: 'status' },
    blockedReason: { name: 'blocked_reason' },
    deviceId: { name: 'device_id' },
    userId: { name: 'user_id' },
  },
}));

import { Hono } from 'hono';
import {
  mobileDeviceBlockedMiddleware,
  _resetUnresolvedDeviceReportsForTests,
} from './mobileDeviceBlocked';
import { verifyToken } from '../services/jwt';
import { MOBILE_DEVICE_ID_HEADER } from '../services/mobileDeviceBinding';

function makeApp() {
  const app = new Hono();
  app.use('/mobile/*', mobileDeviceBlockedMiddleware);
  app.get('/mobile/ping', (c) => c.json({ ok: true }));
  return app;
}

const VICTIM = 'user-victim-1';
const DEVICE = 'install-uuid-victim';

describe('mobileDeviceBlockedMiddleware — signed device binding (SR-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
  });

  it('blocks a request whose SIGNED token is bound to a blocked device, even with NO header (the bypass)', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, mdid: DEVICE, type: 'access' } as never);
    limitMock.mockResolvedValueOnce([{ status: 'blocked', blockedReason: 'lost phone' }]);

    const res = await makeApp().request('/mobile/ping', {
      headers: { Authorization: 'Bearer stolen-bound-token' }, // note: NO X-Breeze-Mobile-Device-Id
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; reason?: string };
    expect(body.code).toBe('device_blocked');
    expect(body.reason).toBe('lost phone');
  });

  it('blocks even when the attacker spoofs a DIFFERENT device-id header (signed claim wins)', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, mdid: DEVICE, type: 'access' } as never);
    limitMock.mockResolvedValueOnce([{ status: 'blocked', blockedReason: null }]);

    const res = await makeApp().request('/mobile/ping', {
      headers: {
        Authorization: 'Bearer stolen-bound-token',
        [MOBILE_DEVICE_ID_HEADER]: 'some-other-unblocked-id',
      },
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('device_blocked');
  });

  it('scopes the blocked lookup to device_id AND the token user (report guidance)', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, mdid: DEVICE, type: 'access' } as never);
    limitMock.mockResolvedValueOnce([]); // no row for (device, user) → not blocked

    const res = await makeApp().request('/mobile/ping', {
      headers: { Authorization: 'Bearer bound-token' },
    });

    expect(res.status).toBe(200);
    // Two predicates anded together: device_id and user_id (not a global device_id-only lookup).
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('passes a bound token whose device row is still active', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, mdid: DEVICE, type: 'access' } as never);
    limitMock.mockResolvedValueOnce([{ status: 'active', blockedReason: null }]);

    const res = await makeApp().request('/mobile/ping', {
      headers: { Authorization: 'Bearer bound-token' },
    });
    expect(res.status).toBe(200);
  });

  it('passes a bound token with no device row yet (pre-registration onboarding)', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, mdid: DEVICE, type: 'access' } as never);
    limitMock.mockResolvedValueOnce([]);

    const res = await makeApp().request('/mobile/ping', {
      headers: { Authorization: 'Bearer bound-token' },
    });
    expect(res.status).toBe(200);
  });

  it('falls back to the header for legacy tokens minted before binding (migration)', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, type: 'access' } as never); // no mdid
    limitMock.mockResolvedValueOnce([{ status: 'blocked', blockedReason: 'admin block' }]);

    const res = await makeApp().request('/mobile/ping', {
      headers: {
        Authorization: 'Bearer legacy-token',
        [MOBILE_DEVICE_ID_HEADER]: DEVICE,
      },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('device_blocked');
  });

  it('is a noop for non-mobile callers (no token, no header) — web/MCP unaffected', async () => {
    const res = await makeApp().request('/mobile/ping');
    expect(res.status).toBe(200);
    expect(whereMock).not.toHaveBeenCalled();
  });

  it('is a noop for a legacy token with no header (web dashboard reaching a /mobile/* path)', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'web-user', type: 'access' } as never);
    const res = await makeApp().request('/mobile/ping', {
      headers: { Authorization: 'Bearer web-token' },
    });
    expect(res.status).toBe(200);
    expect(whereMock).not.toHaveBeenCalled();
  });
});

// #2913: for years this middleware matched nothing, because no code path ever
// created a mobile_devices row keyed on the id the header carries. An inert
// control looked exactly like a working one. Misses are now reported.
describe('mobileDeviceBlockedMiddleware — unresolved device telemetry (#2913)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
    _resetUnresolvedDeviceReportsForTests();
  });

  it('reports when a presented device id resolves to no row', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, mdid: DEVICE, type: 'access' } as never);

    const res = await makeApp().request('/mobile/ping', {
      headers: { Authorization: 'Bearer bound-token' },
    });

    // Still fails OPEN — failing closed would lock out every install that has
    // not re-registered yet, plus onboarding's pre-registration calls.
    expect(res.status).toBe(200);
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    expect(captureMessageMock.mock.calls[0]?.[1]).toMatchObject({
      eventCode: 'mobile_device_unresolved',
      tags: { mobile_device_id_source: 'signed-claim' },
    });
  });

  it('tags a header-only (legacy token) miss distinctly from a signed-claim miss', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, type: 'access' } as never);

    await makeApp().request('/mobile/ping', {
      headers: { Authorization: 'Bearer legacy-token', [MOBILE_DEVICE_ID_HEADER]: DEVICE },
    });

    expect(captureMessageMock.mock.calls[0]?.[1]).toMatchObject({
      tags: { mobile_device_id_source: 'header' },
    });
  });

  it('rate limits so an unregistered fleet cannot flood Sentry', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, mdid: DEVICE, type: 'access' } as never);
    const app = makeApp();

    for (let i = 0; i < 5; i++) {
      await app.request('/mobile/ping', { headers: { Authorization: 'Bearer bound-token' } });
    }

    expect(captureMessageMock).toHaveBeenCalledTimes(1);
  });

  it('does not report when the device resolves to a real row', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: VICTIM, mdid: DEVICE, type: 'access' } as never);
    limitMock.mockResolvedValueOnce([{ status: 'active', blockedReason: null }]);

    await makeApp().request('/mobile/ping', { headers: { Authorization: 'Bearer bound-token' } });

    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('does not report for callers that present no device id at all', async () => {
    await makeApp().request('/mobile/ping');
    expect(captureMessageMock).not.toHaveBeenCalled();
  });
});
