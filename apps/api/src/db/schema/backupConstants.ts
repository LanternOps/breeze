/**
 * Backup schema constants that non-schema code needs to import directly.
 *
 * These live in their own leaf module rather than in `backup.ts` because the
 * `../db/schema` barrel is `vi.mock`'d with a hand-written factory in dozens of
 * suites: a new named export there breaks every one of them at import time,
 * which pushes callers toward hand-copying the value instead — exactly the
 * drift this file exists to prevent. Nothing mocks this path, so both the
 * column definition and its validators can share one source of truth.
 */

/**
 * Width of the agent-supplied provider snapshot id, shared by
 * `backup_jobs.snapshot_id` and `backup_snapshots.snapshot_id`.
 *
 * The mid-run registration validator (services/backupProgress.ts, #3006) is
 * derived from this so widening the column cannot leave a stricter validator
 * silently rejecting ids the database would happily store.
 */
export const BACKUP_SNAPSHOT_ID_MAX_LENGTH = 200;
