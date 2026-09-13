import type { M365SyncDomain } from '@breeze/shared/m365';
import type { DomainPersistResult, M365SyncOutcome, PersistContext } from './types';

/**
 * SEAM — the BODY is owned by W05.
 *
 * Called once per domain immediately AFTER its completion transaction has
 * COMMITTED, with no DB context held: W05's implementation opens its own. It
 * fills this with `upsertPostureRollup` (spec §5.9) and, for `intune_devices`,
 * `reconcileDeviceLinks` (spec §5.6) — which is why it takes the full
 * `PersistContext` plus the outcome and the `DomainPersistResult`, everything
 * a rollup needs without a second read.
 *
 * Post-commit on purpose: a rollup upsert or a link-reconciliation pass inside
 * the completion transaction would hold it open for an org-wide scan, and a
 * failure in either would roll back the completion — losing `next_sync_at` and
 * re-running the whole domain next tick. run.ts therefore wraps the call in
 * try/catch and only LOGS; this function must never be relied on to throw.
 */
export async function afterDomainPersisted(
  _ctx: PersistContext & {
    domain: M365SyncDomain;
    outcome: M365SyncOutcome;
    persisted: DomainPersistResult;
  },
): Promise<void> {
  // W05.
}
