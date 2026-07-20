import { config } from 'dotenv';
// Load .env from monorepo root (when running from apps/api) or cwd (when running from root)
config({ path: '../../.env' });
config(); // Also try cwd

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { captureMessage } from '../services/sentry';
import {
  logRequestDatabaseConfigSource,
  resolveRequestDatabaseConfig,
} from './requestDatabaseConfig';

const requestDatabaseConfig = resolveRequestDatabaseConfig();
logRequestDatabaseConfigSource(requestDatabaseConfig);

// Pool sizing: postgres-js defaults to max=10, which causes cascading 504s
// under heartbeat storms (e.g. a 1000-agent fleet reconnecting at once).
// Default to 30 and allow tuning via DB_POOL_MAX.
function getDbPoolMax(): number {
  const raw = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 30;
  }
  return raw;
}

const client = postgres(requestDatabaseConfig.url, {
  max: getDbPoolMax(),
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
});

export interface RequestDatabaseRole {
  currentUser: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
}

const REQUEST_DATABASE_ROLE_REMEDIATION =
  'Set DATABASE_URL_APP to a NOSUPERUSER NOBYPASSRLS role, or configure ' +
  'BREEZE_APP_DB_PASSWORD/POSTGRES_PASSWORD so Breeze can derive the breeze_app URL.';

/**
 * Reads the effective role from the exact module-scope postgres.js client that
 * backs `db`. This must not use a separate probe connection: startup is proving
 * the identity and RLS capabilities of the pool that will serve requests.
 */
export async function getRequestDatabaseRole(): Promise<RequestDatabaseRole> {
  let rows: readonly unknown[];
  try {
    rows = await client`
      SELECT current_user AS "currentUser",
             rolsuper AS "isSuperuser",
             rolbypassrls AS "bypassesRls"
      FROM pg_roles
      WHERE rolname = current_user
    `;
  } catch {
    throw new Error(
      '[database] Could not query the effective request database role. ' +
        REQUEST_DATABASE_ROLE_REMEDIATION,
    );
  }
  const role = rows[0] as RequestDatabaseRole | undefined;

  if (!role) {
    throw new Error(
      '[database] Could not verify the effective request database role: ' +
        `pg_roles returned no row for current_user. ${REQUEST_DATABASE_ROLE_REMEDIATION}`,
    );
  }

  return role;
}

export async function assertRequestDatabaseRoleSafe(): Promise<RequestDatabaseRole> {
  const role = await getRequestDatabaseRole();
  const unsafeCapabilities: string[] = [];
  if (role.isSuperuser) unsafeCapabilities.push('SUPERUSER');
  if (role.bypassesRls) unsafeCapabilities.push('BYPASSRLS');

  if (unsafeCapabilities.length > 0) {
    throw new Error(
      `[database] Unsafe effective request database role "${role.currentUser}": ` +
        `${unsafeCapabilities.join(' and ')}. Request handlers require a ` +
        `NOSUPERUSER NOBYPASSRLS role. ${REQUEST_DATABASE_ROLE_REMEDIATION}`,
    );
  }

  return role;
}

const baseDb = drizzle(client, { schema });
const dbContextStorage = new AsyncLocalStorage<typeof baseDb>();
// Parallel store holding the DbAccessContext METADATA (scope + allowlists) for
// the active request transaction. Kept separate from dbContextStorage (which
// resolves to the tx for query routing) so the tx-resolution hot path is
// untouched. Set/cleared in lockstep with dbContextStorage. Lets callers cheaply
// ask "does the active context already grant visibility to row X?" before
// deciding whether they must escalate to a system context (see
// getCurrentDbAccessContext + permissions.getUserPermissions).
const dbContextMetaStorage = new AsyncLocalStorage<DbAccessContext>();

function getCurrentDb(): typeof baseDb {
  return dbContextStorage.getStore() ?? baseDb;
}

export type DbAccessScope = 'system' | 'partner' | 'organization';

