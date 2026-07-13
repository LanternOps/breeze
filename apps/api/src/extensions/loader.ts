//
// Extension sub-apps mount on the outer app. Middleware added to the `api`
// instance via api.use('*') does not apply to them, so the loader itself
// default-denies every mounted extension route: `/agent/*` paths get
// agentAuthMiddleware, everything else gets authMiddleware, and only
// manifest-declared `publicRoutes` sub-paths skip auth. The global rate-limit
// exemption for `/agent/` is granted only for prefixes the loader actually
// wrapped — manifest trust alone never lifts the limiter. Core injects the
// ALS-bound database, column-bound secrets, and async audit capability.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type {
  AiToolLike,
  BreezeExtension,
  ExtensionContext,
  ExtensionDatabase,
  ExtensionManifest,
} from '@breeze/extension-api';
import { discoverExtensions } from './discovery';
import { assertExtensionTenancyRls, assertNoUnaccountedPublicTables } from './tenancyTripwire';
import { aiTools } from '../services/aiTools';
import { authMiddleware } from '../middleware/auth';
import { agentAuthMiddleware } from '../middleware/agentAuth';
import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';
import { decryptForColumn, encryptSecret } from '../services/secretCrypto';
import { registerGlobalRateLimitSkipPrefix } from '../middleware/globalRateLimit';

async function loadEntry(dir: string, entry: string): Promise<BreezeExtension> {
  const manifestEntry = path.join(dir, entry);
  const prodEntry = path.join(dir, 'dist', 'index.cjs');
  const target = process.env.NODE_ENV === 'production'
    ? (existsSync(prodEntry) ? prodEntry : manifestEntry)
    : (existsSync(manifestEntry) ? manifestEntry : prodEntry);
  const mod = await import(pathToFileURL(target).href);
  const ext = [mod.default?.default, mod.default?.extension, mod.default, mod.extension]
    .find((candidate): candidate is BreezeExtension => typeof candidate?.register === 'function');
  if (!ext || typeof ext.register !== 'function') {
    throw new Error(`[extensions] ${target} must default-export a BreezeExtension ({ register })`);
  }
  return ext;
}

// Records WHICH core auth the loader guard already ran for this request, so a
// ctx-injected middleware can no-op instead of running the (side-effectful:
// per-agent/per-IP rate counters) core auth twice when an extension redundantly
// applies the SAME one itself.
//
// This stores the KIND, not a boolean, and that distinction is load-bearing.
// `authMiddleware` and `agentAuthMiddleware` are not interchangeable — they
// accept disjoint credentials and set disjoint context vars (auth+permissions
// vs agent). With a boolean, an extension applying `ctx.agentAuthMiddleware` to
// a route NOT under /agent/ would have it silently evaporate after the loader
// ran USER auth: the route would fall back to "any authenticated user token"
// with `c.get('agent')` undefined, downgrading a device-bound ingest route into
// a cross-tenant primitive. So a MISMATCHED kind must still run — the request
// then needs both and 401s (fail closed) — and is never silently skipped.
type LoaderAuthKind = 'user' | 'agent';
const LOADER_AUTH_KIND = 'extensionLoaderAuthKind';

/**
 * Default-deny auth guard for one extension namespace. Evaluated per request
 * against the sub-path relative to /api/v1/<routeNamespace>:
 *   1. `/agent` and `/agent/*` → core agentAuthMiddleware (manifest cannot
 *      opt these public — enforced by the manifest schema too).
 *   2. manifest.publicRoutes exact/wildcard match → no core auth.
 *   3. everything else → core authMiddleware.
 * Exported for tests.
 */
export function buildExtensionAuthGuard(
  mountPrefix: string,
  manifest: ExtensionManifest,
): MiddlewareHandler {
  const publicExact = new Set<string>();
  const publicPrefixes: string[] = [];
  for (const route of manifest.publicRoutes ?? []) {
    if (route.endsWith('/*')) {
      publicPrefixes.push(route.slice(0, -1)); // keep the trailing '/'
    } else {
      publicExact.add(route);
    }
  }
  return async (c, next) => {
    const rel = c.req.path.slice(mountPrefix.length) || '/';
    if (rel === '/agent' || rel.startsWith('/agent/')) {
      c.set(LOADER_AUTH_KIND, 'agent');
      return agentAuthMiddleware(c, next);
    }
    if (publicExact.has(rel) || publicPrefixes.some((p) => rel.startsWith(p))) {
      return next();
    }
    c.set(LOADER_AUTH_KIND, 'user');
    return authMiddleware(c, next);
  };
}

