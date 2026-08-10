import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const inserted: any[] = [];
vi.mock('../../db', () => ({
  db: {
    insert: () => ({ values: (v: any) => { inserted.push(v); return Promise.resolve(); } })
  },
  withDbAccessContext: (_ctx: any, fn: any) => fn()
}));

import { processSampleRoutes } from './processSample';

function appWithAgent(agent: any) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('agent', agent); await next(); });
  app.route('/', processSampleRoutes);
  return app;
}

describe('POST /:id/process-sample', () => {
  beforeEach(() => { inserted.length = 0; });

  it('derives org_id from the auth context and ignores any body org_id', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'agent-1', siteId: 's', role: 'agent' });
    const res = await app.request('/agent-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timestamp: '2026-06-13T12:00:00.000Z',
        orgId: 'org-attacker',
        processes: [{ name: 'chrome', pid: 42, cpu: 12.5, ramMb: 800 }]
      })
    });
    expect(res.status).toBe(201);
    expect(inserted[0].orgId).toBe('org-real');
    expect(inserted[0].deviceId).toBe('dev-1');
  });

  it('server-stamps timestamp and stores agent time separately', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'agent-1', siteId: 's', role: 'agent' });
    await app.request('/agent-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2020-01-01T00:00:00.000Z', processes: [] })
    });
    expect(inserted[0].agentTimestamp).toEqual(new Date('2020-01-01T00:00:00.000Z'));
    expect(inserted[0].timestamp.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
  });

  it('rejects a payload over the 16-process cap', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'agent-1', siteId: 's', role: 'agent' });
    const processes = Array.from({ length: 17 }, (_, i) => ({ name: `p${i}`, pid: i, cpu: 0, ramMb: 0 }));
    const res = await app.request('/agent-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-06-13T12:00:00.000Z', processes })
    });
    expect(res.status).toBe(400);
  });

  // #3387: the agent sends config.AgentID in the path (heartbeat.go
  // sendProcessSample), matching every sibling ingest route. Comparing it to
  // the device UUID instead 403'd every real sample, and the pre-fix tests hid
  // that by putting the device id in the path — a value no agent ever sends.
  it('accepts the agent id in the path, not the device id (#3387)', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'agent-1', siteId: 's', role: 'agent' });

    const ok = await app.request('/agent-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-06-13T12:00:00.000Z', processes: [] })
    });
    expect(ok.status).toBe(201);
    // the row is still keyed by the device, resolved from the token
    expect(inserted[0].deviceId).toBe('dev-1');

    const wrong = await app.request('/dev-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-06-13T12:00:00.000Z', processes: [] })
    });
    expect(wrong.status).toBe(403);
  });

  it('rejects when path agent id does not match the authenticated token', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'agent-1', siteId: 's', role: 'agent' });
    const res = await app.request('/agent-OTHER/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-06-13T12:00:00.000Z', processes: [] })
    });
    expect(res.status).toBe(403);
  });
});

describe('process-sample ingest — requireAgentRole gate (F8)', () => {
  it('rejects a watchdog-role token with 403', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: 'dev-1', agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1', role: 'watchdog' } as never);
      return next();
    });
    app.route('/', processSampleRoutes);
    const res = await app.request('/agent-1/process-sample', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});