export interface DbAccessContext {
  scope: DbAccessScope;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  /**
   * UUIDs of partners the caller can access. Undefined is treated as
   * "unset" — same behavior as the previous two-axis model: system scope
   * sees all partners, every other scope sees none. Populate this from
   * the JWT partnerId for partner-scope callers to enable RLS on
   * `partners` / `partner_users` to pass.
   */
  accessiblePartnerIds?: string[] | null;
  /**
   * The authenticated user's id, for the self-read branch of the
   * `users` RLS policy (so a user can always SELECT their own row even
   * when their caller scope doesn't otherwise grant access). Set from
   * `auth.user.id` in the middleware. Omit (or set to null) for non-
   * human callers (API keys, agents, system jobs).
   */
  userId?: string | null;
  /**
   * The caller's OWN partner id, used solely for read-visibility of
   * partner-wide catalog rows (org_id NULL, partner_id = this) via the
   * read-only branch of those tables' SELECT policy. This is NOT an access
   * grant — it does not widen partner-axis WRITE/admin access (that is
   * governed by `accessiblePartnerIds`). Set it for every caller scope
   * (including organization scope) to the caller's own partner. Omit (or
   * set to null) when no partner is in scope; the read branch simply won't
   * apply.
   */
  currentPartnerId?: string | null;
}

export const SYSTEM_DB_ACCESS_CONTEXT: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
  // System scope already reads all rows via the scope short-circuit in the
  // policy helpers, so the own-partner read branch is irrelevant here.
  currentPartnerId: null,
};

function serializeAccessibleIds(scope: DbAccessScope, accessibleIds: string[] | null | undefined): string {
  // System scope always serializes to "*" regardless of whether the list
  // was provided. This keeps existing callers that only populated
  // accessibleOrgIds working as-is (system scope → system-wide access on
  // all axes) and matches the `breeze_accessible_*_ids()` helper shape.
  if (scope === 'system') {
    return '*';
  }

  if (accessibleIds === null || accessibleIds === undefined) {
    // Unset for a non-system scope means "no access" — the fail-closed
    // branch in the SQL helpers treats empty string as ARRAY[]::uuid[].
    return '';
  }

  if (accessibleIds.length === 0) {
    return '';
  }

  return accessibleIds.join(',');
}

// #1105 — held-context duration tripwire. withDbAccessContext sets the RLS
// GUCs with SET LOCAL, so it MUST hold an open transaction for the full
// duration of `fn` — pinning one pooled connection the whole time. If `fn`
// does slow NON-DB work (Redis/BullMQ enqueue, outbound HTTP, per-device
// loops) the connection sits idle-in-transaction; under a mass agent reconnect
// those connections are killed by idle_in_transaction_session_timeout and
// cascade into a pool-poisoning connection-exhaustion outage.
//
// This is a COARSE heuristic: it measures total time `fn` held the context,
// which it cannot distinguish from a legitimately slow DB query that keeps the
// connection busy (not idle). Both are worth knowing about, but the precise
// "slow non-DB work inside a context" signal comes from assertOutsideHeldDbContext
// once it is wired into the slow primitives (Phase 2). The default threshold is
// therefore set well above normal request latency to stay an outlier signal.
// Warn-only (prod-safe, mirroring the contextless-write guard, #1375); tune or
// disable via DB_CONTEXT_HELD_WARN_MS (0 disables).
function getHeldContextWarnMs(): number {
  const raw = Number.parseInt(process.env.DB_CONTEXT_HELD_WARN_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 2000;
  }
  return raw;
}

// The held-context warning marks a recurring CONDITION (a conn-hold bug), not N
// distinct errors. Capturing it to Sentry on EVERY occurrence floods the org's
// event quota: a single conn-hold worker produced 8.6k events in a week, which
// exhausted the budget and silently dropped ALL error reporting org-wide (the
// June 2026 Sentry blackout). Throttle the Sentry capture to at most once per
// scope per window so it still alerts/trends without flooding. `console.warn`
// stays unthrottled so logs remain complete. 0 disables the throttle (always
// capture). Tune via DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS.
function getHeldContextCaptureThrottleMs(): number {
  const raw = Number.parseInt(process.env.DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 5 * 60_000;
  }
  return raw;
}
const lastHeldContextCaptureAtByScope = new Map<string, number>();
export function __resetHeldContextCaptureThrottleForTests(): void {
  lastHeldContextCaptureAtByScope.clear();
}

/**
 * Per-scope throttle gate for the held-context Sentry capture. Returns true (and
 * records `now` as the scope's last-capture time) at most once per `throttleMs`
 * window per scope; `throttleMs === 0` disables throttling (always true). Pure
 * apart from the module-level last-seen map — exported for unit testing.
 */
export function shouldCaptureHeldContext(scope: string, now: number, throttleMs: number): boolean {
  if (throttleMs === 0) return true;
  const lastAt = lastHeldContextCaptureAtByScope.get(scope);
  if (lastAt === undefined || now - lastAt >= throttleMs) {
    lastHeldContextCaptureAtByScope.set(scope, now);
    return true;
  }
  return false;
}

