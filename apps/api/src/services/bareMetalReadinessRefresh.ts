// Bare-metal W08: a rebuild just settled (completed / checked in / failed) —
// refresh the device's recovery readiness so the new evidence shows without
// waiting for the next verification. Best-effort and fire-and-forget: a
// readiness error must never fail the recovery state write that already
// committed.
//
// The callers run inside a request/agent DB transaction. The refresh is
// deferred until that transaction has COMMITTED (and runs outside it), so it
// sees the settled row and does not join the caller's org-scoped context.
// The calculator is loaded lazily so recovery routes and the heartbeat do not
// pull the verification/readiness dependency tree at import.
import { runAfterDbContextCommit } from '../db';

/** The refresh itself; resolves once done and never rejects. Exported for tests. */
export function runReadinessRefresh(orgId: string, deviceId: string): Promise<void> {
  return import('../routes/backup/readinessCalculator')
    .then((m) => m.recomputeRecoveryReadinessForDevice(orgId, deviceId))
    .then(() => undefined)
    .catch((error) => {
      console.warn(
        `[BackupReadiness] Post-recovery readiness refresh failed (org ${orgId}, device ${deviceId}):`,
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
    });
}

export function refreshReadinessAfterRecovery(orgId: string, deviceId: string): void {
  runAfterDbContextCommit('bare-metal-readiness-refresh', () => runReadinessRefresh(orgId, deviceId));
}
