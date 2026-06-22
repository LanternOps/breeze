import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const DEFAULT_NEAREST = [{ timestamp: new Date('2026-06-13T12:00:00Z'), agentTimestamp: null, topProcesses: [{ name: 'chrome', pid: 1, cpu: 9, ramMb: 100 }] }];
// `anyRows` backs the existence probe the route runs when the nearest lookup
// misses, to distinguish "device has no samples at all" from "none before this
// time" (issue #1722). Default: device HAS a sample somewhere.
const calls: any = { nearest: null, markers: null, anyProbe: null, nearestRows: DEFAULT_NEAREST, anyRows: [{ timestamp: new Date('2026-06-13T11:00:00Z') }] };
vi.mock('../../db', () => {
  // Nearest snapshot: full row select → .from().where().orderBy().limit()
  const nearestChain = () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => { calls.nearest = 'nearest'; return Promise.resolve(calls.nearestRows); },
        }),
      }),
    }),
  });
  return {
    db: {
      select: (cols: any) => {
        // Both the markers query and the existence probe select only { timestamp }.
        // They diverge by terminal: markers ends in .orderBy() (no limit), the
        // existence probe ends in .where().limit() (no orderBy).
        if (cols && Object.keys(cols).length === 1 && 'timestamp' in cols) {
          return {
            from: () => ({
              where: () => ({
                orderBy: () => { calls.markers = true; return Promise.resolve([{ timestamp: new Date('2026-06-13T11:57:00Z') }]); },
                limit: () => { calls.anyProbe = true; return Promise.resolve(calls.anyRows); },
              }),
            }),
          };
        }
        return nearestChain();
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
  beforeEach(() => {
    calls.nearest = null; calls.markers = null; calls.anyProbe = null;
    calls.nearestRows = DEFAULT_NEAREST;
    calls.anyRows = [{ timestamp: new Date('2026-06-13T11:00:00Z') }];
  });

  it('returns the nearest snapshot for ?at (hasAnySample true, no probe)', async () => {
    const res = await app().request('/dev-1/process-samples?at=2026-06-13T12:00:30.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sample.topProcesses[0].name).toBe('chrome');
    expect(body.hasAnySample).toBe(true);
    expect(calls.nearest).toBe('nearest');
    // A sample was found, so the existence probe must NOT run.
    expect(calls.anyProbe).toBeNull();
  });

  it('returns timestamp markers for ?from&to', async () => {
    const res = await app().request('/dev-1/process-samples?from=2026-06-13T11:00:00.000Z&to=2026-06-13T12:00:00.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.markers)).toBe(true);
    expect(calls.markers).toBe(true);
  });

  it('returns { sample: null, hasAnySample: true } when samples exist but none at-or-before the time', async () => {
    calls.nearestRows = [];
    // device has other samples — existence probe finds one
    calls.anyRows = [{ timestamp: new Date('2026-06-13T11:00:00Z') }];
    const res = await app().request('/dev-1/process-samples?at=2026-06-13T12:00:30.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sample).toBeNull();
    expect(body.hasAnySample).toBe(true);
    expect(calls.nearest).toBe('nearest');
    expect(calls.anyProbe).toBe(true);
  });

  it('returns { sample: null, hasAnySample: false } when the device has no samples at all', async () => {
    calls.nearestRows = [];
    calls.anyRows = []; // existence probe finds nothing
    const res = await app().request('/dev-1/process-samples?at=2026-06-13T12:00:30.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sample).toBeNull();
    expect(body.hasAnySample).toBe(false);
    expect(calls.anyProbe).toBe(true);
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
