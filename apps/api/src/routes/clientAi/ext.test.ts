import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';

import type { AuthContext } from '../../middleware/auth';
import type { StagedExtensionContributions } from '../../extensions/contributionRegistry';

const { getOrgPolicyMock, withDbAccessContextMock, sessionOverrides } = vi.hoisted(() => ({
  getOrgPolicyMock: vi.fn(),
  withDbAccessContextMock: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  sessionOverrides: {} as Record<string, unknown>,
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  withDbAccessContext: withDbAccessContextMock,
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

vi.mock('../../services/redis', () => ({ getRedis: () => null }));

vi.mock('../../services/clientAiPolicy', () => ({
  getOrgPolicy: getOrgPolicyMock,
  isClientUserPermitted: () => true,
}));

const VALID_TOKEN = 'valid-session-token';
const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '0d0d0d0d-1111-4222-8333-444455556666';
const CLIENT_USER_ID = 'beefbeef-1111-4222-8333-444455556666';

// Only the session-validation half is stubbed. The org-policy gate
// (requireClientAiEnabledMiddleware) stays REAL so the per-request policy
// re-check is exercised rather than mocked away.
vi.mock('../../middleware/clientAiAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/clientAiAuth')>();
  return {
    ...actual,
    clientAiAuthMiddleware: vi.fn((c: any, next: any) => {
      if (c.req.header('authorization') !== `Bearer ${VALID_TOKEN}`) {
        return c.json({ error: 'Invalid or expired session' }, 401);
      }
      c.set('clientAiAuth', {
        clientUserId: CLIENT_USER_ID,
        orgId: ORG_ID,
        email: 'end.user@example.test',
        name: 'End User',
        token: VALID_TOKEN,
        partnerAiForOfficeEnabled: true,
        ...sessionOverrides,
      });
      return next();
    }),
  };
});

import {
  createClientAiExtRoutes,
  createClientSurfaceWrapper,
  isProxyable,
  withProxiedAuth,
  CLIENT_AI_EXT_MOUNT_PREFIX,
} from './ext';
import { buildOrgAccessClosures, requirePartner, requireScope } from '../../middleware/auth';

/** The same shape `synthesizeOrgAuthContext` emits, for direct wrapper tests. */
function fixtureAuthContext(): AuthContext {
  const accessibleOrgIds = [ORG_ID];
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures(accessibleOrgIds);
  return {
    user: {
      id: CLIENT_USER_ID, email: 'end.user@example.test', name: 'End User', isPlatformAdmin: false,
    },
    token: {
      sub: CLIENT_USER_ID,
      email: 'end.user@example.test',
      roleId: null,
      orgId: ORG_ID,
      partnerId: null,
      scope: 'organization',
      type: 'access',
      mfa: false,
    },
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds,
    partnerOrgAccess: null,
    orgCondition,
    canAccessOrg,
  } as AuthContext;
}

let capturedAuth: AuthContext | undefined;
let capturedAuthorization: string | null | undefined;
let capturedCookie: string | null | undefined;
let capturedQuery: string | undefined;
let capturedApiKey: string | null | undefined;
let capturedProxyAuthorization: string | null | undefined;

/**
 * A neutral fixture extension. It deliberately registers routes both inside
 * and outside the surface it opts into, so the proxy's fencing is provable.
 */
function buildFixtureExtensionApp(): Hono {
  const app = new Hono();

  app.all('/client/echo', async (c) => {
    capturedAuth = c.get('auth');
    capturedAuthorization = c.req.header('authorization') ?? null;
    capturedCookie = c.req.header('cookie') ?? null;
    capturedQuery = new URL(c.req.url).search;
    capturedApiKey = c.req.header('x-api-key') ?? null;
    capturedProxyAuthorization = c.req.header('proxy-authorization') ?? null;
    return c.json({ ok: true, seen: c.req.method });
  });

  // Extension code trying to write a cookie on the API origin.
  app.get('/client/sets-cookie', (c) => {
    c.header('set-cookie', 'evil=1; Path=/');
    c.header('x-extension-header', 'kept');
    return c.json({ ok: true });
  });

  // Gated with the REAL core scope gates — an organization-scoped context must
  // never satisfy them.
  app.get('/client/partner-admin', requireScope('partner', 'system'), (c) => c.json({ leaked: true }));
  app.get('/client/needs-partner', requirePartner, (c) => c.json({ leaked: true }));

  // Extension code that throws. The wrapper must RETHROW (as the gateway's
  // wrappers do) so core's own onError — JSON error shape plus Sentry capture —
  // handles it, instead of Hono's default handler swallowing it inside the
  // wrapper and emitting a bare plain-text response with no capture.
  app.get('/client/boom', () => {
    throw new Error('fixture-ext exploded');
  });
  app.get('/client/teapot', () => {
    throw new HTTPException(418, { message: 'fixture teapot' });
  });

  // Never reachable through this proxy.
  app.get('/agent/ping', (c) => c.json({ leaked: 'agent' }));
  app.get('/helper/ping', (c) => c.json({ leaked: 'helper' }));
  app.get('/dashboard/summary', (c) => c.json({ leaked: 'dashboard' }));

  return app;
}

function makeManifest(overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
  const manifest: ExtensionManifestV1 = {
    apiVersion: 'breeze.extensions/v1',
    name: 'fixture-ext',
    version: '1.0.0',
    routeNamespace: 'fixture-ext',
    requires: { breeze: '>=0.1.0', serverSdk: '^1.0.0', capabilities: ['server.routes.v1'] },
    server: { entry: 'server/index.cjs' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [],
    tenancy: {
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
    },
    ...overrides,
  };
  return manifest;
}

function makeSnapshot(
  manifest: ExtensionManifestV1,
  enabled = true,
): StagedExtensionContributions {
  const extensionApp = buildFixtureExtensionApp();
  return {
    name: manifest.name,
    version: manifest.version,
    manifest,
    routeApp: {
      // M-1: mirror `copyAndSealRouteApp.composeInto`
      // (extensions/contributionRegistry.ts) exactly — `basePath` + per-route
      // `.on()`, NOT `host.route()`. The two are behaviourally equivalent
      // today, but only this shape exercises the composition core actually
      // ships, so the wrapper's fence and `c.set('auth')` lift are proven
      // against the real mounting mechanism.
      composeInto(host: Hono, mountPrefix: string) {
        const mountedHost = host.basePath(mountPrefix);
        for (const route of extensionApp.routes) {
          mountedHost.on(route.method, route.path, route.handler);
        }
      },
    },
    jobs: new Map(),
    aiTools: new Map(),
    enabled,
  } as unknown as StagedExtensionContributions;
}

function buildApp(
  snapshots: Record<string, StagedExtensionContributions>,
  isEnabled: (name: string) => Promise<boolean> = async () => true,
): Hono {
  const app = new Hono();
  app.route(
    CLIENT_AI_EXT_MOUNT_PREFIX,
    createClientAiExtRoutes({
      registry: { get: (name: string) => snapshots[name] },
      isEnabled,
    }),
  );
  return app;
}

const optedIn = makeManifest({
  clientSurfaces: [{ pathPrefix: '/client' }],
});

function url(path: string): string {
  return `http://local.test${CLIENT_AI_EXT_MOUNT_PREFIX}${path}`;
}

function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { authorization: `Bearer ${VALID_TOKEN}`, ...(init.headers as Record<string, string>) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(sessionOverrides)) delete sessionOverrides[key];
  capturedAuth = undefined;
  capturedAuthorization = undefined;
  capturedCookie = undefined;
  capturedQuery = undefined;
  capturedApiKey = undefined;
  capturedProxyAuthorization = undefined;
  getOrgPolicyMock.mockResolvedValue({ orgId: ORG_ID, enabled: true, userAccess: 'all', selectedUserIds: [] });
});

