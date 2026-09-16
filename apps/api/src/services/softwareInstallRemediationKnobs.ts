/**
 * Env knobs for install remediation (feature #5505, contract D5).
 *
 * RESOLVED PER CALL, DELIBERATELY. Do NOT hoist any of these into
 * `export const X = resolveX()`: that is the defect BACKUP_GC_GRACE_MS shipped
 * (apps/api/src/jobs/backupRetention.ts), where the value froze at module
 * load and an operator setting the variable saw no effect at all. Both
 * resolvers below are cheap (one process.env read plus a Number cast) and run
 * at most twice per compliance pass, so there is nothing to optimise.
 *
 * FLOORS APPLY IN EVERY ENVIRONMENT, unlike BACKUP_GC_GRACE_MS's
 * production-only floor. A value below 1 is not a "risky but valid lab
 * setting" for either knob — it is a silent feature kill: 0 installs per pass
 * means the feature appears armed and never acts, and 0 attempts means every
 * device goes straight to 'gave_up'. Both would look like a product bug, not a
 * configuration choice, so they are clamped everywhere.
 */

const MAX_PER_PASS_ENV = 'SOFTWARE_INSTALL_REMEDIATION_MAX_PER_PASS';
const MAX_PER_PASS_DEFAULT = 50;

const MAX_ATTEMPTS_ENV = 'SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS';
const MAX_ATTEMPTS_DEFAULT = 3;

const KNOB_FLOOR = 1;

function resolveCountKnob(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim() === '') return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(
      `[SoftwareInstallRemediation] Ignoring ${envKey}=${JSON.stringify(raw)} (not a finite number); using default ${defaultValue}`,
    );
    return defaultValue;
  }

  const floored = Math.floor(parsed);
  if (floored < KNOB_FLOOR) {
    console.warn(
      `[SoftwareInstallRemediation] ${envKey}=${parsed} is below the floor of ${KNOB_FLOOR}; using ${KNOB_FLOOR} instead`,
    );
    return KNOB_FLOOR;
  }

  if (floored !== defaultValue) {
    console.warn(`[SoftwareInstallRemediation] ${envKey} override active: ${floored} (default ${defaultValue})`);
  }
  return floored;
}

/**
 * Maximum install jobs queued for ONE policy in ONE compliance pass.
 *
 * Spec Risks §2: arming autoInstall on an existing broad policy could otherwise
 * queue thousands of installs in a single 15-minute pass. Devices over the cap
 * are recorded 'skipped' and picked up by the next pass — they are deferred,
 * never dropped, and never burn an attempt from the give-up budget.
 */
export function resolveInstallRemediationMaxPerPass(): number {
  return resolveCountKnob(MAX_PER_PASS_ENV, MAX_PER_PASS_DEFAULT);
}

/**
 * CONSECUTIVE install attempts for one (policy, device) before giving up.
 *
 * Spec Risks §1: a policy whose rule never matches what the installer registers
 * in Add/Remove Programs re-detects `missing` forever. Grace and cooldown bound
 * the rate of that loop but do not stop it; this counter does, by writing
 * install_remediation_status = 'gave_up'. The counter resets to 0 the moment
 * the device has no `missing` violation left for that policy.
 */
export function resolveInstallRemediationMaxAttempts(): number {
  return resolveCountKnob(MAX_ATTEMPTS_ENV, MAX_ATTEMPTS_DEFAULT);
}
