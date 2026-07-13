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
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import {
  SHARED_TABLE_ALLOWLIST,
  TENANT_SCOPE_COLUMNS,
  type AiToolLike,
  type BreezeExtension,
  type ExtensionContext,
  type ExtensionDatabase,
  type ExtensionManifest,
  type ExtensionTenancyDeclaration,
} from '@breeze/extension-api';
import { discoverExtensions } from './discovery';
import * as coreSchema from '../db/schema';
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

interface RlsCatalogRow {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number | string;
  tenant_column_count: number | string;
}

/**
 * Every table name in the core Drizzle schema.
 *
 * Needed because extension table OWNERSHIP is inferred from the `<name>_`
 * prefix, and nothing stops an extension being named `device`, `alert`, `agent`
 * or `backup` — all of which are live core table prefixes (`device_commands`,
 * `alert_rules`, `agent_logs`, `backup_verifications`, ...). Without this
 * subtraction, such an extension would see dozens of CORE tables as its own
 * undeclared tables and brick the boot over a violation it did not commit.
 *
 * A tripwire that fails for reasons the operator cannot act on is worse than no
 * tripwire at all: the natural response is `BREEZE_EXTENSIONS_ENABLED=false`,
 * which switches off *every* extension tripwire including this one.
 */
let coreTableNamesCache: ReadonlySet<string> | null = null;
function coreTableNames(): ReadonlySet<string> {
  if (coreTableNamesCache === null) {
    // Widened to `unknown` before narrowing: the schema barrel's export union
    // (500+ tables, enums, and plain helper functions) is far too specific for
    // tsc to accept a `v is PgTable` predicate against it directly.
    coreTableNamesCache = new Set(
      (Object.values(coreSchema) as unknown[])
        .filter((v): v is PgTable => is(v, PgTable))
        .map((t) => getTableName(t)),
    );
  }
  return coreTableNamesCache;
}

/**
 * Boot-time tenancy tripwire for extension tables. The core rls-coverage
 * contract test cannot see tables that ship from a private extension repo, so
 * this is the only structural check they get. It enforces two directions:
 *
 *  1. **Declared → compliant.** Every table in the manifest tenancy arrays must
 *     exist with RLS ENABLEd + FORCEd and at least one policy.
 *  2. **Existing → declared** (#2466). Every `<name>_`-prefixed table that
 *     actually exists in the catalog must appear SOMEWHERE in the manifest —
 *     either in a tenancy array (and then rule 1 applies to it) or in the
 *     explicit `nonTenantTables` opt-out. Direction 1 alone let the policed
 *     party write its own policy: an extension whose migration created
 *     `<name>_docs(org_id …)` and whose manifest simply omitted it got no check
 *     at all, and shipped with no RLS.
 *
 * The `nonTenantTables` opt-out is verified, not trusted: a table listed there
 * that actually carries a tenant column (org_id/partner_id/device_id) fails the
 * boot, so it cannot be used to smuggle a tenant table past rule 1.
 *
 * Throws (failing the boot loudly) on any violation. Exported for tests.
 */
