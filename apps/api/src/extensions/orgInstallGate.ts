import type { Context, MiddlewareHandler } from 'hono';
import {
  createExtensionOrgInstallStore,
  type ExtensionOrgInstallStore,
} from './orgInstallStore';

/**
 * L1 install-scoping gate (authorization, not containment).
 *
 * Registered inside every extension dispatch wrapper AFTER that wrapper's auth
 * guard — both gateway entry points (`/api/v1/ext/:extension/*` and the legacy
 * `/api/v1/:routeNamespace/*` alias) funnel through the wrappers, so the alias
 * is covered by construction, and the client-ai surface wrapper registers the
 * same guard. On the agent path it additionally runs after the post-auth
 * availability middleware, mirroring the existing gateway.ts ordering comment.
 *
 * Deny is 404 — matching each surface's own not-found shape — so a
 * non-installed org cannot distinguish "not installed for you" from "does not
 * exist" (the codebase's default-deny convention).
 */
export type OrgInstalledReader = (extension: string, orgId: string) => Promise<boolean>;

export function installScopeOf(
  manifest: { tenancy?: { installScope?: 'server' | 'org' } },
): 'server' | 'org' {
  return manifest.tenancy?.installScope ?? 'server';
}

/**
 * The single authenticated org this request acts for. Agent identity wins
 * (device org is the ground truth on agent paths); helper and client-ai both
 * synthesize an org-scoped `auth`; user tokens carry `auth.orgId`.
 *
 * `null` — an unauthenticated public route, or a partner/system-scope user
 * token with no single org — FAILS CLOSED on an org-scoped extension: no org,
 * no install row, 404.
 */
export function resolveCallerOrgId(c: Context): string | null {
  const agent = c.get('agent') as { orgId?: string } | undefined;
  if (agent?.orgId) return agent.orgId;
  const auth = c.get('auth') as { orgId?: string | null } | undefined;
  if (auth?.orgId) return auth.orgId;
  return null;
}

export function buildOrgInstallGuard(options: {
  extension: string;
  installScope: 'server' | 'org';
  isInstalled: OrgInstalledReader;
  deny?: (c: Context) => Response;
}): MiddlewareHandler {
  const deny = options.deny ?? ((c: Context) => c.json({ error: 'not found' }, 404));
  if (options.installScope !== 'org') {
    return (_c, next) => next();
  }
  return async (c, next) => {
    const orgId = resolveCallerOrgId(c);
    if (!orgId) return deny(c);
    // Reader errors PROPAGATE to the app's onError (500): an unreadable
    // install set must be an error, never a silent allow or a silent 404.
    if (!(await options.isInstalled(options.extension, orgId))) return deny(c);
    await next();
  };
}

/** Production reader; per-request uncached read, same philosophy as enabledGate. */
export function createOrgInstalledReader(
  store: Pick<ExtensionOrgInstallStore, 'isInstalled'> = createExtensionOrgInstallStore(),
): OrgInstalledReader {
  return (extension, orgId) => store.isInstalled(extension, orgId);
}
