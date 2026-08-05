/**
 * Cross-session mutex for integration runs (#3066).
 *
 * Two concurrent `vitest run -c vitest.integration.config.ts` sessions against
 * the SAME database interleave per-test `TRUNCATE ... CASCADE` and role
 * GRANTs destructively (`tuple concurrently updated`, cross-session
 * `pg_stat_activity` locks). A Postgres session-level advisory lock — taken on
 * the target database itself and held for the whole vitest run — serializes
 * them, and beats a filesystem flock on every axis that matters here:
 *
 *  - scoped to the actual DB instance, so two per-worktree ephemeral stacks
 *    (`pnpm test-stack up`) never contend with each other;
 *  - auto-released by Postgres when the holding session dies, so a crashed or
 *    SIGKILLed run can never leave a stale lock behind;
 *  - works across users/containers with no well-known host path.
 *
 * CI is unaffected: each runner has its own isolated database, so the
 * try-lock always succeeds instantly.
 */
import type { Sql } from 'postgres';

import { isEnvFlagEnabled } from './envFlag';

// Arbitrary but fixed (namespace, key) pair for pg_advisory_lock's two-int
// form. 3066 = the issue that motivated this lock.
export const INTEGRATION_LOCK_NS = 0x425a; // 'BZ'
export const INTEGRATION_LOCK_KEY = 3066;

/** Env var: fail immediately instead of waiting for a concurrent run. */
export const LOCK_NOWAIT_ENV = 'BREEZE_INTEGRATION_LOCK_NOWAIT';

/**
 * Acquire the run lock on `client`'s session. The caller MUST hold `client`
 * open (max: 1 — advisory locks are session-scoped) for the entire run and
 * release via {@link releaseIntegrationRunLock} (or just close the
 * connection) afterwards.
 */
export async function acquireIntegrationRunLock(client: Sql, dbTarget: string): Promise<void> {
  const [{ locked }] = await client<[{ locked: boolean }]>`
    SELECT pg_try_advisory_lock(${INTEGRATION_LOCK_NS}, ${INTEGRATION_LOCK_KEY}) AS locked
  `;
  if (locked) return;

  if (isEnvFlagEnabled(process.env[LOCK_NOWAIT_ENV])) {
    throw new Error(
      `Integration run refused: another session is already running the integration suite against ${dbTarget} `
      + `(advisory lock held) and ${LOCK_NOWAIT_ENV} is set. `
      + 'Wait for it, or give this worktree its own stack: pnpm test-stack up',
    );
  }

  console.warn(
    `[integration global-setup] Another session is running the integration suite against ${dbTarget} — `
    + 'waiting for it to finish (concurrent runs against one database clobber each other, #3066). '
    + `To run in parallel instead, give this worktree its own stack: pnpm test-stack up. `
    + `To fail fast instead of waiting, set ${LOCK_NOWAIT_ENV}=1.`,
  );
  await client`SELECT pg_advisory_lock(${INTEGRATION_LOCK_NS}, ${INTEGRATION_LOCK_KEY})`;
  console.warn('[integration global-setup] Lock acquired — the other run finished; continuing.');
}

export async function releaseIntegrationRunLock(client: Sql): Promise<void> {
  const [{ unlocked }] = await client<[{ unlocked: boolean }]>`
    SELECT pg_advisory_unlock(${INTEGRATION_LOCK_NS}, ${INTEGRATION_LOCK_KEY}) AS unlocked
  `;
  if (!unlocked) {
    // `false` means THIS session didn't hold the lock — i.e. the lock
    // connection was recycled/dropped mid-run and the mutex silently expired,
    // so a concurrent session could have barged in. Don't fail the (already
    // finished) run, but say it loudly: if this run saw weird failures, this
    // is why.
    console.warn(
      '[integration global-setup] pg_advisory_unlock returned false — the run lock was NOT held at teardown. '
      + 'The lock connection must have been dropped mid-run, so cross-session exclusion was not guaranteed for this run.',
    );
  }
}
