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
 * It is deliberately default-deny at every step:
 *   401  no/invalid/expired session                (clientAiAuthMiddleware)
 *   403  org policy disabled, re-checked PER REQUEST (requireClientAiEnabled…)
 *   404  unknown extension · no `clientSurfaces` declaration · path outside
 *        every declared prefix
 *   503  extension disabled (snapshot or deployment)
 *   else the downstream response, passed through unchanged.
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
 *  - The inbound `Authorization`/`Cookie` headers and any `?token=` query
 *    parameter are stripped before forwarding, so the end-user session
 *    credential is never handed to extension code.
 *  - Path fencing is applied to the resolved (normalized) request path, and
 *    re-applied inside the wrapper, so `/agent`, `/helper` and any admin path
 *    stay unreachable no matter how the caller crafts the URL.
 */

/** Absolute mount point; the wrapper needs it to compute relative paths. */
export const CLIENT_AI_EXT_MOUNT_PREFIX = '/api/v1/client-ai/ext';

/**
 * Namespaces that carry their own machine identities. Never reachable with an
 * end-user context, even if a (malformed or unvalidated) manifest lists one —
 * the manifest schema also refuses them, this is the runtime backstop.
 */
const NEVER_PROXYABLE_PREFIXES = ['/agent', '/helper'] as const;

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

function matchesPrefix(relativePath: string, pathPrefix: string): boolean {
  return relativePath === pathPrefix || relativePath.startsWith(`${pathPrefix}/`);
}

/** Declared prefixes, minus anything that can never be proxied. */
function proxyablePrefixes(active: StagedExtensionContributions): string[] {
  const declared = active.manifest.clientSurfaces ?? [];
  return declared
    .map((surface) => surface.pathPrefix)
    .filter((pathPrefix) => (
      pathPrefix.startsWith('/')
      && pathPrefix !== '/'
      && !NEVER_PROXYABLE_PREFIXES.some((reserved) => matchesPrefix(pathPrefix, reserved))
    ));
}

function isProxyable(relativePath: string, prefixes: readonly string[]): boolean {
  if (!relativePath.startsWith('/')) return false;
  if (relativePath.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  if (NEVER_PROXYABLE_PREFIXES.some((reserved) => matchesPrefix(relativePath, reserved))) return false;
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
 */
function createClientSurfaceWrapper(
  active: StagedExtensionContributions,
  mountPrefix: string,
  prefixes: readonly string[],
): Hono {
  const wrapper = new Hono();
  wrapper.use('*', async (c, next) => {
    if (!isProxyable(relativePathFor(c, mountPrefix), prefixes)) {
      return c.json({ error: 'not found' }, 404);
    }
    const auth = proxiedAuth.getStore();
    if (!auth) return c.json({ error: 'not found' }, 404);
    c.set('auth', auth);
    await next();
  });
  active.routeApp?.composeInto(wrapper, mountPrefix);
  wrapper.notFound((c) => c.json({ error: 'not found' }, 404));
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
  headers.delete('authorization');
  headers.delete('cookie');

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

  const dispatch: MiddlewareHandler = async (c) => {
    const name = c.req.param('extension');
    if (!name) return c.json({ error: 'not found' }, 404);

    // Default-deny order: resolve → opt-in → path fence → availability. The
    // fence runs BEFORE the availability check so a disabled extension cannot
    // be probed for which of its paths exist.
    const active = registry.get(name);
    if (!active) return c.json({ error: 'not found' }, 404);

    const prefixes = proxyablePrefixes(active);
    if (prefixes.length === 0) return c.json({ error: 'not found' }, 404);

    const mountPrefix = `${CLIENT_AI_EXT_MOUNT_PREFIX}/${name}`;
    if (!isProxyable(relativePathFor(c, mountPrefix), prefixes)) {
      return c.json({ error: 'not found' }, 404);
    }

    if (!active.enabled || !(await isEnabled(active.name))) {
      return c.json({ error: 'extension unavailable' }, 503);
    }

    const session = c.get('clientAiAuth');
    if (!session) return c.json({ error: 'Not authenticated' }, 401);

    let wrapper = wrappers.get(active);
    if (!wrapper) {
      wrapper = createClientSurfaceWrapper(active, mountPrefix, prefixes);
      wrappers.set(active, wrapper);
    }

    const request = stripCallerCredentials(c.req.raw);
    return proxiedAuth.run(
      synthesizeOrgAuthContext(session),
      () => wrapper.fetch(request, c.env, executionContext(c)),
    );
  };

  const routes = new Hono();
  routes.use('*', clientAiAuthMiddleware);
  routes.use('*', requireClientAiEnabledMiddleware);
  routes.all('/:extension', dispatch);
  routes.all('/:extension/*', dispatch);
  routes.notFound((c) => c.json({ error: 'not found' }, 404));
  return routes;
}

export const clientAiExtRoutes = createClientAiExtRoutes({
  registry: extensionContributionRegistry,
  isEnabled: async () => true,
});