export async function withDbAccessContext<T>(
  context: DbAccessContext,
  fn: () => Promise<T>
): Promise<T> {
  if (dbContextStorage.getStore()) {
    return fn();
  }

  return baseDb.transaction(async (tx) => {
    const serializedOrgIds = serializeAccessibleIds(context.scope, context.accessibleOrgIds);
    const serializedPartnerIds = serializeAccessibleIds(context.scope, context.accessiblePartnerIds);
    const serializedUserId = context.userId ?? '';

    await tx.execute(sql`select set_config('breeze.scope', ${context.scope}, true)`);
    await tx.execute(sql`select set_config('breeze.org_id', ${context.orgId ?? ''}, true)`);
    await tx.execute(sql`select set_config('breeze.accessible_org_ids', ${serializedOrgIds}, true)`);
    await tx.execute(sql`select set_config('breeze.accessible_partner_ids', ${serializedPartnerIds}, true)`);
    await tx.execute(sql`select set_config('breeze.user_id', ${serializedUserId}, true)`);
    await tx.execute(sql`select set_config('breeze.current_partner_id', ${context.currentPartnerId ?? ''}, true)`);

    const warnMs = getHeldContextWarnMs();
    const startedAt = warnMs > 0 ? Date.now() : 0;
    try {
      return await dbContextStorage.run(tx as unknown as typeof baseDb, () =>
        dbContextMetaStorage.run(context, fn),
      );
    } finally {
      // The whole point of this block is to SURFACE problems, so it must never
      // BECOME one: any throw here (e.g. a Sentry transport hiccup) would, from
      // a finally, mask fn's real return value or error. Swallow instrumentation
      // failures so the transaction's true outcome always propagates unchanged.
      try {
        if (warnMs > 0) {
          const heldMs = Date.now() - startedAt;
          if (heldMs >= warnMs) {
            const message =
              `withDbAccessContext (scope=${context.scope}) held a pooled connection in an open `
              + `transaction for ${heldMs}ms (>= ${warnMs}ms) — long enough that it likely did slow `
              + `non-DB work (Redis/HTTP/loops) or a slow query inside the context. If the former, `
              + `move it after the context closes or wrap it in runOutsideDbContext (#1105).`;
            console.warn(message);
            // Throttle the Sentry capture per scope (see getHeldContextCaptureThrottleMs)
            // so a recurring conn-hold can't flood the org's event quota.
            if (shouldCaptureHeldContext(context.scope, Date.now(), getHeldContextCaptureThrottleMs())) {
              captureMessage(message, 'warning', { heldMs, scope: context.scope, stack: new Error().stack });
            }
          }
        }
      } catch {
        // Detection instrumentation must never alter fn's real result/error.
      }
    }
  });
}

export async function withSystemDbAccessContext<T>(fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(SYSTEM_DB_ACCESS_CONTEXT, fn);
}

/**
 * Resolve a tenant context and run work in the same transaction that performed
 * that resolution. The transaction begins in system scope so the resolver can
 * discover an allowlist, then its SET LOCAL RLS context is narrowed before
 * `fn` runs. This is intentionally different from nesting withDbAccessContext:
 * nested calls retain the existing context and therefore cannot safely bridge
 * a lock-protected allowlist discovery into tenant-scoped request work.
 */
export async function withResolvedDbAccessContext<T, R>(
  resolve: () => Promise<{ context: DbAccessContext; value: R }>,
  fn: (value: R) => Promise<T>,
): Promise<T> {
  return withSystemDbAccessContext(async () => {
    const resolved = await resolve();
    const activeDb = getCurrentDb();
    const serializedOrgIds = serializeAccessibleIds(
      resolved.context.scope,
      resolved.context.accessibleOrgIds,
    );
    const serializedPartnerIds = serializeAccessibleIds(
      resolved.context.scope,
      resolved.context.accessiblePartnerIds,
    );
    await activeDb.execute(sql`select set_config('breeze.scope', ${resolved.context.scope}, true)`);
    await activeDb.execute(sql`select set_config('breeze.org_id', ${resolved.context.orgId ?? ''}, true)`);
    await activeDb.execute(sql`select set_config('breeze.accessible_org_ids', ${serializedOrgIds}, true)`);
    await activeDb.execute(sql`select set_config('breeze.accessible_partner_ids', ${serializedPartnerIds}, true)`);
    await activeDb.execute(sql`select set_config('breeze.user_id', ${resolved.context.userId ?? ''}, true)`);
    await activeDb.execute(sql`select set_config('breeze.current_partner_id', ${resolved.context.currentPartnerId ?? ''}, true)`);
    return dbContextMetaStorage.run(resolved.context, () => fn(resolved.value));
  });
}

