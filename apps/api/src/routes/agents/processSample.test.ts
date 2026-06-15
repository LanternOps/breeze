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
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'a', siteId: 's', role: 'agent' });
    const res = await app.request('/dev-1/process-sample', {
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
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'a', siteId: 's', role: 'agent' });
    await app.request('/dev-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2020-01-01T00:00:00.000Z', processes: [] })
    });
    expect(inserted[0].agentTimestamp).toEqual(new Date('2020-01-01T00:00:00.000Z'));
    expect(inserted[0].timestamp.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
  });

  it('rejects a payload over the 16-process cap', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'a', siteId: 's', role: 'agent' });
    const processes = Array.from({ length: 17 }, (_, i) => ({ name: `p${i}`, pid: i, cpu: 0, ramMb: 0 }));
    const res = await app.request('/dev-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-06-13T12:00:00.000Z', processes })
    });
    expect(res.status).toBe(400);
  });

  it('rejects when path id does not match the authenticated device', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'a', siteId: 's', role: 'agent' });
    const res = await app.request('/dev-OTHER/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-06-13T12:00:00.000Z', processes: [] })
    });
    expect(res.status).toBe(403);
  });
});
