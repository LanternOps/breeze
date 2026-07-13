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
import { sql } from 'drizzle-orm';
import type {
  AiToolLike,
  BreezeExtension,
  ExtensionContext,
  ExtensionDatabase,
  ExtensionManifest,
  ExtensionTenancyDeclaration,
} from '@breeze/extension-api';
import { discoverExtensions } from './discovery';
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

// Context variable marking that the loader guard already authenticated this
// request, so the ctx-injected middlewares can no-op instead of running the
// (side-effectful: per-agent/per-IP rate counters) core auth twice when an
// extension also applies them itself.
const LOADER_AUTH_APPLIED = 'extensionLoaderAuthApplied';

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
      c.set(LOADER_AUTH_APPLIED, true);
      return agentAuthMiddleware(c, next);
    }
    if (publicExact.has(rel) || publicPrefixes.some((p) => rel.startsWith(p))) {
      return next();
    }
    c.set(LOADER_AUTH_APPLIED, true);
    return authMiddleware(c, next);
  };
}

/** Wrap a core auth middleware so it no-ops when the loader guard already ran. */
function skipIfLoaderAuthed(inner: MiddlewareHandler): MiddlewareHandler {
  return (c, next) => {
    if (c.get(LOADER_AUTH_APPLIED) === true) return next();
    return inner(c, next);
  };
}

interface RlsCatalogRow {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number | string;
}

/**
 * Boot-time RLS tripwire for extension tables. The core rls-coverage contract
 * test cannot see tables that ship from a private extension repo, so this is
 * the only structural check they get: every table an extension declares in its
 * manifest tenancy arrays must exist with RLS ENABLEd + FORCEd and at least
 * one policy. Throws (failing the boot loudly) otherwise. Exported for tests.
 */
export async function assertExtensionTenancyRls(
  extensionName: string,
  tenancy: ExtensionTenancyDeclaration,
): Promise<void> {
  const tables = [
    ...new Set([
      ...tenancy.orgCascadeDeleteTables,
      ...tenancy.deviceCascadeDeleteTables,
      ...tenancy.deviceOrgDenormalizedTables,
      ...(tenancy.deviceOrgMoveDeleteTables ?? []),
    ]),
  ];
  if (tables.length === 0) return;

  const result = (await db.execute(sql`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           (SELECT count(*)::int FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(${tables})
  `)) as unknown as RlsCatalogRow[] | { rows?: RlsCatalogRow[] };
  const rows: RlsCatalogRow[] = Array.isArray(result) ? result : (result.rows ?? []);
  const byName = new Map(rows.map((r) => [r.table_name, r]));

  const problems: string[] = [];
  for (const table of tables) {
    const row = byName.get(table);
    if (!row) {
      problems.push(`"${table}" is declared in the manifest tenancy but does not exist (did its migration run?)`);
      continue;
    }
    if (!row.rls_enabled) problems.push(`"${table}" does not have ROW LEVEL SECURITY enabled`);
    if (!row.rls_forced) problems.push(`"${table}" does not have ROW LEVEL SECURITY forced (ALTER TABLE ... FORCE ROW LEVEL SECURITY)`);
    if (Number(row.policy_count) === 0) problems.push(`"${table}" has no RLS policies (pg_policies is empty for it)`);
  }
  if (problems.length > 0) {
    throw new Error(
      `[extensions] RLS coverage check failed for extension "${extensionName}" — refusing to boot. `
        + 'Extension tables are invisible to the core rls-coverage contract test, so this boot-time '
        + `assertion is their only tripwire:\n  - ${problems.join('\n  - ')}`,
    );
  }
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
    const ctx: ExtensionContext = {
      mountRoute: (subApp) => {
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
      authMiddleware: skipIfLoaderAuthed(authMiddleware),
      agentAuthMiddleware: skipIfLoaderAuthed(agentAuthMiddleware),
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
    console.log(`[extensions] mounted "${d.name}" at ${mountPrefix}`);
  }
}