/**
 * True when the current async scope is inside an active
 * `withDbAccessContext` / `withSystemDbAccessContext` call. Use to assert
 * RLS context is established before a tenant-scoped query in code paths
 * where a bare-pool fallback would be a silent security bug
 * (e.g. PAM auto-elevation lookups — a missing context falls back to the
 * unprivileged `breeze_app` role with no GUC, RLS denies, and the caller
 * sees a silent empty result instead of an auto-deny).
 */
export function hasDbAccessContext(): boolean {
  return dbContextStorage.getStore() !== undefined;
}

/**
 * The DbAccessContext metadata (scope + org/partner allowlists) of the active
 * request transaction, or undefined when no context is established. Use this to
 * decide whether the ambient context already grants RLS visibility to a specific
 * row BEFORE deciding to escalate to a system context — its `scope`,
 * `accessibleOrgIds`, and `accessiblePartnerIds` mirror exactly what
 * `breeze_has_org_access` / `breeze_has_partner_access` evaluate, so an
 * allowlist hit here means RLS will return the row. Returns the same object
 * passed to `withDbAccessContext`; do not mutate it.
 */
export function getCurrentDbAccessContext(): DbAccessContext | undefined {
  return dbContextMetaStorage.getStore();
}

export type RunOutsideDbContextFn = <T>(fn: () => T) => T;

/**
 * Runs a function outside any active AsyncLocalStorage DB context,
 * ensuring `db` resolves to `baseDb` (the connection pool) rather
 * than a request-scoped transaction. Use this for long-lived background
 * tasks that outlive the originating HTTP request. Exits BOTH the tx-routing
 * store and the metadata store so a nested withSystemDbAccessContext opens a
 * genuinely fresh context and getCurrentDbAccessContext reflects reality.
 */
export const runOutsideDbContext: RunOutsideDbContextFn = <T>(fn: () => T): T => {
  return dbContextStorage.exit(() => dbContextMetaStorage.exit(fn));
};

// Query-builder write methods that, when invoked on the bare pool (no active
// RLS access context), silently match 0 rows under the forced-RLS `breeze_app`
// role instead of erroring (#1375). We instrument these to surface the
// missing-context bug to logs + Sentry.
const CONTEXTLESS_WRITE_GUARD_METHODS = new Set<PropertyKey>(['insert', 'update', 'delete']);

// Raw SQL writes go through `db.execute(sql`...`)`, which the builder-method set
// above cannot see — so a contextless raw DELETE/UPDATE/INSERT would slip the
// guard entirely (the exact style cascadeDeletePartner uses). This classifies
// the leading verb of an execute() statement.
//
// A non-CTE write starts directly with the verb. A CTE-prefixed write
// (`WITH ... DELETE FROM t`) carries the data-modifying statement after the
// CTE block, so we also match a write verb anchored to its target keyword:
// `INSERT INTO`, `UPDATE <ident> SET`, `DELETE FROM`. Anchoring to the target
// is what keeps a *read* like `WITH cte AS (SELECT ...) SELECT ...` from being
// misclassified when the query merely MENTIONS those verbs — e.g. a catalog
// inspection containing `UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE'])`.
// String literals are stripped first (in classifyContextlessExecuteVerb) so a
// quoted `'DELETE'` can never match, and the bare verbs in such a list aren't
// followed by INTO/FROM/an UPDATE target+SET, so they don't match the anchored
// form either. SELECT/WITH reads never match; genuine raw writes still do.
const RAW_WRITE_LEADING_RE = /^\s*(insert|update|delete)\b/i;
// `UPDATE <target> ... SET` allows an optional ONLY and a table alias between
// the target and SET (`UPDATE foo AS f SET`), bounded so it can't run away into
// an unrelated later `set`. Literals are already stripped, so a bare `update`
// keyword here is a real statement, not a quoted word.
const RAW_WRITE_STMT_RE = /\b(?:(insert)\s+into|(update)\s+(?:only\s+)?[a-z_"][a-z0-9_."]*\b[\s\S]{0,80}?\bset\b|(delete)\s+from)\b/i;
// Single-quoted SQL string literals (with '' escape) — removed before
// classification so verbs appearing inside a literal cannot trip the match.
const SQL_STRING_LITERAL_RE = /'(?:[^']|'')*'/g;