/**
 * Wrap a core auth middleware so it no-ops ONLY when the loader guard already
 * ran the SAME kind of auth for this request. A mismatched kind still runs —
 * skipping it would silently strip the guarantee the extension asked for.
 */
function skipIfLoaderAuthed(inner: MiddlewareHandler, kind: LoaderAuthKind): MiddlewareHandler {
  return (c, next) => {
    if (c.get(LOADER_AUTH_KIND) === kind) return next();
    return inner(c, next);
  };
}

export async function mountExtensions(app: Hono, root?: string): Promise<void> {
  if (process.env.BREEZE_EXTENSIONS_ENABLED === 'false') {
    console.log('[extensions] disabled via BREEZE_EXTENSIONS_ENABLED=false');
    return;
  }
  const discovered = discoverExtensions(root);
  if (discovered.length === 0) return;

  for (const d of discovered) {
    const ext = await loadEntry(d.dir, d.manifest.entry);
    await assertExtensionTenancyRls(d.name, d.manifest.tenancy);
    const mountPrefix = `/api/v1/${d.manifest.routeNamespace}`;
    let mounted = false;
    const ctx: ExtensionContext = {
      mountRoute: (subApp) => {
        // Each mountRoute call registers its own `use('*', guard)` at the same
        // prefix, and Hono runs EVERY matching wildcard — so a second call would
        // run core auth twice per request (double-incrementing the per-agent /
        // per-IP rate counters, so agents 429 at half the intended rate) while
        // silently shadowing the first sub-app for any overlapping route. Both
        // are exactly the quiet misconfiguration these tripwires exist to kill.
        if (mounted) {
          throw new Error(
            `[extensions] "${d.name}" called ctx.mountRoute more than once — `
              + `a second sub-app at ${mountPrefix} would double-run core auth and `
              + 'shadow the first. Compose your routes into a single Hono app before mounting.',
          );
        }
        mounted = true;
        const guarded = new Hono();
        guarded.use('*', buildExtensionAuthGuard(mountPrefix, d.manifest));
        guarded.route('/', subApp);
        app.route(mountPrefix, guarded);
        // Rate-limit exemption only for a prefix the loader just wrapped with
        // agentAuthMiddleware — never on manifest trust alone.
        if (d.manifest.agentRoutes === true) {
          registerGlobalRateLimitSkipPrefix(`${mountPrefix}/agent/`);
        }
      },
      authMiddleware: skipIfLoaderAuthed(authMiddleware, 'user'),
      agentAuthMiddleware: skipIfLoaderAuthed(agentAuthMiddleware, 'agent'),
      db: db as unknown as ExtensionDatabase,
      secrets: {
        encryptForColumn: (table, column, plaintext) =>
          encryptSecret(plaintext, { aad: `${table}.${column}` }) ?? '',
        decryptForColumn: (table, column, ciphertext) =>
          decryptForColumn(table, column, ciphertext) ?? '',
      },
      audit: (event) => createAuditLogAsync({
        ...event,
        initiatedBy: event.actorType === 'agent' ? 'agent' : 'manual',
      }),
      aiTools: new Proxy(aiTools as Map<string, AiToolLike>, {
        get(target, prop, receiver) {
          if (prop === 'set') {
            return (key: string, value: AiToolLike) => {
              if (target.has(key)) {
                throw new Error(`[extensions] AI tool "${key}" already registered (extension "${d.name}")`);
              }
              return target.set(key, value);
            };
          }
          const v = Reflect.get(target, prop, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
      log: (message) => console.log(`[extensions:${d.name}] ${message}`),
    };
    await ext.register(ctx);
    // Don't claim a mount that never happened — an extension can register AI
    // tools / audit hooks without calling mountRoute, and a confident
    // "mounted at /api/v1/x" line for a namespace serving nothing has sent
    // people hunting phantom routing bugs.
    console.log(
      mounted
        ? `[extensions] mounted "${d.name}" at ${mountPrefix}`
        : `[extensions] registered "${d.name}" (no routes mounted — ctx.mountRoute was never called)`,
    );
  }

  // Runs once, AFTER every extension is accounted for: catches an extension
  // table that dodged its own prefix scan by simply not using the prefix.
  await assertNoUnaccountedPublicTables(discovered.map((d) => d.manifest.tenancy));
}
