import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';

import { agentAuthMiddleware } from '../middleware/agentAuth';
import { authMiddleware } from '../middleware/auth';
import { helperAuth } from '../middleware/helperAuth';
import { recordExtensionRequest } from './metrics';
import type {
  ExtensionContributionRegistry,
  StagedExtensionContributions,
} from './contributionRegistry';

type LoaderAuthKind = 'user' | 'agent' | 'helper';
const LOADER_AUTH_KIND = 'extensionLoaderAuthKind';

function skipIfLoaderAuthed(
  inner: MiddlewareHandler,
  kind: LoaderAuthKind,
): MiddlewareHandler {
  return (c, next) => {
    if (c.get(LOADER_AUTH_KIND) === kind) return next();
    return inner(c, next);
  };
}

export const legacyExtensionAuthMiddleware = skipIfLoaderAuthed(authMiddleware, 'user');
export const legacyExtensionAgentAuthMiddleware = skipIfLoaderAuthed(agentAuthMiddleware, 'agent');
export const legacyExtensionHelperAuthMiddleware = skipIfLoaderAuthed(helperAuth, 'helper');

/**
 * `helperRoutes` is a legacy-manifest flag the loader carries on the staged
 * manifest for this guard; it is not part of the v1 wire schema yet (see the
 * TODO in packages/extension-sdk/src/manifest.ts).
 */
type GatewayManifest = Pick<ExtensionManifestV1, 'publicRoutes'> & { helperRoutes?: boolean };

/**
 * Default-deny auth selection for an extension namespace.
 *
 * Agent paths always use agent auth, even if a malformed/unvalidated manifest
 * attempts to list one as public. Exact/prefix public declarations are the only
 * paths that may skip user auth; every other path uses user auth.
 */
export function buildExtensionAuthGuard(
  mountPrefix: string,
  manifest: GatewayManifest,
): MiddlewareHandler {
  const publicExact = new Set<string>();
  const publicPrefixes: string[] = [];
  for (const route of manifest.publicRoutes ?? []) {
    if (route.endsWith('/*')) {
      publicPrefixes.push(route.slice(0, -1));
    } else {
      publicExact.add(route);
    }
  }

  return (c, next) => {
    const relativePath = c.req.path.slice(mountPrefix.length) || '/';
    if (relativePath === '/agent' || relativePath.startsWith('/agent/')) {
      if (c.get(LOADER_AUTH_KIND) === 'agent') return next();
      c.set(LOADER_AUTH_KIND, 'agent');
      return agentAuthMiddleware(c, next);
    }
    if (
      manifest.helperRoutes
      && (relativePath === '/helper' || relativePath.startsWith('/helper/'))
    ) {
      // Before the publicRoutes check — helper paths can never be public.
      if (c.get(LOADER_AUTH_KIND) === 'helper') return next();
      c.set(LOADER_AUTH_KIND, 'helper');
      return helperAuth(c, next);
    }
    if (
      publicExact.has(relativePath)
      || publicPrefixes.some((prefix) => relativePath.startsWith(prefix))
    ) {
      return next();
    }
    c.set(LOADER_AUTH_KIND, 'user');
    return authMiddleware(c, next);
  };
}

function createSnapshotWrapper(
  active: StagedExtensionContributions,
  mountPrefix: string,
): Hono {
  const wrapper = new Hono();
  wrapper.use('*', buildExtensionAuthGuard(mountPrefix, active.manifest));
  active.routeApp?.composeInto(wrapper, mountPrefix);
  wrapper.notFound((c) => c.json({ error: 'not found' }, 404));
  wrapper.onError((error) => {
    throw error;
  });
  return wrapper;
}

function createAgentSnapshotWrapper(
  active: StagedExtensionContributions,
  mountPrefix: string,
  isEnabled: (name: string) => Promise<boolean>,
): Hono {
  const wrapper = new Hono();
  const authGuard = buildExtensionAuthGuard(mountPrefix, active.manifest);

  // agentAuthMiddleware reads c.req.param('id'). A plain '*' middleware only
  // sees the wildcard's own params, not downstream route params, so match the
  // agent-id segment explicitly before the catch-all default-deny guard.
  wrapper.use(`${mountPrefix}/agent/:id`, authGuard);
  wrapper.use(`${mountPrefix}/agent/:id/*`, authGuard);
  wrapper.use('*', authGuard);
  wrapper.use('*', async (c, next) => {
    // Agent prefixes may be exempt from the global limiter, so availability
    // must be checked only after agent auth (and its own rate limits) runs.
    if (!active.enabled || !(await isEnabled(active.name))) {
      return c.json({ error: 'extension unavailable' }, 503);
    }
    await next();
  });
  active.routeApp?.composeInto(wrapper, mountPrefix);
  wrapper.notFound((c) => c.json({ error: 'not found' }, 404));
  wrapper.onError((error) => {
    throw error;
  });
  return wrapper;
}

