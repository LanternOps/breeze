/**
 * Contract (Wisp W04, spec §10 / w00 cross-wave reconciliation 1): EVERY
 * `/api/v1/wisp/*` route is gated by `requireEntitlement('wisp')`, and the
 * deployment flag wins over it (flag off ⇒ 404, never 403).
 *
 * The routes are ENUMERATED from the mounted routers (`Hono#routes`), not
 * listed by hand, so a route added later without the gate fails here. The
 * routers themselves are cross-checked against index.ts: mounting a new
 * `/wisp…` router without adding it to WISP_ROUTERS below fails too.
 *
 * Every service and the DB are wired to throw, so a request that slips past
 * the gate answers 500/400 instead of the expected 403 — the gate, not a
 * downstream refusal, must be what answers.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  hasEntitlement: vi.fn(async () => false),
  reached: () => {
    throw new Error('handler reached past the entitlement gate');
  },
}));

const PARTNER = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    // A fully authorized partner-scope human with ai_sessions:use and MFA.
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', {
        principal: { kind: 'user_session' },
        scope: 'partner',
        partnerId: PARTNER,
        orgId: null,
        accessibleOrgIds: null,
        partnerOrgAccess: 'all',
        user: { id: USER, email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
        token: { sid: 'sid', mfa: true },
        canAccessOrg: () => true,
        orgCondition: () => undefined,
      });
      await next();
    },
    requireScope: actual.requireScope,
    requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
    requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});
vi.mock('../middleware/userRateLimit', () => ({
  userRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wispEnabled: () => h.wispEnabled(),
  aiArtifactCaptureEnabled: () => true,
}));
vi.mock('../services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntitlement: h.hasEntitlement,
}));
vi.mock('../db', () => ({
  db: new Proxy({}, { get: () => h.reached }),
  runAfterDbContextCommit: h.reached,
}));
vi.mock('../db/partnerAxisRead', () => ({ readOwnPartnerAxisRows: h.reached }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.reached }));
vi.mock('../services/wisp/grants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' && !/^[A-Z]/.test(k) ? h.reached : v]));
});
vi.mock('../services/wisp/memoryService', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' && !/^[A-Z]/.test(k) ? h.reached : v]));
});
vi.mock('../services/wisp/threads', () => ({
  getOrCreateThread: h.reached,
  setThreadFocus: h.reached,
  WispThreadError: class extends Error {},
}));
vi.mock('../services/wisp/threadAttachments', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addThreadAttachment: h.reached,
  listThreadAttachments: h.reached,
}));
vi.mock('../services/wisp/grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGrantCeiling: h.reached,
}));

import { wispRoutes } from './wisp';
import { wispMemoryRoutes } from './wisp/memory';

/** Every router index.ts mounts under /wisp, with its mount prefix (relative to /api/v1). */
const WISP_ROUTERS: Array<{ name: string; prefix: string; router: Hono }> = [
  { name: 'wispMemoryRoutes', prefix: '/wisp/memory', router: wispMemoryRoutes },
  { name: 'wispRoutes', prefix: '/wisp', router: wispRoutes },
];

const PARAM_VALUE = '44444444-4444-4444-8444-444444444444';

type Endpoint = { method: string; path: string; label: string };

/** Distinct method+path pairs of real routes; `use('*')` middleware entries are skipped. */
function enumerate(): Endpoint[] {
  const out = new Map<string, Endpoint>();
  for (const { name, prefix, router } of WISP_ROUTERS) {
    for (const route of router.routes) {
      if (route.path.endsWith('*')) continue; // router-level middleware (`use('*')`)
      const method = route.method === 'ALL' ? 'GET' : route.method;
      const concrete = route.path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, PARAM_VALUE);
      const path = concrete === '/' ? prefix : `${prefix}${concrete}`;
      const label = `${name}: ${route.method} ${route.path}`;
      out.set(`${method} ${path}`, { method, path, label });
    }
  }
  return [...out.values()];
}

function buildApp(): Hono {
  // Same order as index.ts (memory first — see the mount-order test in routes/wisp/memory.test.ts).
  const app = new Hono();
  for (const { prefix, router } of WISP_ROUTERS) app.route(prefix, router);
  app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: 'internal', message: err.message }, 500)));
  return app;
}

function send(app: Hono, { method, path }: Endpoint): Promise<Response> {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return Promise.resolve(app.request(path, {
    method,
    ...(hasBody ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
  }));
}

const ENDPOINTS = enumerate();

beforeEach(() => {
  vi.clearAllMocks();
  h.wispEnabled.mockReturnValue(true);
  h.hasEntitlement.mockResolvedValue(false);
});

describe('every /api/v1/wisp/* route is entitlement-gated (contract)', () => {
  it('index.ts mounts exactly the wisp routers this contract enumerates', () => {
    const src = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
    const mounted = [...src.matchAll(/api\.route\(\s*'(\/wisp[^']*)'\s*,\s*(\w+)\s*\)/g)].map((m) => ({ prefix: m[1], name: m[2] }));
    expect(mounted).toEqual(WISP_ROUTERS.map(({ prefix, name }) => ({ prefix, name })));
  });

  it('enumerates the W02 grant, W03 memory and W04 thread routes (non-vacuous)', () => {
    const keys = ENDPOINTS.map((e) => e.label);
    expect(ENDPOINTS.length).toBeGreaterThanOrEqual(17);
    for (const expected of [
      'wispRoutes: GET /grants/preview',
      'wispRoutes: POST /grants/:id/revoke',
      'wispRoutes: PATCH /grants/:id/settings',
      'wispRoutes: GET /thread',
      'wispRoutes: PATCH /thread/:id/focus',
      'wispRoutes: POST /thread/:id/attachments',
      'wispMemoryRoutes: GET /',
      'wispMemoryRoutes: POST /:id/retract',
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it.each(ENDPOINTS.map((e) => [e.label, e] as const))(
    'flag ON + not entitled → 403 entitlement_required: %s',
    async (_label, endpoint) => {
      const res = await send(buildApp(), endpoint);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'entitlement_required', error: 'Wisp', featureKey: 'wisp' });
      expect(h.hasEntitlement).toHaveBeenCalledWith(PARTNER, 'wisp');
    },
  );

  it.each(ENDPOINTS.map((e) => [e.label, e] as const))(
    'flag OFF + not entitled → 404 (the flag wins; the resolver is never consulted): %s',
    async (_label, endpoint) => {
      h.wispEnabled.mockReturnValue(false);
      const res = await send(buildApp(), endpoint);
      expect(res.status).toBe(404);
      expect(h.hasEntitlement).not.toHaveBeenCalled();
    },
  );
});