describe('client-ai extension client-surface proxy', () => {
  // DISCLOSURE: these two assert the STUB's behaviour, not the real session
  // middleware — `clientAiAuthMiddleware` is mocked above. What they prove is
  // that this router runs a session gate before dispatch, nothing about token
  // validation itself. The real middleware's 401 paths (and their published
  // `session_invalid` code) are covered in middleware/clientAiAuth.test.ts.
  describe('session', () => {
    it('401s without a session token', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/echo'));
      expect(res.status).toBe(401);
    });

    it('401s on an invalid session token', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/echo'), {
        headers: { authorization: 'Bearer nope' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('org policy', () => {
    it('403s when the org policy is disabled, re-checked per request', async () => {
      getOrgPolicyMock.mockResolvedValue({ orgId: ORG_ID, enabled: false, userAccess: 'all', selectedUserIds: [] });
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/echo'), authed());
      expect(res.status).toBe(403);
      expect(getOrgPolicyMock).toHaveBeenCalledWith(ORG_ID);
    });

    it('re-reads the policy on every request rather than trusting the session', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      expect((await app.request(url('/fixture-ext/client/echo'), authed())).status).toBe(200);
      getOrgPolicyMock.mockResolvedValue({ orgId: ORG_ID, enabled: false, userAccess: 'all', selectedUserIds: [] });
      expect((await app.request(url('/fixture-ext/client/echo'), authed())).status).toBe(403);
      expect(getOrgPolicyMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('default-deny resolution', () => {
    it('404s for an unknown extension', async () => {
      const app = buildApp({});
      const res = await app.request(url('/no-such-ext/client/echo'), authed());
      expect(res.status).toBe(404);
    });

    it('404s for an extension that declares no clientSurfaces', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(makeManifest()) });
      const res = await app.request(url('/fixture-ext/client/echo'), authed());
      expect(res.status).toBe(404);
    });

    it('404s for an empty clientSurfaces declaration', async () => {
      const app = buildApp({
        'fixture-ext': makeSnapshot(makeManifest({ clientSurfaces: [] })),
      });
      const res = await app.request(url('/fixture-ext/client/echo'), authed());
      expect(res.status).toBe(404);
    });

    it.each([
      ['/agent/ping'],
      ['/helper/ping'],
      ['/dashboard/summary'],
      ['/clientele/echo'],
      ['/'],
    ])('404s for %s — outside every declared pathPrefix', async (path) => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url(`/fixture-ext${path}`), authed());
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('leaked');
    });

    // NOTE: the URL parser normalizes `/client/../agent/ping` to `/agent/ping`
    // before any of this code runs, so what this asserts is the reserved-prefix
    // backstop, NOT the `..`-segment check. The `.`/`..` branch of `isProxyable`
    // is covered directly in the `isProxyable (unit)` block below.
    it('404s on a dot-segment URL that normalizes onto a reserved prefix', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/../agent/ping'), authed());
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('leaked');
    });

    it.each([
      ['/AGENT/ping'],
      ['/Helper/ping'],
    // M-2: be honest about which layer this covers. `proxyablePrefixes`
    // filters a reserved declaration out case-insensitively, so the request
    // 404s at the "no proxyable surface" step and never reaches the
    // `matchesReserved` backstop inside `isProxyable`. That backstop is not
    // HTTP-reachable at all (prefix matching is segment-aware, so no
    // *surviving* prefix can ever contain a reserved path), which is why it is
    // covered directly in the `isProxyable (unit)` block below.
    ])('404s for %s — a manifest declaring a reserved prefix yields no proxyable surface', async (path) => {
      const app = buildApp({
        // A prefix that would otherwise open the reserved namespace, as an
        // unvalidated manifest could carry.
        'fixture-ext': makeSnapshot(makeManifest({ clientSurfaces: [{ pathPrefix: '/AGENT' }, { pathPrefix: '/Helper' }] })),
      });
      const res = await app.request(url(`/fixture-ext${path}`), authed());
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('leaked');
    });
  });

  // I4: the `.`/`..` branch is unreachable through a parsed URL, so cover it
  // where it actually lives rather than pretending an HTTP request exercises it.
  describe('isProxyable (unit)', () => {
    const prefixes = ['/client'];

    it('accepts the declared prefix and its sub-tree', () => {
      expect(isProxyable('/client', prefixes)).toBe(true);
      expect(isProxyable('/client/echo', prefixes)).toBe(true);
    });

    it('rejects a prefix-adjacent path', () => {
      expect(isProxyable('/clientele/echo', prefixes)).toBe(false);
    });

    it('rejects a relative path', () => {
      expect(isProxyable('client/echo', prefixes)).toBe(false);
    });

    it.each([
      ['/client/../agent/ping'],
      ['/client/./echo'],
      ['/client/..'],
      ['/../client/echo'],
    ])('rejects %s — dot segments are refused outright', (path) => {
      expect(isProxyable(path, prefixes)).toBe(false);
    });

    it.each([
      ['/agent/ping'],
      ['/AGENT/ping'],
      ['/Helper/ping'],
      ['/helper'],
    ])('rejects reserved namespace %s regardless of case', (path) => {
      expect(isProxyable(path, ['/agent', '/helper', '/AGENT', '/Helper'])).toBe(false);
    });
  });

  // I5: the wrapper's defence-in-depth is unreachable via dispatch (the outer
  // check always wins), so exercise it directly instead of shipping it untested.
  describe('createClientSurfaceWrapper (unit)', () => {
    const mountPrefix = `${CLIENT_AI_EXT_MOUNT_PREFIX}/fixture-ext`;

    // M-2 follow-on: this MUST run with a context on the seam. Without one the
    // wrapper's missing-context branch denies first and the assertion below
    // holds even if the prefix fence is deleted — i.e. the test would not
    // discriminate. Verified by mutation: removing the `isProxyable` call in
    // `createClientSurfaceWrapper` fails this test (200 + `leaked`) and only
    // this test.
    it.each([
      ['/agent/ping'],
      ['/helper/ping'],
      ['/dashboard/summary'],
    ])('404s %s — outside the declared prefixes, even with a valid context on the seam', async (path) => {
      const wrapper = createClientSurfaceWrapper(makeSnapshot(optedIn), mountPrefix, ['/client']);
      const res = await withProxiedAuth(
        fixtureAuthContext(),
        () => wrapper.fetch(new Request(`http://local.test${mountPrefix}${path}`)),
      );
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('leaked');
    });

    it('serves a path inside the declared prefixes with the seam context lifted', async () => {
      const wrapper = createClientSurfaceWrapper(makeSnapshot(optedIn), mountPrefix, ['/client']);
      const res = await withProxiedAuth(
        fixtureAuthContext(),
        () => wrapper.fetch(new Request(`http://local.test${mountPrefix}/client/echo`)),
      );
      expect(res.status).toBe(200);
      expect(capturedAuth?.orgId).toBe(ORG_ID);
    });

    it('404s when no synthesized auth context is on the seam', async () => {
      const wrapper = createClientSurfaceWrapper(makeSnapshot(optedIn), mountPrefix, ['/client']);
      const res = await wrapper.fetch(new Request(`http://local.test${mountPrefix}/client/echo`));
      expect(res.status).toBe(404);
      expect(capturedAuth).toBeUndefined();
    });
  });

  // M1: the mount arithmetic is spread across three files; a drift silently
  // 404s the whole surface. Derive it from the real sources.
  describe('mount prefix', () => {
    it('matches the mount arithmetic of the real app', () => {
      const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
      const appSrc = read('../../index.ts');
      const clientAiSrc = read('./index.ts');

      const apiMount = appSrc.match(/app\.route\('([^']+)',\s*api\)/)?.[1];
      const clientAiMount = appSrc.match(/api\.route\('([^']+)',\s*clientAiRoutes\)/)?.[1];
      const extMount = clientAiSrc.match(/clientAiRoutes\.route\('([^']+)',\s*clientAiExtRoutes\)/)?.[1];

      expect(apiMount).toBeDefined();
      expect(clientAiMount).toBeDefined();
      expect(extMount).toBeDefined();
      expect(`${apiMount}${clientAiMount}${extMount}`).toBe(CLIENT_AI_EXT_MOUNT_PREFIX);
    });
  });

  // I2: 403 and 503 are each emitted for several distinct reasons across this
  // proxy and the client-ai middleware chain, so the proxy's own responses
  // carry a stable machine-readable `code` callers can branch on.
  describe('status codes are distinguishable', () => {
    it('tags its own 404 with extension_surface_not_found', async () => {
      const app = buildApp({});
      const res = await app.request(url('/no-such-ext/client/echo'), authed());
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'extension_surface_not_found' });
    });

    it('tags its own 503 with extension_disabled', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn, false) });
      const res = await app.request(url('/fixture-ext/client/echo'), authed());
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'extension_disabled' });
    });
  });

  describe('availability', () => {
    it('503s when the extension snapshot is disabled', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn, false) });
      const res = await app.request(url('/fixture-ext/client/echo'), authed());
      expect(res.status).toBe(503);
    });

    it('503s when the extension is disabled for the deployment', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) }, async () => false);
      const res = await app.request(url('/fixture-ext/client/echo'), authed());
      expect(res.status).toBe(503);
    });
  });

  describe('dispatch', () => {
    it('passes the response through and synthesizes an organization-scoped auth context', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/echo'), authed({ method: 'POST' }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, seen: 'POST' });

      expect(capturedAuth).toBeDefined();
      expect(capturedAuth!.user.id).toBe(CLIENT_USER_ID);
      expect(capturedAuth!.user.email).toBe('end.user@example.test');
      expect(capturedAuth!.user.name).toBe('End User');
      expect(capturedAuth!.user.isPlatformAdmin).toBe(false);
      expect(capturedAuth!.scope).toBe('organization');
      expect(capturedAuth!.orgId).toBe(ORG_ID);
      expect(capturedAuth!.partnerId).toBeNull();
      expect(capturedAuth!.accessibleOrgIds).toEqual([ORG_ID]);
    });

    it('falls back to the email when the directory record has no display name', async () => {
      sessionOverrides.name = null;
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      await app.request(url('/fixture-ext/client/echo'), authed());
      expect(capturedAuth!.user.name).toBe('end.user@example.test');
    });

    it('scopes the org-axis closures to the session org', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      await app.request(url('/fixture-ext/client/echo'), authed());
      expect(capturedAuth!.canAccessOrg(ORG_ID)).toBe(true);
      expect(capturedAuth!.canAccessOrg(OTHER_ORG_ID)).toBe(false);
    });

    it('strips the inbound Authorization header and cookies before forwarding', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/echo'), authed({
        headers: { cookie: 'session=abc' },
      }));
      expect(res.status).toBe(200);
      expect(capturedAuthorization).toBeNull();
      expect(capturedCookie).toBeNull();
    });

    it('strips every other caller credential header before forwarding', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/echo'), authed({
        headers: { 'x-api-key': 'core-api-key', 'proxy-authorization': 'Basic abc' },
      }));
      expect(res.status).toBe(200);
      expect(capturedApiKey).toBeNull();
      expect(capturedProxyAuthorization).toBeNull();
    });

    it('strips Set-Cookie off the downstream response but keeps other headers', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/sets-cookie'), authed());
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('x-extension-header')).toBe('kept');
    });

    it('strips a query-string session token before forwarding', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(
        url(`/fixture-ext/client/echo?token=${VALID_TOKEN}&keep=1`),
        authed(),
      );
      expect(res.status).toBe(200);
      expect(capturedQuery).not.toContain(VALID_TOKEN);
      expect(capturedQuery).toContain('keep=1');
    });
  });

  // The wrapper must not absorb extension errors: core's onError is where the
  // JSON error shape and the Sentry capture live, and the gateway's wrappers
  // already rethrow for exactly that reason.
  describe('error propagation', () => {
    function withHostErrorHandler(app: Hono, handler: (err: Error, c: any) => Response) {
      app.onError(handler as never);
      return app;
    }

    it('rethrows an unhandled extension error to the host error handler', async () => {
      const onError = vi.fn((err: Error, c: any) =>
        c.json({ error: 'Internal Server Error', message: err.message }, 500));
      const app = withHostErrorHandler(
        buildApp({ 'fixture-ext': makeSnapshot(optedIn) }),
        onError,
      );
      const res = await app.request(url('/fixture-ext/client/boom'), authed());
      expect(onError).toHaveBeenCalled();
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ message: 'fixture-ext exploded' });
    });

    it("rethrows an HTTPException so the host renders core's JSON body, not Hono's default text", async () => {
      const app = withHostErrorHandler(
        buildApp({ 'fixture-ext': makeSnapshot(optedIn) }),
        (err: Error, c: any) => (err instanceof HTTPException
          ? c.json({ error: err.message, message: err.message }, err.status)
          : c.json({ error: 'Internal Server Error' }, 500)),
      );
      const res = await app.request(url('/fixture-ext/client/teapot'), authed());
      expect(res.status).toBe(418);
      expect(await res.json()).toMatchObject({ error: 'fixture teapot' });
    });
  });

  describe('scope fencing', () => {
    it('cannot satisfy a partner/system scope gate', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/partner-admin'), authed());
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('leaked');
    });

    it('cannot satisfy a partner-context gate', async () => {
      const app = buildApp({ 'fixture-ext': makeSnapshot(optedIn) });
      const res = await app.request(url('/fixture-ext/client/needs-partner'), authed());
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('leaked');
    });
  });
});
