import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authenticateMock, resolveMock, renewMock, callMetric, objectsMetric } = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  resolveMock: vi.fn(),
  renewMock: vi.fn(),
  callMetric: vi.fn(),
  objectsMetric: vi.fn(),
}));

vi.mock('../../services/backupMetrics', () => ({
  recordStorageSessionCall: callMetric,
  recordStorageSessionObjects: objectsMetric,
}));

vi.mock('../../services/backupStorageSessions', () => ({
  STORAGE_SESSION_HEADER: 'X-Breeze-Storage-Session',
  STORAGE_SESSION_MAX_BATCH: 100,
  authenticateStorageSession: authenticateMock,
  resolveStorageSessionObjects: resolveMock,
  renewStorageSession: renewMock,
}));

import { agentStorageSessionRoutes } from './storageSessions';

const SESSION_ID = '0b6f0c7e-3d2a-4f5b-9e1c-8a7d6c5b4a39';
const TOKEN = 's'.repeat(43);
const DEVICE = '33333333-3333-4333-8333-333333333333';
const ORG = '11111111-1111-4111-8111-111111111111';
const SESSION_ROW = { id: SESSION_ID, scope: 'snapshot_read' };

function buildApp(role: 'agent' | 'watchdog' = 'agent') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent' as never, { deviceId: DEVICE, orgId: ORG, agentId: 'agent-7c1d', role } as never);
    await next();
  });
  app.route('/', agentStorageSessionRoutes);
  return app;
}

const resolvePath = `/agent-7c1d/storage-sessions/${SESSION_ID}/objects:resolve`;
const renewPath = `/agent-7c1d/storage-sessions/${SESSION_ID}/renew`;

function post(path: string, body: unknown, headers: Record<string, string> = { 'X-Breeze-Storage-Session': TOKEN }, role: 'agent' | 'watchdog' = 'agent') {
  return buildApp(role).request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateMock.mockResolvedValue({ ok: true, session: SESSION_ROW });
  resolveMock.mockResolvedValue({
    status: 200,
    body: {
      objects: [{ key: 'snapshots/s/manifest.json', method: 'GET', url: 'https://storage.example/o', headers: {}, expiresAt: '2026-09-26T12:05:00Z' }],
      denied: [],
    },
  });
  renewMock.mockResolvedValue({ status: 200, body: { expiresAt: '2026-09-26T12:15:00Z' } });
});

describe('storage session resolve endpoint', () => {
  it('authenticates with the agent identity and the session header, then resolves the keys verbatim', async () => {
    // The request body the helper sends (resolveCall in the helper tests).
    const keys = ['snapshots/s/manifest.json', '', 'snapshots/s/files/A b%2F.txt'];
    const res = await post(resolvePath, { keys });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(authenticateMock).toHaveBeenCalledWith({ sessionId: SESSION_ID, token: TOKEN, agent: { deviceId: DEVICE, orgId: ORG } });
    expect(resolveMock).toHaveBeenCalledWith(SESSION_ROW, keys);
    expect(await res.json()).toMatchObject({ objects: [{ key: 'snapshots/s/manifest.json' }], denied: [] });
  });

  it('never reads the token from the query string', async () => {
    await post(`${resolvePath}?token=${TOKEN}`, { keys: ['k'] }, {});
    expect(authenticateMock).toHaveBeenCalledWith(expect.objectContaining({ token: undefined }));
  });

  it.each([
    ['a non-object body', '[]'],
    ['keys that are not an array', { keys: 'snapshots/s/manifest.json' }],
    ['an empty key list', { keys: [] }],
    ['more keys than the batch limit', { keys: Array.from({ length: 101 }, (_, i) => `k${i}`) }],
    ['a non-string key', { keys: ['a', 7] }],
    ['malformed JSON', '{"keys":'],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await post(resolvePath, body);
    expect(res.status).toBe(400);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 410])('passes an authentication refusal (%i) through without resolving', async (status) => {
    authenticateMock.mockResolvedValue({ ok: false, status, error: 'refused' });
    const res = await post(resolvePath, { keys: ['k'] });
    expect(res.status).toBe(status);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After when the budget is spent', async () => {
    resolveMock.mockResolvedValue({ status: 429, retryAfterSeconds: 30 });
    const res = await post(resolvePath, { keys: ['k'] });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
  });

  it('refuses the watchdog credential', async () => {
    const res = await post(resolvePath, { keys: ['k'] }, { 'X-Breeze-Storage-Session': TOKEN }, 'watchdog');
    expect(res.status).toBe(403);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown operation', async () => {
    const res = await post(`/agent-7c1d/storage-sessions/${SESSION_ID}/objects:list`, { keys: ['k'] });
    expect(res.status).toBe(404);
    expect(authenticateMock).not.toHaveBeenCalled();
  });
});

