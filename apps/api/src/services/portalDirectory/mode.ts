/**
 * Report or enforce (portal registration W8 #11385, plan D7).
 *
 * `PORTAL_DIRECTORY_DEPROVISION_ENFORCE` follows the retention `*_ENFORCE`
 * pattern (jobs/retentionBatch.ts `retentionEnforceFromEnv`): `true` / `1`
 * enforce, unset / empty / `false` / `0` report, and any other value reports
 * with a warning — an ambiguous value fails toward report-only. Read on every
 * call, so unsetting it takes effect without a restart; the warning for an
 * invalid value is printed once per distinct value, not once per run.
 *
 * A job payload can force report mode (`forceReport`), never enforce: nothing
 * else decides the mode.
 */
import { retentionEnforceFromEnv } from '../../jobs/retentionBatch';

const LOG_PREFIX = '[portal-directory]';
const ENFORCE_ENV = 'PORTAL_DIRECTORY_DEPROVISION_ENFORCE';

let lastRaw: string | undefined;
let lastValue = false;
let hasLast = false;

export function isDirectoryDeprovisionEnforced(): boolean {
  const raw = process.env[ENFORCE_ENV];
  if (hasLast && raw === lastRaw) return lastValue;
  const value = retentionEnforceFromEnv(LOG_PREFIX, 'PORTAL_DIRECTORY_DEPROVISION_ENFORCE', false);
  lastRaw = raw;
  lastValue = value;
  hasLast = true;
  return value;
}

export function directoryMode(forceReport = false): 'report' | 'enforce' {
  return !forceReport && isDirectoryDeprovisionEnforced() ? 'enforce' : 'report';
}

export function __resetDirectoryModeWarningsForTests(): void {
  lastRaw = undefined;
  lastValue = false;
  hasLast = false;
}
