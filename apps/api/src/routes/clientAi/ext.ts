import { AsyncLocalStorage } from 'node:async_hooks';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';

import {
  clientAiAuthMiddleware,
  requireClientAiEnabledMiddleware,
} from '../../middleware/clientAiAuth';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import {
  extensionContributionRegistry,
  type StagedExtensionContributions,
} from '../../extensions/contributionRegistry';

/**
 * End-user client-surface proxy: `ALL /api/v1/client-ai/ext/:extension/*`.
 *
 * The end-user surface authenticates with its own session (bearer token
 * validated by `clientAiAuthMiddleware`), which is NOT one of the identities
 * the extension gateway understands. This proxy is the single, generic bridge:
 * it turns a validated end-user session into an organization-scoped
 * `AuthContext` and dispatches into whatever path prefixes the target
 * extension's manifest explicitly opted into via `clientSurfaces`.
 *
 * It is deliberately default-deny at every step. PUBLISHED STATUS CONTRACT —
 * note that 401/403/503 are each emitted for MORE than one reason across the
 * chain, so a caller that must branch should read the body's `code` rather
 * than the status alone. Three codes are published and each is emitted by real
 * code on a tested path: `extension_surface_not_found` and `extension_disabled`
 * (this file) and `session_invalid` (every 401 in `middleware/clientAiAuth`).
 * The 403s below deliberately carry NO code — their `error` strings
 * (`disabled`, `user_not_permitted`) are the existing client-ai contract and
 * are not re-published here:
 *
 *   401  no/invalid/expired session                       (clientAiAuthMiddleware)
 *   403  · client user status is not 'active'             (clientAiAuthMiddleware)
 *        · partner-level AI-for-Office entitlement off     (requireClientAiEnabled…)
 *        · org policy disabled, re-checked PER REQUEST     (requireClientAiEnabled…)
 *        · user not permitted by the org policy's user list(requireClientAiEnabled…)
 *   404  unknown extension · no `clientSurfaces` declaration · path outside
 *        every declared prefix                    (this file, code below)
 *   503  · session store (Redis) unavailable              (clientAiAuthMiddleware)
 *        · extension disabled, snapshot or deployment  (this file, code below)
 *   else the downstream response, passed through unchanged (minus stripped
 *        response headers, see below).
 *
 * AUTH CONTRACT the extension sees (ratified deviation from the task brief,
 * which said `partnerId: undefined`): `AuthContext.partnerId` is typed
 * `string | null` and is REQUIRED, so this proxy emits `partnerId: null` —
 * exactly what core's own `authMiddleware` emits for an organization-scoped
 * user. Downstream code must test truthiness (`if (!auth.partnerId)`), never
 * `=== undefined`.
 *
 * Security properties this file is responsible for:
 *  - The synthesized context is ALWAYS `scope: 'organization'` with
 *    `partnerId: null`, `partnerOrgAccess: null`, `isPlatformAdmin: false` and
 *    a single-org `accessibleOrgIds`. It therefore cannot satisfy any
 *    partner/system-scope or platform-admin gate an extension mounts on its
 *    other routes.
 *  - The context travels over an AsyncLocalStorage seam and is written with
 *    `c.set('auth', …)` inside the dispatch wrapper. It is never derived from,
 *    nor expressible as, a request header — so no caller can forge it.
 *  - Inbound credential headers (`Authorization`, `Cookie`, `X-API-Key`,
 *    `Proxy-Authorization`) and any `?token=` query parameter are stripped
 *    before forwarding, so no caller credential is handed to extension code.
 *  - `Set-Cookie` is stripped off the downstream RESPONSE: extension code must
 *    not be able to write cookies on the core API origin for an end-user
 *    browser session. This is a denylist, not an allowlist, and no ticket
 *    tracks tightening it — treat that as an accepted, recorded risk: an
 *    extension can still set other origin-scoped response headers here
 *    (`access-control-allow-*`, `content-security-policy`, `x-frame-options`,
 *    `clear-site-data`). Extension code is first-party-reviewed and signed, so
 *    this is a defence-in-depth gap rather than a trust boundary; converting
 *    to an allowlist is the correct hardening if that ever stops being true.
 *  - Path fencing is applied to the resolved (normalized) request path, and
 *    re-applied inside the wrapper, so `/agent`, `/helper` and any admin path
 *    stay unreachable no matter how the caller crafts the URL.
 *  - Extension errors are RETHROWN out of the wrapper (as the extension
 *    gateway does) so core's own `onError` renders them and Sentry sees them.
 *
 * DELIBERATE NON-GOALS, so they read as decisions rather than omissions:
 *  - This proxy enforces only the org policy's `enabled` + permitted-user
 *    axes (via `requireClientAiEnabledMiddleware`). `writeMode`, write
 *    approval, DLP and budgets are NOT applied here: they are semantics of
 *    core's own `/client-ai/sessions` chokepoint, and an extension client
 *    surface owns its own equivalents. The policy object is not forwarded
 *    across the dispatch boundary either, so an extension that needs those
 *    axes must enforce them itself.
 *  - Core's `requirePermission` gates always 403 on this path: the synthesized
 *    `user.id` is a portal-user id, which is not a core `users` id, so
 *    permission lookup returns nothing and the gate fails closed. Same
 *    property as the MFA note above — intentional, and fail-closed.
 */