// Dedup so a hot contextless path can't flood Sentry and bury the signal.
// Keyed by the originating stack → each distinct call site reports once.
// `console.warn` still fires every time (logs stay complete); only the Sentry
// capture is throttled. The reset hook keeps the guard's own tests deterministic.
const reportedContextlessSites = new Set<string>();
export function __resetContextlessWriteGuardForTests(): void {
  reportedContextlessSites.clear();
}

function reportContextlessWrite(label: string): void {
  const stack = new Error().stack;
  const message =
    `DB write ${label} ran with no RLS access context — `
    + `wrap in withDbAccessContext/withSystemDbAccessContext (#1375)`;
  // #1379 A1 — opt-in escalation: set DB_CONTEXTLESS_WRITE_STRICT to make a
  // contextless write THROW instead of only warning, so a targeted run (a
  // developer hunting a #1375 regression) fails loudly. OFF by default — prod
  // AND CI stay warn-only for now. Global CI enforcement is deferred: ~20 RLS
  // negative-control integration tests deliberately issue contextless writes
  // through this proxy to prove DB-layer rejection, and must be migrated off
  // the proxy (or opt out) before the gate can be flipped on suite-wide
  // (tracked as a #1379 follow-up). The genuinely-intentional production paths
  // never reach here anyway: auditAdminPool bypasses this proxy, and
  // device_commands writes under an explicit system context. Mirrors
  // assertOutsideHeldDbContext's strict gate.
  if (STRICT_TRIPWIRE_VALUES.has((process.env.DB_CONTEXTLESS_WRITE_STRICT ?? '').trim().toLowerCase())) {
    throw new Error(message);
  }
  console.warn(message);
  const key = stack ?? label;
  if (reportedContextlessSites.has(key)) return;
  reportedContextlessSites.add(key);
  captureMessage(message, 'warning', { stack });
}

// Best-effort extraction of the leading SQL text from a drizzle `sql` object so
// execute() can be classified read-vs-write. Defensive: any shape surprise just
// yields '' (treated as a non-write — fail open, since this is observability,
// not a security control). The window is generous (not just a short prefix) so
// a data-modifying statement that trails a long CTE block — `WITH big AS (...)
// DELETE FROM t` — is still reached by the anchored classifier below.
function rawSqlLeadingText(arg: unknown): string {
  try {
    const chunks = (arg as { queryChunks?: unknown[] })?.queryChunks;
    if (!Array.isArray(chunks)) return '';
    let text = '';
    for (const ch of chunks) {
      const v = (ch as { value?: unknown })?.value;
      if (typeof v === 'string') text += v;
      else if (Array.isArray(v)) text += (v as unknown[]).join('');
      if (text.length >= 4096) break; // enough to clear a long leading CTE
    }
    return text;
  } catch {
    return '';
  }
}

// Returns the leading write verb ('insert'|'update'|'delete') of a raw `sql`
// statement, or null for reads. Exported so the guard's classification can be
// unit-tested without opening a DB connection.
//
// Strips single-quoted string literals first so a verb inside a literal (e.g.
// a catalog query's `ARRAY['SELECT','INSERT','UPDATE','DELETE']`) never trips
// the match. A statement is a write when it either *starts* with a write verb
// (plain INSERT/UPDATE/DELETE) or contains the verb anchored to its target
// (`INSERT INTO`, `UPDATE <ident> SET`, `DELETE FROM`) — the latter catches a
// data-modifying CTE statement that trails a `WITH ...` prefix while ignoring
// reads that merely mention the verbs.
export function classifyContextlessExecuteVerb(arg: unknown): string | null {
  const text = rawSqlLeadingText(arg).replace(SQL_STRING_LITERAL_RE, "''");

  const leading = text.match(RAW_WRITE_LEADING_RE);
  if (leading && leading[1]) return leading[1].toLowerCase();

  const stmt = text.match(RAW_WRITE_STMT_RE);
  if (stmt) {
    const verb = stmt[1] ?? stmt[2] ?? stmt[3];
    if (verb) return verb.toLowerCase();
  }

  return null;
}