describe('storage session renew endpoint', () => {
  it('renews with the helper empty body', async () => {
    const res = await post(renewPath, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expiresAt: '2026-09-26T12:15:00Z' });
    expect(renewMock).toHaveBeenCalledWith(SESSION_ROW);
  });

  it('passes 410 through', async () => {
    renewMock.mockResolvedValue({ status: 410, error: 'expired' });
    const res = await post(renewPath, {});
    expect(res.status).toBe(410);
  });
});

describe('storage session single-object compatibility endpoint', () => {
  it('redirects to the resolved object URL', async () => {
    const key = 'snapshots/s/files/a b.txt';
    resolveMock.mockResolvedValue({
      status: 200,
      body: { objects: [{ key, method: 'GET', url: 'https://storage.example/o?sig=1', headers: {}, expiresAt: '2026-09-26T12:05:00Z' }], denied: [] },
    });
    const res = await buildApp().request(`/agent-7c1d/storage-sessions/${SESSION_ID}/object?key=${encodeURIComponent(key)}`, {
      headers: { 'X-Breeze-Storage-Session': TOKEN },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://storage.example/o?sig=1');
    expect(resolveMock).toHaveBeenCalledWith(SESSION_ROW, [key]);
  });

  it('refuses a key outside the authorized set', async () => {
    resolveMock.mockResolvedValue({ status: 200, body: { objects: [], denied: ['x'] } });
    const res = await buildApp().request(`/agent-7c1d/storage-sessions/${SESSION_ID}/object?key=x`, {
      headers: { 'X-Breeze-Storage-Session': TOKEN },
    });
    expect(res.status).toBe(403);
  });

  it('requires a key', async () => {
    const res = await buildApp().request(`/agent-7c1d/storage-sessions/${SESSION_ID}/object`, {
      headers: { 'X-Breeze-Storage-Session': TOKEN },
    });
    expect(res.status).toBe(400);
  });
});

describe('storage session call telemetry', () => {
  it('counts a resolved call and the objects it returned', async () => {
    const res = await post(resolvePath, { keys: ['snapshots/s/manifest.json'] });
    expect(res.status).toBe(200);
    expect(callMetric.mock.calls).toEqual([['snapshot_read', 'resolve', 200]]);
    expect(objectsMetric.mock.calls).toEqual([['snapshot_read', 'GET', 1]]);
  });

  it('counts a renew that found the session expired', async () => {
    renewMock.mockResolvedValue({ status: 410, error: 'expired' });
    const res = await post(renewPath, {});
    expect(res.status).toBe(410);
    expect(callMetric.mock.calls).toEqual([['snapshot_read', 'renew', 410]]);
    expect(objectsMetric).not.toHaveBeenCalled();
  });

  it('counts a call whose session could not be authenticated under the read scope', async () => {
    authenticateMock.mockResolvedValue({ ok: false, status: 401, error: 'refused' });
    const res = await post(resolvePath, { keys: ['k'] });
    expect(res.status).toBe(401);
    expect(callMetric.mock.calls).toEqual([['snapshot_read', 'resolve', 401]]);
  });

  it('counts a malformed body and a throttled call', async () => {
    await post(resolvePath, { keys: [] });
    resolveMock.mockResolvedValue({ status: 429, retryAfterSeconds: 30 });
    await post(resolvePath, { keys: ['k'] });
    expect(callMetric.mock.calls).toEqual([
      ['snapshot_read', 'resolve', 400],
      ['snapshot_read', 'resolve', 429],
    ]);
    expect(objectsMetric).not.toHaveBeenCalled();
  });

  it('counts a call that failed with an error as 500', async () => {
    resolveMock.mockRejectedValue(new Error('database unavailable'));
    const res = await post(resolvePath, { keys: ['k'] });
    expect(res.status).toBe(500);
    expect(callMetric.mock.calls).toEqual([['snapshot_read', 'resolve', 500]]);
  });

  it('counts the compatibility single-object call', async () => {
    const key = 'snapshots/s/manifest.json';
    resolveMock.mockResolvedValue({
      status: 200,
      body: { objects: [{ key, method: 'GET', url: 'https://storage.example/o', headers: {}, expiresAt: '2026-09-26T12:05:00Z' }], denied: [] },
    });
    const res = await buildApp().request(`/agent-7c1d/storage-sessions/${SESSION_ID}/object?key=${encodeURIComponent(key)}`, {
      headers: { 'X-Breeze-Storage-Session': TOKEN },
    });
    expect(res.status).toBe(302);
    expect(callMetric.mock.calls).toEqual([['snapshot_read', 'object', 302]]);
    expect(objectsMetric.mock.calls).toEqual([['snapshot_read', 'GET', 1]]);
  });

  it('does not count an unknown operation', async () => {
    await post(`/agent-7c1d/storage-sessions/${SESSION_ID}/objects:list`, { keys: ['k'] });
    expect(callMetric).not.toHaveBeenCalled();
  });
});
