import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const DEFAULT_NEAREST = [{ timestamp: new Date('2026-06-13T12:00:00Z'), agentTimestamp: null, topProcesses: [{ name: 'chrome', pid: 1, cpu: 9, ramMb: 100 }] }];
const calls: any = { nearest: null, markers: null, nearestRows: DEFAULT_NEAREST };
vi.mock('../../db', () => {
  const chain = (kind: string) => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => { calls.nearest = kind; return Promise.resolve(calls.nearestRows); },
        }),
      }),
    }),
  });
  return {
    db: {
      select: (cols: any) => {
        // markers query selects only { timestamp }
        if (cols && Object.keys(cols).length === 1 && 'timestamp' in cols) {
          return { from: () => ({ where: () => ({ orderBy: () => { calls.markers = true; return Promise.resolve([{ timestamp: new Date('2026-06-13T11:57:00Z') }]); } }) }) };
        }
        return chain('nearest');
      }
    },
    withDbAccessContext: (_ctx: any, fn: any) => fn()
  };
});
vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: async () => ({ id: 'dev-1', orgId: 'org-1', siteId: 'site-1' }),
  SITE_ACCESS_DENIED: Symbol('denied')
}));
// authMiddleware is the ONLY thing that sets the auth context (and, in prod,
// establishes the withDbAccessContext RLS GUCs). The test app deliberately does
// NOT inject auth itself — so if the route forgets to call
// `processSamplesRoutes.use('*', authMiddleware)`, c.get('auth') is undefined
// and the route breaks. This guards against the multi-tenant bypass.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => { c.set('auth', { scope: 'organization', orgId: 'org-1' }); await next(); },
  // Mirror the real requireScope: it reads c.get('auth') and 401s when absent.
  // If the route forgets `.use('*', authMiddleware)`, auth is never set and this
  // returns 401 — surfacing the multi-tenant bypass the no-op mock used to mask.
  requireScope: () => async (c: any, next: any) => {
    if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next()
}));

import { processSamplesRoutes } from './processSamples';

function app() {
  const a = new Hono();
  a.route('/', processSamplesRoutes);
  return a;
}

describe('GET /:id/process-samples', () => {
  beforeEach(() => { calls.nearest = null; calls.markers = null; calls.nearestRows = DEFAULT_NEAREST; });

  it('returns the nearest snapshot for ?at', async () => {
    const res = await app().request('/dev-1/process-samples?at=2026-06-13T12:00:30.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sample.topProcesses[0].name).toBe('chrome');
    expect(calls.nearest).toBe('nearest');
  });

  it('returns timestamp markers for ?from&to', async () => {
    const res = await app().request('/dev-1/process-samples?from=2026-06-13T11:00:00.000Z&to=2026-06-13T12:00:00.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.markers)).toBe(true);
    expect(calls.markers).toBe(true);
  });

  it('returns { sample: null } when no snapshot exists at-or-before the time', async () => {
    calls.nearestRows = [];
    const res = await app().request('/dev-1/process-samples?at=2026-06-13T12:00:30.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sample).toBeNull();
    expect(calls.nearest).toBe('nearest');
  });

  it('rejects a request with neither ?at nor ?from&to (400)', async () => {
    const res = await app().request('/dev-1/process-samples');
    expect(res.status).toBe(400);
  });

  it('rejects ?from without ?to (400)', async () => {
    const res = await app().request('/dev-1/process-samples?from=2026-06-13T11:00:00.000Z');
    expect(res.status).toBe(400);
  });
});
