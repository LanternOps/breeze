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
  relkind: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number | string;
  tenant_column_count: number | string;
  tenant_fk_count: number | string;
}

/**
 * Core tenant entities. A table holding a FOREIGN KEY into any of these is
 * tenant-scoped as a matter of fact, regardless of what it names the column —
 * which is what makes this, not TENANT_SCOPE_COLUMNS, the load-bearing half of
 * the nonTenantTables verification. `organization_id`, `tenant_id`,
 * `customer_id`, `owner_org` all dodge a name match; none of them dodge the FK.
 */
const CORE_TENANT_FK_TABLES: readonly string[] = [
  'organizations',
  'partners',
  'sites',
  'devices',
  'device_groups',
  'users',
];

/**
 * Relkinds that can hold rows but CANNOT be protected by RLS. Postgres has no
 * RLS on materialized views or foreign tables at all, so an extension-owned one
 * is an unfixable tenant-isolation bypass: `CREATE MATERIALIZED VIEW demo_all AS
 * SELECT * FROM demo_docs` physically copies every tenant's rows into a relation
 * no policy can touch. These are rejected outright rather than merely scanned.
 */
const RLS_INCAPABLE_RELKINDS: Record<string, string> = {
  m: 'materialized view',
  f: 'foreign table',
};

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
/**
 * Core `public` tables that exist in the database but have NO Drizzle model, so
 * `Object.values(coreSchema)` cannot see them.
 *
 * Every entry here is a table an extension could otherwise be blamed for:
 * `backup_profiles` bricks an extension named `backup`, `s1_site_mappings` (which
 * carries `org_id NOT NULL`, so it trips the scariest "carries a tenant column"
 * branch) bricks one named `s1`, `td_synnex_*` bricks `td`, and
 * `breeze_migrations` bricks `breeze` — all legal names under NAME_RE.
 *
 * This list WILL drift as core adds migration-only tables, and a silent drift
 * here is a production boot-brick with no operator remedy. So it is not
 * hand-maintained on trust: `extensionTenancyRls.integration.test.ts` asserts
 * against the live catalog that the barrel plus this list covers every core
 * `public` table, and reds on the PR that introduces the next one.
 */
const CORE_NON_DRIZZLE_TABLES: ReadonlySet<string> = new Set([
  'backup_profiles',
  'breeze_migrations',
  's1_site_mappings',
  'td_synnex_price_availability',
  'td_synnex_sftp_integrations',
]);

/** Exported for the contract test that keeps CORE_NON_DRIZZLE_TABLES honest. */
export function coreTableNames(): ReadonlySet<string> {
  if (coreTableNamesCache === null) {
    // Widened to `unknown` before narrowing: the schema barrel's export union
    // (500+ tables, enums, and plain helper functions) is far too specific for
    // tsc to accept a `v is PgTable` predicate against it directly.
    const fromBarrel = (Object.values(coreSchema) as unknown[])
      .filter((v): v is PgTable => is(v, PgTable))
      .map((t) => getTableName(t));
    coreTableNamesCache = new Set([...fromBarrel, ...CORE_NON_DRIZZLE_TABLES]);
  }
  return coreTableNamesCache;
}
let coreTableNamesCache: ReadonlySet<string> | null = null;

const tenantColumnArray = sql`ARRAY[${sql.join(TENANT_SCOPE_COLUMNS.map((c) => sql`${c}`), sql`, `)}]::text[]`;
const tenantFkArray = sql`ARRAY[${sql.join(CORE_TENANT_FK_TABLES.map((t) => sql`${t}`), sql`, `)}]::text[]`;

/** Shared SELECT list — every fact the tenancy verdicts need about one relation. */
const extensionCatalogColumns = sql`
  c.relname::text AS table_name,
  c.relkind::text AS relkind,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  (SELECT count(*)::int FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count,
  (SELECT count(*)::int FROM pg_attribute a
    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname::text = ANY(${tenantColumnArray})) AS tenant_column_count,
  (SELECT count(*)::int FROM pg_constraint fk
    JOIN pg_class ref ON ref.oid = fk.confrelid
    WHERE fk.conrelid = c.oid AND fk.contype = 'f'
      AND ref.relname::text = ANY(${tenantFkArray})) AS tenant_fk_count
`;

