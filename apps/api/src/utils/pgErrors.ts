// Shared with extensions so every Drizzle caller unwraps the same error shapes.
import { pgErrorCode } from '@breeze/shared/pgErrors';
export { isPgUniqueViolation, pgErrorCode, pgErrorNode } from '@breeze/shared/pgErrors';

/**
 * 40P01 = deadlock_detected, 40001 = serialization_failure, 55P03 =
 * lock_not_available. All three mean "you lost a lock race, the work was not
 * applied, try again" — never "the request was invalid". Postgres picks a
 * victim (40P01/40001) or gives up at a `lock_timeout` bound (55P03) and the
 * winner finishes immediately after, so the retry almost always succeeds.
 *
 * 55P03 is a no-op for every EXISTING caller of `retryOnTransientLockError`
 * below (see its call sites): Postgres can only raise it where a
 * `lock_timeout` is actually set, and until #3925 none of THOSE callers' own
 * transactions set one, so none of them could have observed it before. (Other
 * transactions in this codebase already set `lock_timeout` via
 * `tightenLockTimeout` — e.g. deviceDeletion.ts, catalogService.ts — but
 * those don't route through `retryOnTransientLockError`, so this change is
 * still a no-op for them.) Adding 55P03 here starts mattering only once a
 * `retryOnTransientLockError` caller bounds its own lock waits, which #3925
 * is the first to do (see `tightenLockTimeout` in `../db/lockTimeout`,
 * used by `ingestSoftwareInventoryReport` in `../services/softwareInventoryObservations`).
 */
export function isTransientLockError(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code === '40P01' || code === '40001' || code === '55P03';
}

/**
 * Re-run `fn` when it fails with a transient lock error (see
 * {@link isTransientLockError}). Anything else propagates untouched on the
 * first throw.
 *
 * Why this exists: the agent software-inventory ingest dropped ~4k reports in
 * six days because a deadlock (BREEZE-3) propagated straight to the global
 * error handler as a 500 and the whole report was discarded. Correct lock
 * ordering is the primary fix; this is the belt-and-braces for the remaining
 * writers of the same rows, because losing a lock race should cost a retry,
 * not an entire inventory report.
 *
 * IMPORTANT — `fn` must own a transaction boundary that the victim's rollback
 * actually reaches. Exactly two shapes qualify:
 *
 *  1. A NESTED drizzle transaction (one running inside a request-long
 *     `withDbAccessContext`, which drizzle emits as a SAVEPOINT) — it rolls
 *     back to its savepoint and leaves the outer transaction usable. See
 *     dbSavepointErrorIsolation.integration.test.ts for the isolation proof.
 *     Example: the software-inventory ingest in routes/agents/inventory.ts.
 *  2. A TOP-LEVEL transaction opened by `fn` itself from OUTSIDE any held
 *     context (e.g. `retryOnTransientLockError(..., () => correlateOrg(orgId))`
 *     in jobs/vulnerabilityJobs.ts, where each call opens its own
 *     withSystemDbAccessContext) — the victim has fully rolled back, so the
 *     retry starts clean.
 *
 * What must NEVER be wrapped is a bare statement whose failure aborted an
 * enclosing transaction the retry cannot escape: every follow-up then fails
 * with 25P02 until that transaction ends, and the retries are pure noise.
 */
export async function retryOnTransientLockError<T>(
  label: string,
  fn: () => Promise<T>,
  options: { attempts?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientLockError(error)) throw error;
      lastError = error;
      // Log every lost race, including the final one. A silent retry would hide
      // a lock-ordering regression: the symptom would shrink to added latency
      // with nothing in Sentry to explain it.
      console.warn(
        `[${label}] transient lock error ${pgErrorCode(error)} on attempt ${attempt}/${attempts}`
        + (attempt < attempts ? ' — retrying' : ' — giving up'),
      );
    }
  }

  throw lastError;
}
