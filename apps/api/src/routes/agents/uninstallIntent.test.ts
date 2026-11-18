import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const setMock = vi.fn();
// updateOwnDeviceRow (#8318 §6.4) always asks for the matched rows back.
const returningMock = vi.fn((): Promise<unknown[]> => Promise.resolve([{ id: 'dev-1' }]));
const whereMock = vi.fn(() => ({ returning: returningMock }));
setMock.mockImplementation(() => ({ where: whereMock }));
const updateMock = vi.fn(() => ({ set: setMock }));
// ownDeviceRowChangedHands' one re-read, on the 0-row path only.
const reReadRows = vi.fn((): Promise<unknown[]> => Promise.resolve([]));
const selectMock = vi.fn(() => ({ from: () => ({ where: () => ({ limit: reReadRows }) }) }));

vi.mock('../../db', () => ({
  db: {
    update: (...args: unknown[]) => updateMock(...(args as [])),
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', agentId: 'devices.agentId' },
}));

const eqMock = vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val }));
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => eqMock(...(args as [unknown, unknown])),
  // updateOwnDeviceRow (#8318 §6.4) ANDs the id + agent_id identity predicate.
  and: (...args: unknown[]) => ({ op: 'and', args }),
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
    selectMock.mockClear();
    returningMock.mockClear();
    reReadRows.mockClear();
  });

  // Review of wave 1b-1 (must-fix 3 sweep): nothing stamped, nothing acknowledged.
  it('answers a stamp the row refused because it changed hands with the stale-credential 401', async () => {
    returningMock.mockResolvedValueOnce([]);
    reReadRows.mockResolvedValueOnce([{ agentId: 'agent-after-reattach' }]);
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-1', agentId: 'agent-1', siteId: 'site-1', role: 'agent' });

    const res = await app.request('/dev-1/uninstall-intent', { method: 'POST' });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Invalid agent credentials');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('answers a 0-row stamp whose row is gone with 404, not an acknowledgement', async () => {
    returningMock.mockResolvedValueOnce([]);
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-1', agentId: 'agent-1', siteId: 'site-1', role: 'agent' });

    const res = await app.request('/dev-1/uninstall-intent', { method: 'POST' });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Device not found' });
  });

  it('does not re-read the row after a stamp that landed', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-1', agentId: 'agent-1', siteId: 'site-1', role: 'agent' });
    expect((await app.request('/dev-1/uninstall-intent', { method: 'POST' })).status).toBe(200);
    expect(selectMock).not.toHaveBeenCalled();
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

  it('returns 403 and never writes for a non-agent (watchdog/helper) credential', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-1', agentId: 'agent-1', siteId: 'site-1', role: 'watchdog' });

    const res = await app.request('/dev-1/uninstall-intent', { method: 'POST' });

    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