function executionContext(c: Context): Context['executionCtx'] | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * Dispatch into a snapshot's Hono wrapper while recording bounded request
 * metrics (extension + route + status/duration). A wrapper throw (an extension
 * route that re-raised past its onError) is still counted — as a 500 — and then
 * re-thrown UNCHANGED so the outer app's error handler and fault attribution
 * behave exactly as before.
 */
async function dispatchMeasured(
  wrapperApp: Hono,
  extension: string,
  route: string,
  c: Context,
): Promise<Response> {
  const startedAt = performance.now();
  try {
    const response = await wrapperApp.fetch(c.req.raw, c.env, executionContext(c));
    recordExtensionRequest(extension, route, response.status, (performance.now() - startedAt) / 1000);
    return response;
  } catch (error) {
    recordExtensionRequest(extension, route, 500, (performance.now() - startedAt) / 1000);
    throw error;
  }
}

export function mountExtensionGateway(
  app: Hono,
  registry: ExtensionContributionRegistry,
  isEnabled: (name: string) => Promise<boolean>,
): void {
  const wrappers = new WeakMap<StagedExtensionContributions, Map<string, Hono>>();
  const agentWrappers = new WeakMap<StagedExtensionContributions, Map<string, Hono>>();

  const dispatchSnapshot = async (
    c: Context,
    active: StagedExtensionContributions,
    mountPrefix: string,
  ): Promise<Response> => {
    const relativePath = c.req.path.slice(mountPrefix.length) || '/';
    if (relativePath === '/agent' || relativePath.startsWith('/agent/')) {
      let byPrefix = agentWrappers.get(active);
      if (!byPrefix) {
        byPrefix = new Map();
        agentWrappers.set(active, byPrefix);
      }
      let agentWrapper = byPrefix.get(mountPrefix);
      if (!agentWrapper) {
        agentWrapper = createAgentSnapshotWrapper(active, mountPrefix, isEnabled);
        byPrefix.set(mountPrefix, agentWrapper);
      }
      return dispatchMeasured(agentWrapper, active.name, relativePath, c);
    }

    if (!active.enabled || !(await isEnabled(active.name))) {
      return c.json({ error: 'extension unavailable' }, 503);
    }

    let byPrefix = wrappers.get(active);
    if (!byPrefix) {
      byPrefix = new Map();
      wrappers.set(active, byPrefix);
    }
    let wrapper = byPrefix.get(mountPrefix);
    if (!wrapper) {
      wrapper = createSnapshotWrapper(active, mountPrefix);
      byPrefix.set(mountPrefix, wrapper);
    }

    return dispatchMeasured(wrapper, active.name, relativePath, c);
  };

  const dispatchCanonical = async (c: Context): Promise<Response> => {
    const name = c.req.param('extension');
    if (!name) return c.json({ error: 'extension unavailable' }, 503);
    const active = registry.get(name);
    if (!active) return c.json({ error: 'extension unavailable' }, 503);
    return dispatchSnapshot(c, active, `/api/v1/ext/${name}`);
  };

  const dispatchAlias: MiddlewareHandler = async (c, next) => {
    const routeNamespace = c.req.param('routeNamespace');
    const active = routeNamespace
      ? registry.getByRouteNamespace(routeNamespace)
      : undefined;
    if (!active) {
      await next();
      return c.res;
    }
    return dispatchSnapshot(c, active, `/api/v1/${routeNamespace}`);
  };

  app.all('/api/v1/ext/:extension', dispatchCanonical);
  app.all('/api/v1/ext/:extension/*', dispatchCanonical);
  app.all('/api/v1/:routeNamespace', dispatchAlias);
  app.all('/api/v1/:routeNamespace/*', dispatchAlias);
}
