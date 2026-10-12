// Bare-metal W08: a rebuild just settled (completed / checked in / failed) —
// refresh the device's recovery readiness so the new evidence shows without
// waiting for the next verification. Best-effort and fire-and-forget: a
// readiness error must never fail the recovery state write that already
// committed. The calculator is loaded lazily so recovery routes and the
// heartbeat do not pull the verification/readiness dependency tree at import.
export function refreshReadinessAfterRecovery(orgId: string, deviceId: string): Promise<void> {
  // Callers fire-and-forget; the returned promise never rejects.
  return import('../routes/backup/readinessCalculator')
    .then((m) => m.recomputeRecoveryReadinessForDevice(orgId, deviceId))
    .then(() => undefined)
    .catch((error) => {
      console.warn('[BackupReadiness] Post-recovery readiness refresh failed:', error instanceof Error ? error.message : error);
    });
}