/**
 * Shared WHERE predicate for "a relation an extension could own in `public`".
 *
 * Relkinds: 'r' ordinary, 'p' partitioned, plus 'm'/'f' — which cannot carry RLS
 * and are therefore REJECTED on sight rather than skipped (see
 * RLS_INCAPABLE_RELKINDS). Plain views ('v') are excluded: they hold no rows and
 * execute under the querier's RLS.
 *
 * Both child forms are excluded. `relispartition` covers DECLARATIVE partition
 * children only — a legacy `INHERITS` child has `relispartition = false` and
 * `relkind = 'r'`, so without the pg_inherits clause it would come back as an
 * undeclared table and brick the boot the next month a child is created: exactly
 * the "boot failure on the calendar" the partition guard exists to prevent,
 * arriving by a different door.
 *
 * pg_extension-owned relations (`pg_depend.deptype = 'e'`, e.g. TimescaleDB
 * artifacts) are excluded — they are not core's and not the extension's.
 */
const extensionCatalogPredicate = sql`
  n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'm', 'f')
  AND NOT c.relispartition
  AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.refobjid
    WHERE d.objid = c.oid AND d.deptype = 'e')
`;

/**
 * Unwrap the driver's result set, failing CLOSED on any shape we don't
 * recognise.
 *
 * postgres-js returns an array-like; node-postgres returns `{ rows }`. The
 * tempting `(result?.rows ?? [])` fallback silently yields ZERO rows for
 * anything else — and zero rows is indistinguishable, to every check below,
 * from "this extension owns no tables and declared none". A driver swap or a
 * wrapper change could therefore switch this entire tripwire off without a
 * single test going red. That is precisely the silent pass this function exists
 * to prevent, so an unreadable result is an error, not an empty set.
 */
