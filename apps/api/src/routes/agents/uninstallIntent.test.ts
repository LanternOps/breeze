import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const setMock = vi.fn();
const whereMock = vi.fn(() => Promise.resolve());
setMock.mockImplementation(() => ({ where: whereMock }));
const updateMock = vi.fn(() => ({ set: setMock }));

vi.mock('../../db', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id' },
}));

const eqMock = vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val }));
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => eqMock(...(args as [unknown, unknown])),
}));

import { uninstallIntentRoutes } from './uninstallIntent';

function appWithAgent(agent: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (agent !== undefined) c.set('agent', agent as never);
    await next();
  });
  app.route('/', uninstallIntentRoutes);
  return app;
}

describe('POST /:id/uninstall-intent (#2764)', () => {
  beforeEach(() => {
    updateMock.mockClear();
    setMock.mockClear();
    whereMock.mockClear();
    eqMock.mockClear();
  });

  it('stamps uninstallIntentAt on the authenticated device and returns 200 { acknowledged: true }', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-1', agentId: 'agent-1', siteId: 'site-1', role: 'agent' });

    const res = await app.request('/dev-1/uninstall-intent', { method: 'POST' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ acknowledged: true });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.uninstallIntentAt).toBeInstanceOf(Date);

    // The WHERE clause must key off the token-resolved device, never a
    // client-controllable value — proves the endpoint can only ever write
    // its own authenticated row (mirrors heartbeat.ts's convention).
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('never keys the write off the URL :id — only the token-resolved device', async () => {
    // Path id is a DIFFERENT device than the authenticated one; if the write
    // were keyed off the path this would (dangerously) target 'dev-OTHER'.
    const app = appWithAgent({ deviceId: 'dev-real', orgId: 'org-1', agentId: 'agent-1', siteId: 'site-1', role: 'agent' });

    const res = await app.request('/dev-OTHER/uninstall-intent', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    // The eq() bound to the WHERE clause targets the TOKEN-resolved device,
    // never the path segment.
    expect(eqMock).toHaveBeenCalledWith('devices.id', 'dev-real');
  });

  it('returns 401 and never writes when there is no agent auth context', async () => {
    const app = appWithAgent(undefined);

    const res = await app.request('/dev-1/uninstall-intent', { method: 'POST' });

    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
