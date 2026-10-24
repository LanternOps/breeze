/**
 * Operator env knobs for IOC scans and sweeps (#6263 W01, W05). Env-only, read
 * per call so a test (or a restart with a new value) sees the current value;
 * none of these is a user-facing setting.
 *
 * `parsePositiveIntEnv` moved here from jobs/securityScanJobs.ts so the sweep
 * service, claim and pump share one definition with the W01 scan caps.
 */
import {
  IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD,
  SECURITY_SWEEP_MAX_DEVICES_DEFAULT,
  SECURITY_SWEEP_MFA_DEVICE_THRESHOLD,
  SECURITY_SWEEP_TTL_HOURS_DEFAULT,
  SECURITY_SWEEP_TTL_HOURS_MAX,
  SECURITY_SCAN_TIMEOUT_MINUTES_RANGE,
} from '@breeze/shared';

/** A positive integer from the environment; absent, empty, zero, negative or junk → the default. */
export function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

/** Eligible devices per sweep request, across orgs. */
export const sweepMaxDevices = (): number =>
  parsePositiveIntEnv('SECURITY_SWEEP_MAX_DEVICES', SECURITY_SWEEP_MAX_DEVICES_DEFAULT);
/** Sweeps in state `active` per org. */
export const sweepMaxActivePerOrg = (): number => parsePositiveIntEnv('SECURITY_SWEEP_MAX_ACTIVE_PER_ORG', 5);
/** Pump cadence: `SECURITY_SWEEP_PUMP_INTERVAL_MS`, read in jobs/securityScanJobs.ts (the schedule registry needs it static). */
/** Scans admitted per sweep per org per pump tick. */
export const sweepPumpBatch = (): number => parsePositiveIntEnv('SECURITY_SWEEP_PUMP_BATCH', 100);
/** `running` scans across a partner's orgs, all origins. */
export const sweepPartnerRunningCap = (): number => parsePositiveIntEnv('SECURITY_SWEEP_PARTNER_RUNNING_CAP', 200);
/** Default sweep lifetime; clamped to the request maximum. */
export const sweepTtlHoursDefault = (): number =>
  Math.min(parsePositiveIntEnv('SECURITY_SWEEP_TTL_HOURS_DEFAULT', SECURITY_SWEEP_TTL_HOURS_DEFAULT), SECURITY_SWEEP_TTL_HOURS_MAX);
/** Human creates above this many devices need an interactive session with satisfied MFA. */
export const sweepMfaDeviceThreshold = (): number =>
  parsePositiveIntEnv('SECURITY_SWEEP_MFA_DEVICE_THRESHOLD', SECURITY_SWEEP_MFA_DEVICE_THRESHOLD);
/** Finalize grace beyond the 720-minute scan-timeout ceiling. */
export const sweepRunningGraceMinutes = (): number => parsePositiveIntEnv('SECURITY_SWEEP_RUNNING_GRACE_MINUTES', 65);
/** AI sweeps above this many expected devices need a second approver (W05 PR B). */
export const iocHuntFourEyesDeviceThreshold = (): number =>
  parsePositiveIntEnv('IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD', IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD);

/** The agent's longest scan deadline (the policy `scanTimeoutMinutes` ceiling, 720). */
export const SECURITY_SCAN_TIMEOUT_CEILING_MINUTES = SECURITY_SCAN_TIMEOUT_MINUTES_RANGE[1];