export async function assertExtensionTenancyRls(
  extensionName: string,
  tenancy: ExtensionTenancyDeclaration,
): Promise<void> {
  const tenantTables = [
    ...new Set([
      ...tenancy.orgCascadeDeleteTables,
      ...tenancy.deviceCascadeDeleteTables,
      ...tenancy.deviceOrgDenormalizedTables,
      ...(tenancy.deviceOrgMoveDeleteTables ?? []),
    ]),
  ];
  const nonTenantTables = [...new Set(tenancy.nonTenantTables ?? [])];
  const declared = new Set([...tenantTables, ...nonTenantTables]);
  const ownershipPrefix = `${extensionName}_`;

  // NOTE: there is deliberately no early return for "declares nothing". An
  // extension that declares zero tables is exactly the case #2466 exists to
  // catch — the catalog scan below is what proves it also CREATED nothing.

  // Bind every table name as an individually-parameterised text literal inside
  // an explicit ARRAY[...]::text[]. Embedding the JS array directly
  // (`= ANY(${names})`) makes drizzle expand it to a TUPLE — `= ANY(($1, $2))` —
  // which Postgres rejects with 42809. An empty list yields `ARRAY[]::text[]`,
  // which is valid and simply matches nothing. `relname` is `name`, not `text`,
  // so it needs the cast to compare.
  const declaredArray = sql`ARRAY[${sql.join([...declared].map((t) => sql`${t}`), sql`, `)}]::text[]`;
  const tenantColumnArray = sql`ARRAY[${sql.join(TENANT_SCOPE_COLUMNS.map((c) => sql`${c}`), sql`, `)}]::text[]`;

  // One round-trip covering BOTH directions: every table this extension owns by
  // prefix, UNION every table it declared (a declared table that doesn't exist
  // must still be reported, and it may not match the prefix — memory_blocks).
  const result = (await db.execute(sql`
    SELECT c.relname::text AS table_name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           (SELECT count(*)::int FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count,
           (SELECT count(*)::int FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
               AND a.attname::text = ANY(${tenantColumnArray})) AS tenant_column_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    -- 'r' = ordinary table, 'p' = partitioned table. Omitting 'p' would report
    -- a partitioned extension table as "does not exist" and send the operator
    -- chasing a migration bug that isn't there.
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      -- Partition CHILDREN inherit their parent's RLS and are not independently
      -- declarable. Counting them would demand the extension declare
      -- <name>_events_2026_01 and every future partition -- a boot failure on
      -- the calendar. (No backticks in this template: they would terminate it.)
      AND NOT c.relispartition
      AND (
        starts_with(c.relname::text, ${ownershipPrefix})
        OR c.relname::text = ANY(${declaredArray})
      )
  `)) as unknown as RlsCatalogRow[] | { rows?: RlsCatalogRow[] } | undefined;
  const rows: RlsCatalogRow[] = Array.isArray(result) ? result : (result?.rows ?? []);
  const byName = new Map(rows.map((r) => [r.table_name, r]));

  const problems: string[] = [];

  // Direction 1 — every DECLARED tenant table must exist and be RLS-compliant.
  for (const table of tenantTables) {
    const row = byName.get(table);
    if (!row) {
      problems.push(`"${table}" is declared in the manifest tenancy but does not exist (did its migration run?)`);
      continue;
    }
    if (!row.rls_enabled) problems.push(`"${table}" does not have ROW LEVEL SECURITY enabled`);
    if (!row.rls_forced) problems.push(`"${table}" does not have ROW LEVEL SECURITY forced (ALTER TABLE ... FORCE ROW LEVEL SECURITY)`);
    // Phrased as `!(n > 0)` rather than `=== 0` so a NaN/null/undefined
    // policy_count (unexpected row shape, driver change) fails CLOSED like its
    // two siblings. `Number(undefined) === 0` is false — which would have let a
    // policy-less table pass silently, in the one function whose whole contract
    // is to fail loudly.
    if (!(Number(row.policy_count) > 0)) problems.push(`"${table}" has no RLS policies (pg_policies is empty for it)`);
  }

  // The opt-out is VERIFIED, not trusted. Without this, `nonTenantTables` would
  // be a hole exactly as wide as the one #2466 closes: an extension could dodge
  // the RLS assertion on a real tenant table just by calling it global.
  for (const table of nonTenantTables) {
    const row = byName.get(table);
    if (!row) {
      problems.push(`"${table}" is declared in tenancy.nonTenantTables but does not exist (did its migration run?)`);
      continue;
    }
    if (Number(row.tenant_column_count) > 0) {
      problems.push(
        `"${table}" is declared in tenancy.nonTenantTables but carries a tenant column `
          + `(one of ${TENANT_SCOPE_COLUMNS.join('/')}) — it IS tenant-scoped. Move it to the correct `
          + 'tenancy array and give it RLS; the opt-out is only for genuinely global tables.',
      );
    }
  }

  // Direction 2 (#2466) — every table this extension OWNS must be declared.
  const core = coreTableNames();
  for (const row of rows) {
    const table = row.table_name;
    if (!table.startsWith(ownershipPrefix)) continue; // only reached via `declared`
    if (declared.has(table)) continue;
    // A shared table belongs to core, not to whichever extension happens to
    // prefix-match it (an extension named `memory` would otherwise "own"
    // memory_blocks).
    if (SHARED_TABLE_ALLOWLIST.has(table)) continue;
    if (core.has(table)) continue; // core owns it — see coreTableNames()
    problems.push(
      Number(row.tenant_column_count) > 0
        ? `"${table}" exists and carries a tenant column (one of ${TENANT_SCOPE_COLUMNS.join('/')}) but is `
          + 'declared in NO manifest tenancy array — it ships with zero RLS verification AND no cascade / '
          + 'org-move handling. Add it to the correct tenancy array.'
        : `"${table}" exists but is declared nowhere in the manifest. If it is genuinely global (no tenant `
          + 'scope), list it in tenancy.nonTenantTables so that is a deliberate, reviewable choice.',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `[extensions] tenancy check failed for extension "${extensionName}" — refusing to boot. `
        + 'Extension tables are invisible to the core rls-coverage contract test, so this boot-time '
        + `assertion is their only tripwire:\n  - ${problems.join('\n  - ')}\n`
        + 'Fix the manifest or the migration. Do NOT set BREEZE_EXTENSIONS_ENABLED=false to get past '
        + 'this — that disables every extension tripwire and ships the very gap this check found.',
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
}