/**
 * #1105 tripwire guard. Call at the top of a known-slow primitive — a
 * Redis/BullMQ enqueue or an outbound HTTP request — to flag when it runs while
 * a withDbAccessContext transaction is still held. That is the txn-around-slow-
 * work pattern: the held transaction's pooled connection sits idle across the
 * primitive's latency, and under a mass agent reconnect those connections are
 * killed and cascade into a pool-poisoning connection-exhaustion outage.
 *
 * The fix at a call site is to do the slow work AFTER the context closes, or
 * inside `runOutsideDbContext(...)` (which exits the context so this guard is a
 * no-op). Warn-only by default — prod-safe, mirroring the contextless-write
 * guard (#1375) — so it never breaks a running deploy. Set
 * DB_CONTEXT_TRIPWIRE_STRICT (1/true/yes/on) to throw instead, so a
 * newly-introduced violation fails the build rather than only surfacing in
 * Sentry after an incident.
 */
const STRICT_TRIPWIRE_VALUES = new Set(['1', 'true', 'yes', 'on']);

// Dedup the Sentry capture per call site, mirroring the contextless-write
// guard above: the tripwire marks a wrong CALL SITE, not N distinct errors, so
// one report per site per process is the whole signal. Unthrottled, a single
// hot path burned ~2.2k events/day (BREEZE-H) against the org quota — the same
// flood-then-blackout failure mode #1894 fixed for the held-duration warning.
// `console.warn` still fires every time so logs stay complete.
const reportedHeldContextSites = new Set<string>();
export function __resetHeldContextAssertDedupeForTests(): void {
  reportedHeldContextSites.clear();
}

/**
 * Returns true at most once per key (originating call site) for the lifetime of
 * the process; subsequent calls with the same key return false. Pure apart from
 * the module-level seen-set — exported for unit testing.
 */
export function shouldReportHeldContextSite(key: string): boolean {
  if (reportedHeldContextSites.has(key)) return false;
  reportedHeldContextSites.add(key);
  return true;
}

export function assertOutsideHeldDbContext(operation: string): void {
  if (!hasDbAccessContext()) {
    return;
  }
  const message =
    `${operation} ran inside a held withDbAccessContext transaction — it pins a pooled `
    + `connection idle-in-transaction across slow work (#1105). Move it after the context `
    + `closes or wrap it in runOutsideDbContext().`;
  if (STRICT_TRIPWIRE_VALUES.has((process.env.DB_CONTEXT_TRIPWIRE_STRICT ?? '').trim().toLowerCase())) {
    throw new Error(message);
  }
  console.warn(message);
  const stack = new Error().stack;
  if (!shouldReportHeldContextSite(stack ?? operation)) return;
  captureMessage(message, 'warning', { operation, stack });
}

const proxiedDb = new Proxy(baseDb, {
  get(_target, prop) {
    const activeDb = getCurrentDb() as unknown as Record<PropertyKey, unknown>;
    const value = activeDb[prop];
    if (typeof value !== 'function') {
      return value;
    }
    const bound = (value as (...args: unknown[]) => unknown).bind(activeDb);

    // Contextless-write guard (#1375 / #1379). The check fires at CALL time, not
    // on getter access, so merely referencing `db.update` no longer warns.
    if (CONTEXTLESS_WRITE_GUARD_METHODS.has(prop)) {
      return (...args: unknown[]) => {
        if (!hasDbAccessContext()) reportContextlessWrite(`.${String(prop)}()`);
        return bound(...args);
      };
    }

    if (prop === 'execute') {
      return (...args: unknown[]) => {
        if (!hasDbAccessContext()) {
          const verb = classifyContextlessExecuteVerb(args[0]);
          if (verb) reportContextlessWrite(`.execute(${verb})`);
        }
        return bound(...args);
      };
    }

    return bound;
  }
}) as typeof baseDb;

export const db = Object.assign(proxiedDb, {
  runOutsideDbContext,
});

export type Database = typeof db;

// Dedicated audit-admin pool (issue #915). Re-exported here so the
// retention worker has a single db import surface. See auditAdminPool.ts
// for the rationale (connection-level privilege separation).
export {
  getAuditAdminDb,
  hasDedicatedAuditAdminPool,
  logAuditAdminPoolMode,
  closeAuditAdminPool,
  type AuditAdminDb,
} from './auditAdminPool';

import { closeAuditAdminPool as closeAuditAdminPoolInternal } from './auditAdminPool';

export async function closeDb(): Promise<void> {
  // Drain the dedicated audit-admin pool (#915) alongside the main pool so a
  // graceful shutdown doesn't leak its connection.
  await Promise.all([client.end(), closeAuditAdminPoolInternal()]);
}