function extractCatalogRows(result: unknown, extensionName: string): RlsCatalogRow[] {
  if (Array.isArray(result)) return result as RlsCatalogRow[];
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  if (Array.isArray(rows)) return rows as RlsCatalogRow[];
  throw new Error(
    `[extensions] tenancy check for "${extensionName}" could not read the catalog query result `
      + `(unrecognised driver shape: ${Object.prototype.toString.call(result)}). Refusing to boot rather `
      + 'than assume the extension has no tables — an unreadable result must never be read as "all clear".',
  );
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
 * fails the boot if it carries a tenant COLUMN (TENANT_SCOPE_COLUMNS) or a
 * FOREIGN KEY into a core tenant entity (CORE_TENANT_FK_TABLES). The FK half is
 * what makes this a check rather than a naming convention — an extension can
 * call its column `organization_id` and dodge the name match, but not the key.
 *
 * SCOPE — what this does NOT prove. Ownership is inferred from the `<name>_`
 * prefix in schema `public`. The prefix is enforced on manifest DECLARATIONS
 * (packages/extension-api), never on the DDL an extension's migration actually
 * runs. A table created unprefixed, or in a non-public schema, is not caught
 * here. `assertNoUnaccountedPublicTables` below closes the unprefixed case
 * repo-wide; the non-public-schema case remains open and is tracked separately —
 * closing it properly means recording table ownership at migration time rather
 * than inferring it from a string.
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

  // One round-trip covering BOTH directions: every table this extension owns by
  // prefix, UNION every table it declared (a declared table that doesn't exist
  // must still be reported, and it may not match the prefix — memory_blocks).
  const result = (await db.execute(sql`
    SELECT ${extensionCatalogColumns}
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${extensionCatalogPredicate}
      AND (
        starts_with(c.relname::text, ${ownershipPrefix})
        OR c.relname::text = ANY(${declaredArray})
      )
  `)) as unknown;
  const rows = extractCatalogRows(result, extensionName);
  const byName = new Map(rows.map((r) => [r.table_name, r]));

  const problems: string[] = [];

  // An extension-owned matview / foreign table can hold a physical copy of every
  // tenant's rows in a relation Postgres will not apply RLS to, at all. There is
  // no compliant version of this, so there is no declaration that makes it OK —
  // reject it before the RLS verdicts, which cannot express "impossible".
  for (const row of rows) {
    const incapable = RLS_INCAPABLE_RELKINDS[row.relkind];
    if (!incapable) continue;
    if (!row.table_name.startsWith(ownershipPrefix) && !declared.has(row.table_name)) continue;
    problems.push(
      `"${row.table_name}" is a ${incapable}, which Postgres cannot protect with RLS at all. `
        + 'Extensions may not create these — the rows would be readable across every tenant. Use a '
        + 'plain table with RLS, or a plain view (which runs under the querier\'s policies).',
    );
  }

  // Direction 1 — every DECLARED tenant table must exist and be RLS-compliant.
  for (const table of tenantTables) {
    const row = byName.get(table);
    if (!row) {
      problems.push(`"${table}" is declared in the manifest tenancy but does not exist (did its migration run?)`);
      continue;
    }
    if (RLS_INCAPABLE_RELKINDS[row.relkind]) continue; // already reported above
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
    // Both counts fail CLOSED on a non-finite value, matching the policy_count
    // check above. A bare `Number(x) > 0` is FALSE for NaN/null/undefined, so an
    // unexpected row shape would silently ratify the opt-out for a table that
    // actually IS tenant-scoped — the exact laundering this check exists to stop.
    const tenantColumns = Number(row.tenant_column_count);
    const tenantFks = Number(row.tenant_fk_count);
    if (!Number.isFinite(tenantColumns) || !Number.isFinite(tenantFks)) {
      problems.push(
        `"${table}" is declared in tenancy.nonTenantTables but its tenant-scope counts could not be read `
          + '(unexpected catalog row shape) — refusing to take the opt-out on trust.',
      );
      continue;
    }
    // The FK check is the load-bearing one. TENANT_SCOPE_COLUMNS is a list of
    // names the POLICED PARTY chooses, so `organization_id` / `tenant_id` /
    // `customer_id` walk straight past it. A foreign key into a core tenant
    // entity is a fact about the data, not a naming convention.
    if (tenantFks > 0) {
      problems.push(
        `"${table}" is declared in tenancy.nonTenantTables but has a FOREIGN KEY into a core tenant table `
          + `(one of ${CORE_TENANT_FK_TABLES.join('/')}) — it IS tenant-scoped, whatever its columns are `
          + 'named. Move it to the correct tenancy array and give it RLS.',
      );
    } else if (tenantColumns > 0) {
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
    if (RLS_INCAPABLE_RELKINDS[row.relkind]) continue; // already reported above
    const looksTenantScoped = Number(row.tenant_column_count) > 0 || Number(row.tenant_fk_count) > 0;
    problems.push(
      looksTenantScoped
        ? `"${table}" exists and is tenant-scoped (a ${TENANT_SCOPE_COLUMNS.join('/')} column, or a foreign `
          + 'key into a core tenant table) but is declared in NO manifest tenancy array — it ships with zero '
          + 'RLS verification AND no cascade / org-move handling. Add it to the correct tenancy array.'
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

/**
 * Repo-wide catch-all: every table in `public` must be accounted for by core or
 * by SOME extension's manifest.
 *
 * `assertExtensionTenancyRls` infers ownership from the `<name>_` prefix, but
 * that prefix is enforced only on manifest DECLARATIONS — never on the DDL an
 * extension's migration actually runs. So an extension named `demo` whose
 * migration writes `CREATE TABLE documents (org_id uuid, ...)` is invisible to
 * the per-extension scan: `demo_` doesn't match it, and nothing declares it.
 * That reopens #2466's hole for the price of one word in a migration.
 *
 * This closes it without trusting the prefix: anything left over after
 * subtracting core's tables and every extension's declarations is, by
 * elimination, an undeclared extension table. Only runs when an extension is
 * actually installed, so a stock Breeze deploy can never be bricked by it.
 *
 * Residual (tracked separately): a table created in a NON-public schema is still
 * out of reach. Closing that means recording table ownership at migration time
 * rather than inferring it from the catalog.
 */
export async function assertNoUnaccountedPublicTables(
  tenancies: readonly ExtensionTenancyDeclaration[],
): Promise<void> {
  const declared = new Set<string>();
  for (const t of tenancies) {
    for (const table of [
      ...t.orgCascadeDeleteTables,
      ...t.deviceCascadeDeleteTables,
      ...t.deviceOrgDenormalizedTables,
      ...(t.deviceOrgMoveDeleteTables ?? []),
      ...(t.nonTenantTables ?? []),
    ]) declared.add(table);
  }

  const result = (await db.execute(sql`
    SELECT ${extensionCatalogColumns}
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${extensionCatalogPredicate}
  `)) as unknown;
  const rows = extractCatalogRows(result, '<all>');

  const core = coreTableNames();
  const unaccounted = rows
    .map((r) => r.table_name)
    .filter((t) => !core.has(t) && !SHARED_TABLE_ALLOWLIST.has(t) && !declared.has(t));

  if (unaccounted.length > 0) {
    throw new Error(
      '[extensions] refusing to boot — these public tables belong to no core schema and to no extension '
        + `manifest:\n  - ${unaccounted.join('\n  - ')}\n`
        + 'An extension table must be declared in its manifest tenancy arrays (or tenancy.nonTenantTables) '
        + 'so it gets an RLS check; extension tables are invisible to the core rls-coverage contract test, '
        + 'and this is their only tripwire. If one of these is a CORE table, it is missing from the Drizzle '
        + 'schema — add it there (or to CORE_NON_DRIZZLE_TABLES in extensions/loader.ts).',
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

  // Runs once, AFTER every extension is accounted for: catches an extension
  // table that dodged its own prefix scan by simply not using the prefix.
  await assertNoUnaccountedPublicTables(discovered.map((d) => d.manifest.tenancy));
}
