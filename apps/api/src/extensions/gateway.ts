import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';

import { agentAuthMiddleware } from '../middleware/agentAuth';
import { authMiddleware } from '../middleware/auth';
import type {
  ExtensionContributionRegistry,
  StagedExtensionContributions,
} from './contributionRegistry';

type LoaderAuthKind = 'user' | 'agent';
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

/**
 * Default-deny auth selection for an extension namespace.
 *
 * Agent paths always use agent auth, even if a malformed/unvalidated manifest
 * attempts to list one as public. Exact/prefix public declarations are the only
 * paths that may skip user auth; every other path uses user auth.
 */
export function buildExtensionAuthGuard(
  mountPrefix: string,
  manifest: Pick<ExtensionManifestV1, 'publicRoutes'>,
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
      publicExact.has(relativePath)
      || publicPrefixes.some((prefix) => relativePath.startsWith(prefix))
    ) {
      return next();
    }
    c.set(LOADER_AUTH_KIND, 'user');
    return authMiddleware(c, next);
  };
}

function createSnapshotWrapper(active: StagedExtensionContributions): Hono {
  const mountPrefix = `/api/v1/ext/${active.name}`;
  const wrapper = new Hono();
  wrapper.use('*', buildExtensionAuthGuard(mountPrefix, active.manifest));
  if (active.routeApp) wrapper.route(mountPrefix, active.routeApp);
  wrapper.notFound((c) => c.json({ error: 'not found' }, 404));
  wrapper.onError((error) => {
    throw error;
  });
  return wrapper;
}

function createAgentSnapshotWrapper(
  active: StagedExtensionContributions,
  isEnabled: (name: string) => Promise<boolean>,
): Hono {
  const mountPrefix = `/api/v1/ext/${active.name}`;
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
  if (active.routeApp) wrapper.route(mountPrefix, active.routeApp);
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

export function mountExtensionGateway(
  app: Hono,
  registry: ExtensionContributionRegistry,
  isEnabled: (name: string) => Promise<boolean>,
): void {
  const wrappers = new WeakMap<StagedExtensionContributions, Hono>();
  const agentWrappers = new WeakMap<StagedExtensionContributions, Hono>();

  const dispatch = async (c: Context): Promise<Response> => {
    const name = c.req.param('extension');
    if (!name) return c.json({ error: 'extension unavailable' }, 503);
    const active = registry.get(name);
    if (!active) {
      return c.json({ error: 'extension unavailable' }, 503);
    }

    const mountPrefix = `/api/v1/ext/${name}`;
    const relativePath = c.req.path.slice(mountPrefix.length) || '/';
    if (relativePath === '/agent' || relativePath.startsWith('/agent/')) {
      let agentWrapper = agentWrappers.get(active);
      if (!agentWrapper) {
        agentWrapper = createAgentSnapshotWrapper(active, isEnabled);
        agentWrappers.set(active, agentWrapper);
      }
      return agentWrapper.fetch(c.req.raw, c.env, executionContext(c));
    }

    if (!active.enabled || !(await isEnabled(name))) {
      return c.json({ error: 'extension unavailable' }, 503);
    }

    let wrapper = wrappers.get(active);
    if (!wrapper) {
      wrapper = createSnapshotWrapper(active);
      wrappers.set(active, wrapper);
    }

    return wrapper.fetch(c.req.raw, c.env, executionContext(c));
  };

  app.all('/api/v1/ext/:extension', dispatch);
  app.all('/api/v1/ext/:extension/*', dispatch);
}
