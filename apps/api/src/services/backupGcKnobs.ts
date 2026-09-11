/**
 * Shared per-run env-knob resolver for backup GC/retention timing constants.
 *
 * D18 (#5429): backupRetention.ts's existing BACKUP_GC_GRACE_MS is resolved
 * once at module load (`export const BACKUP_GC_GRACE_MS = resolve...()`),
 * so an env var change requires a process restart to take effect — a defect
 * called out in the design doc's ground truth. Every knob added here (and
 * every existing one W02 migrates here) is resolved FRESH on each call —
 * never captured into a module-level `const`.
 */
function resolveMsKnob(envVarName: string, defaultMs: number, floorMs: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[BackupGcKnobs] Ignoring ${envVarName}=${JSON.stringify(raw)} (not a positive number); using default ${defaultMs} ms`,
    );
    return defaultMs;
  }
  if (process.env.NODE_ENV === 'production' && n < floorMs) {
    console.warn(
      `[BackupGcKnobs] ${envVarName}=${n} is below the production floor; using ${floorMs} ms instead`,
    );
    return floorMs;
  }
  if (n !== defaultMs) {
    console.warn(`[BackupGcKnobs] ${envVarName} override active: ${n} ms (default ${defaultMs} ms)`);
  }
  return n;
}

export { resolveMsKnob };

/**
 * How long a base-snapshot pin (backup_jobs.base_snapshot_id) stays valid
 * after dispatch. Matches the agent's journal max-age (7 days) — a run
 * longer than this cannot resume anyway, so "must publish within the lease"
 * is the existing envelope made explicit (spec §3.1, §8 decision 2).
 */
export const BACKUP_BASE_LEASE_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;
const BACKUP_BASE_LEASE_MS_PRODUCTION_FLOOR = 60 * 60 * 1000;
export function resolveBackupBaseLeaseMs(): number {
  return resolveMsKnob('BACKUP_BASE_LEASE_MS', BACKUP_BASE_LEASE_MS_DEFAULT, BACKUP_BASE_LEASE_MS_PRODUCTION_FLOOR);
}

/**
 * How long a restore_jobs row keeps pinning its snapshot AFTER creation,
 * covering commandless/crashed restores (never reach a terminal status until
 * staleCommandReaper's own 1h rule fires) and helpers that keep reading past
 * the server's restore timeout.
 */
export const BACKUP_RESTORE_PIN_LINGER_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;
const BACKUP_RESTORE_PIN_LINGER_MS_PRODUCTION_FLOOR = 60 * 60 * 1000;
export function resolveBackupRestorePinLingerMs(): number {
  return resolveMsKnob(
    'BACKUP_RESTORE_PIN_LINGER_MS',
    BACKUP_RESTORE_PIN_LINGER_MS_DEFAULT,
    BACKUP_RESTORE_PIN_LINGER_MS_PRODUCTION_FLOOR,
  );
}

/**
 * Grace window added on top of publish_lease_expires_at before retention
 * treats a base pin as released (spec §3.1: "the margin is what turns the
 * pre-PUT check into a fence — the server keeps the pin for lease + margin,
 * so a PUT that starts inside the margin completes before the pin lapses").
 */
export const BACKUP_PUBLISH_MARGIN_MS_DEFAULT = 60 * 60 * 1000;
const BACKUP_PUBLISH_MARGIN_MS_PRODUCTION_FLOOR = 5 * 60 * 1000;
export function resolveBackupPublishMarginMs(): number {
  return resolveMsKnob(
    'BACKUP_PUBLISH_MARGIN_MS',
    BACKUP_PUBLISH_MARGIN_MS_DEFAULT,
    BACKUP_PUBLISH_MARGIN_MS_PRODUCTION_FLOOR,
  );
}