/** Absolute mount point; the wrapper needs it to compute relative paths. */
export const CLIENT_AI_EXT_MOUNT_PREFIX = '/api/v1/client-ai/ext';

/**
 * Namespaces that carry their own machine identities. Never reachable with an
 * end-user context, even if a (malformed or unvalidated) manifest lists one —
 * the manifest schema also refuses them, this is the runtime backstop.
 */
const NEVER_PROXYABLE_PREFIXES = ['/agent', '/helper'] as const;

/**
 * Caller credentials never forwarded downstream. `x-api-key` and
 * `proxy-authorization` are accepted auth headers elsewhere on this API, so
 * they are stripped for the same reason `authorization` is.
 */
const CALLER_CREDENTIAL_HEADERS = [
  'authorization',
  'cookie',
  'x-api-key',
  'proxy-authorization',
] as const;

/** Response headers extension code may never set on the core API origin. */
const STRIPPED_RESPONSE_HEADERS = ['set-cookie', 'set-cookie2'] as const;

/** Minimal registry surface the proxy needs — keeps it trivially testable. */
export interface ClientAiExtRegistry {
  get(name: string): StagedExtensionContributions | undefined;
}

export interface ClientAiExtRoutesOptions {
  registry: ClientAiExtRegistry;
  isEnabled: (name: string) => Promise<boolean>;
}

/**
 * The auth seam. A dispatch writes the synthesized context here and the
 * wrapper's first middleware lifts it onto the Hono context, so the extension
 * reads it exactly as it would any other identity: `c.get('auth')`.
 */
const proxiedAuth = new AsyncLocalStorage<AuthContext>();

/**
 * Install a synthesized context on the seam for the duration of `fn`. This is
 * the only writer of the seam; `dispatch` calls it on the real request path.
 * It is exported so the wrapper's fences can be exercised WITH a context
 * present — without it, a direct `wrapper.fetch()` is denied by the
 * missing-context branch before the prefix fence is ever consulted, and the
 * fence test cannot tell a working fence from a deleted one.
 */
export function withProxiedAuth<T>(auth: AuthContext, fn: () => T): T {
  return proxiedAuth.run(auth, fn);
}

function matchesPrefix(relativePath: string, pathPrefix: string): boolean {
  return relativePath === pathPrefix || relativePath.startsWith(`${pathPrefix}/`);
}

/**
 * Reserved-namespace test, case-insensitive on both sides: a backstop must not
 * be defeatable by spelling (`/AGENT`), whichever side the casing is on.
 */
