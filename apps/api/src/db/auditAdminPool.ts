/**
 * Dedicated audit-admin connection pool (issue #915).
 *
 * The audit-log retention worker is the only code path allowed to DELETE
 * from `audit_logs`. Originally it ran on the shared `breeze_app` pool and
 * relied on `SET LOCAL ROLE breeze_audit_admin` + a bypass GUC — but
 * migration 2026-05-25-i granted `breeze_audit_admin` membership to
 * `breeze_app`, which means an attacker with SQLi/RCE inside the API
 * process could replicate the exact two-gate bypass and wipe audit rows
 * from the same connection.
 *
 * The fix is a *separate* pool that logs in directly as the
 * `breeze_audit_admin` role (no membership / SET ROLE involved). Once
 * `breeze_audit_admin` is REVOKEd from `breeze_app`, the main app pool can
 * never delete audit rows even if fully compromised — privilege separation
 * at the connection layer rather than the statement layer.
 *
 * Configuration is OPTIONAL and gated on `AUDIT_ADMIN_DATABASE_URL`:
 *   - SET   → secure path: retention runs on this dedicated pool.
 *   - UNSET → legacy fallback: retention runs on the breeze_app pool with
 *             SET LOCAL ROLE (the pre-#915 behavior), and a loud startup
 *             warning is logged. This lets existing deploys keep working
 *             until they provision the dedicated credential. The REVOKE
 *             migration is intentionally NOT auto-applied (see
 *             2026-06-11-e-...) so this fallback never breaks prod.
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type AuditAdminDb = ReturnType<typeof drizzle<typeof schema>>;

let cachedDb: AuditAdminDb | null = null;
let cachedClient: ReturnType<typeof postgres> | null = null;
let warnedLegacy = false;

/**
 * True when a dedicated audit-admin credential is configured. When false,
 * the retention worker falls back to the legacy shared-credential path.
 */
export function hasDedicatedAuditAdminPool(): boolean {
  const url = process.env.AUDIT_ADMIN_DATABASE_URL;
  return typeof url === 'string' && url.trim().length > 0;
}

/**
 * Returns the dedicated audit-admin Drizzle handle, lazily constructing
 * the pool on first use. Throws if `AUDIT_ADMIN_DATABASE_URL` is unset —
 * callers must gate on `hasDedicatedAuditAdminPool()` first.
 *
 * The pool is deliberately tiny: retention is a once-daily, single-org-at-
 * a-time job, so a couple of connections is plenty. Keeping it small also
 * minimizes the number of privileged connections sitting in the pool.
 */
export function getAuditAdminDb(): AuditAdminDb {
  const url = process.env.AUDIT_ADMIN_DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      '[AuditAdminPool] AUDIT_ADMIN_DATABASE_URL is not set — call hasDedicatedAuditAdminPool() before getAuditAdminDb()',
    );
  }
  if (cachedDb) return cachedDb;

  cachedClient = postgres(url, {
    max: 2,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
  });
  cachedDb = drizzle(cachedClient, { schema });
  return cachedDb;
}

/**
 * One-time startup diagnostic, called from the worker initializer. Logs a
 * loud warning when running in the insecure legacy shared-credential mode
 * so operators are nudged to provision `AUDIT_ADMIN_DATABASE_URL`.
 */
export function logAuditAdminPoolMode(): void {
  if (hasDedicatedAuditAdminPool()) {
    console.log(
      '[AuditRetention] Dedicated audit-admin credential configured (AUDIT_ADMIN_DATABASE_URL) — retention runs with connection-level privilege separation.',
    );
    return;
  }
  if (!warnedLegacy) {
    warnedLegacy = true;
    console.warn(
      '[AuditRetention] SECURITY: AUDIT_ADMIN_DATABASE_URL is NOT set. ' +
        'Retention is running in LEGACY shared-credential mode (breeze_app + SET LOCAL ROLE). ' +
        'This means audit_logs DELETE is reachable from the main app connection (issue #915). ' +
        'Provision a breeze_audit_admin login and set AUDIT_ADMIN_DATABASE_URL to close the bypass.',
    );
  }
}

/**
 * Lightweight liveness check used by tests. Runs `SELECT 1` against the
 * dedicated pool.
 */
export async function auditAdminPoolPing(): Promise<boolean> {
  const adminDb = getAuditAdminDb();
  await adminDb.execute(sql`SELECT 1`);
  return true;
}

/** Closes the dedicated pool (graceful shutdown / test teardown). */
export async function closeAuditAdminPool(): Promise<void> {
  if (cachedClient) {
    await cachedClient.end();
  }
  cachedClient = null;
  cachedDb = null;
}
