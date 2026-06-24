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

// Prefer DATABASE_URL_APP (the unprivileged breeze_app role) so RLS policies
// are actually enforced. Fall back to DATABASE_URL for backward compatibility
// with existing deployments; autoMigrate will warn loudly if that connection
// has BYPASSRLS/SUPERUSER.
const connectionString =
  process.env.DATABASE_URL_APP
  || process.env.DATABASE_URL
  || 'postgresql://breeze:breeze@localhost:5432/breeze';

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

const client = postgres(connectionString, {
  max: getDbPoolMax(),
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
});
const baseDb = drizzle(client, { schema });
const dbContextStorage = new AsyncLocalStorage<typeof baseDb>();

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
      return await dbContextStorage.run(tx as unknown as typeof baseDb, fn);
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
            captureMessage(message, 'warning', { heldMs, scope: context.scope, stack: new Error().stack });
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

export type RunOutsideDbContextFn = <T>(fn: () => T) => T;

/**
 * Runs a function outside any active AsyncLocalStorage DB context,
 * ensuring `db` resolves to `baseDb` (the connection pool) rather
 * than a request-scoped transaction. Use this for long-lived background
 * tasks that outlive the originating HTTP request.
 */
export const runOutsideDbContext: RunOutsideDbContextFn = <T>(fn: () => T): T => {
  return dbContextStorage.exit(fn);
};

// Query-builder write methods that, when invoked on the bare pool (no active
// RLS access context), silently match 0 rows under the forced-RLS `breeze_app`
// role instead of erroring (#1375). We instrument these to surface the
// missing-context bug to logs + Sentry.
const CONTEXTLESS_WRITE_GUARD_METHODS = new Set<PropertyKey>(['insert', 'update', 'delete']);

// Raw SQL writes go through `db.execute(sql`...`)`, which the builder-method set
// above cannot see — so a contextless raw DELETE/UPDATE/INSERT would slip the
// guard entirely (the exact style cascadeDeletePartner uses). This classifies
// the leading verb of an execute() statement. A leading CTE (`WITH ...`) is
// skipped so `WITH ... DELETE` still classifies as a write. SELECT and catalog
// reads never match, so they're left alone.
const RAW_WRITE_RE = /^\s*(?:with\b[\s\S]*)?\b(insert|update|delete)\b/i;

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
// not a security control).
function rawSqlLeadingText(arg: unknown): string {
  try {
    const chunks = (arg as { queryChunks?: unknown[] })?.queryChunks;
    if (!Array.isArray(chunks)) return '';
    let text = '';
    for (const ch of chunks) {
      const v = (ch as { value?: unknown })?.value;
      if (typeof v === 'string') text += v;
      else if (Array.isArray(v)) text += (v as unknown[]).join('');
      if (text.length >= 256) break; // enough to clear a short leading CTE
    }
    return text;
  } catch {
    return '';
  }
}

// Returns the leading write verb ('insert'|'update'|'delete') of a raw `sql`
// statement, or null for reads. Exported so the guard's classification can be
// unit-tested without opening a DB connection.
export function classifyContextlessExecuteVerb(arg: unknown): string | null {
  const m = rawSqlLeadingText(arg).match(RAW_WRITE_RE);
  return m && m[1] ? m[1].toLowerCase() : null;
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
  captureMessage(message, 'warning', { operation, stack: new Error().stack });
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