function matchesReserved(path: string): boolean {
  const lower = path.toLowerCase();
  return NEVER_PROXYABLE_PREFIXES.some((reserved) => matchesPrefix(lower, reserved));
}

/** Declared prefixes, minus anything that can never be proxied. */
function proxyablePrefixes(active: StagedExtensionContributions): string[] {
  const declared = active.manifest.clientSurfaces ?? [];
  return declared
    .map((surface) => surface.pathPrefix)
    .filter((pathPrefix) => (
      pathPrefix.startsWith('/')
      && pathPrefix !== '/'
      && !matchesReserved(pathPrefix)
    ));
}

/** Exported for direct unit coverage — several branches are unreachable via HTTP. */
export function isProxyable(relativePath: string, prefixes: readonly string[]): boolean {
  if (!relativePath.startsWith('/')) return false;
  // LOAD-BEARING, DO NOT REMOVE. Reachable over HTTP: Hono's `getPath`
  // percent-decodes any path containing `%`, so `/client/%2e%2e/x` arrives here
  // with literal `..` segments that no URL parser ever normalized away.
  if (relativePath.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  if (matchesReserved(relativePath)) return false;
  return prefixes.some((pathPrefix) => matchesPrefix(relativePath, pathPrefix));
}

function relativePathFor(c: Context, mountPrefix: string): string {
  return c.req.path.slice(mountPrefix.length) || '/';
}

/**
 * Build the organization-scoped context an extension sees. Every capability
 * axis is pinned to the single session org; nothing here is caller-controlled.
 */
function synthesizeOrgAuthContext(session: {
  clientUserId: string;
  orgId: string;
  email: string;
  /** The directory record may carry no display name; fall back to the email. */
  name: string | null;
}): AuthContext {
  const accessibleOrgIds = [session.orgId];
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures(accessibleOrgIds);

  return {
    user: {
      id: session.clientUserId,
      email: session.email,
      name: session.name ?? session.email,
      // End-user sessions are never platform admins.
      isPlatformAdmin: false,
    },
    token: {
      sub: session.clientUserId,
      email: session.email,
      roleId: null,
      orgId: session.orgId,
      partnerId: null,
      scope: 'organization',
      type: 'access',
      // No interactive MFA happened on this path; MFA-gated routes fail closed.
      mfa: false,
    },
    partnerId: null,
    orgId: session.orgId,
    scope: 'organization',
    accessibleOrgIds,
    // Fails closed at the partner-wide capability gate.
    partnerOrgAccess: null,
    orgCondition,
    canAccessOrg,
  };
}

/**
 * Per-snapshot dispatch wrapper. The prefix fence is re-evaluated here so the
 * extension's own routes cannot be reached by any path the outer check did not
 * already approve, and the auth context is lifted off the ALS seam.
 *
 * LOAD-BEARING, DO NOT REMOVE — these fences are not duplicates of the outer
 * check. The outer check runs on `c.req.path` (decoded, un-normalized) while
 * the forwarded request is rebuilt through `new URL(...).toString()` (WHATWG-
 * normalized, undecoded); this re-fence is the only check that sees the
 * post-normalization path the extension's router will actually match.
 *
 * Exported for direct unit coverage: `dispatch` will not hand these fences a
 * path they reject, so they are tested against the wrapper itself rather than
 * shipped unverified.
 */
export function createClientSurfaceWrapper(
  active: StagedExtensionContributions,
  mountPrefix: string,
  prefixes: readonly string[],
): Hono {
  const deny = (c: Context) => c.json(
    { error: 'not found', code: 'extension_surface_not_found' },
    404,
  );
  const wrapper = new Hono();
  wrapper.use('*', async (c, next) => {
    if (!isProxyable(relativePathFor(c, mountPrefix), prefixes)) return deny(c);
    const auth = proxiedAuth.getStore();
    if (!auth) return deny(c);
    c.set('auth', auth);
    await next();
  });
  active.routeApp?.composeInto(wrapper, mountPrefix);
  wrapper.notFound(deny);
  // Rethrow, exactly as the extension gateway's wrappers do: core's own
  // onError owns the JSON error shape AND the Sentry capture. Without this,
  // Hono's default handler inside the wrapper swallows every extension error —
  // an HTTPException degrades to plain text and an unhandled error becomes a
  // bare 500 that Sentry never sees.
  wrapper.onError((error) => {
    throw error;
  });
  return wrapper;
}

/**
 * Rebuild the request without the end-user credential. The extension is
 * authenticated by the context seam, so it must never receive the bearer token
 * (nor cookies) that would let it act as the user elsewhere.
 */
function stripCallerCredentials(raw: Request): Request {
  const url = new URL(raw.url);
  url.searchParams.delete('token');

  const headers = new Headers(raw.headers);
  for (const header of CALLER_CREDENTIAL_HEADERS) headers.delete(header);

  const init: RequestInit & { duplex?: 'half' } = {
    method: raw.method,
    headers,
    redirect: 'manual',
    signal: raw.signal,
  };
  if (raw.method !== 'GET' && raw.method !== 'HEAD') {
    init.body = raw.body;
    init.duplex = 'half';
  }
  return new Request(url.toString(), init);
}

/**
 * Extension code is downstream of an END-USER browser session on an origin
 * that serves core's own cookies, so it must not be able to set one. Rebuilt
 * (rather than mutated) because a fetch Response's headers are immutable.
 */
function stripResponseCredentials(response: Response): Response {
  const hasStripped = STRIPPED_RESPONSE_HEADERS.some((h) => response.headers.has(h));
  if (!hasStripped) return response;
  const headers = new Headers(response.headers);
  for (const header of STRIPPED_RESPONSE_HEADERS) headers.delete(header);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function executionContext(c: Context): Context['executionCtx'] | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

export function createClientAiExtRoutes(options: ClientAiExtRoutesOptions): Hono {
  const { registry, isEnabled } = options;
  const wrappers = new WeakMap<StagedExtensionContributions, Hono>();

  const notFound = (c: Context) => c.json(
    { error: 'not found', code: 'extension_surface_not_found' },
    404,
  );

  const dispatch: MiddlewareHandler = async (c) => {
    const name = c.req.param('extension');
    if (!name) return notFound(c);

    // Default-deny order: resolve → opt-in → path fence → availability. The
    // fence runs BEFORE the availability check so a disabled extension cannot
    // be probed for which of its paths exist.
    const active = registry.get(name);
    if (!active) return notFound(c);

    const prefixes = proxyablePrefixes(active);
    if (prefixes.length === 0) return notFound(c);

    const mountPrefix = `${CLIENT_AI_EXT_MOUNT_PREFIX}/${name}`;
    if (!isProxyable(relativePathFor(c, mountPrefix), prefixes)) {
      return notFound(c);
    }

    if (!active.enabled || !(await isEnabled(active.name))) {
      return c.json({ error: 'extension unavailable', code: 'extension_disabled' }, 503);
    }

    const session = c.get('clientAiAuth');
    if (!session) {
      return c.json({ error: 'Not authenticated', code: 'session_invalid' }, 401);
    }

    let wrapper = wrappers.get(active);
    if (!wrapper) {
      wrapper = createClientSurfaceWrapper(active, mountPrefix, prefixes);
      wrappers.set(active, wrapper);
    }

    const request = stripCallerCredentials(c.req.raw);
    const response = await withProxiedAuth(
      synthesizeOrgAuthContext(session),
      () => wrapper.fetch(request, c.env, executionContext(c)),
    );
    return stripResponseCredentials(response);
  };

  const routes = new Hono();
  routes.use('*', clientAiAuthMiddleware);
  routes.use('*', requireClientAiEnabledMiddleware);
  routes.all('/:extension', dispatch);
  routes.all('/:extension/*', dispatch);
  routes.notFound(notFound);
  return routes;
}

export const clientAiExtRoutes = createClientAiExtRoutes({
  registry: extensionContributionRegistry,
  isEnabled: async () => true,
});
