/**
 * `organizations.settings` keys the LIFECYCLE ENGINE owns, not the tenant.
 *
 * `settings` is a client-writable `z.any()` blob on both the org create and the
 * org update routes, and the update writes the column WHOLESALE (the payload
 * replaces the stored value). Wave 2 and Wave 4 then quietly started storing
 * engine state in that same blob — the pre-fence/pre-archive status a restore
 * reads back, the purge-warning claim markers, and the purging-recovery attempt
 * counter that a fleet-wide sweep CASTS TO INT.
 *
 * That makes every one of them attacker- (or accident-) controlled through an
 * ordinary PATCH, which is a genuinely bad shape for a counter the sweep casts:
 * a preseeded value can neutralize a retry ceiling, and a preseeded *type* used
 * to be able to abort the whole sweep snapshot. The counter's own SQL is
 * type-guarded and clamped independently (see tenantOffboarding.ts) — this list
 * is the other half: the engine's keys are stripped from anything a client
 * supplies, so they can only ever be written by the engine itself.
 *
 * Keys are imported from their owning modules rather than re-declared, so a
 * rename reddens this list instead of silently un-protecting a key.
 */
import { ARCHIVE_PRIOR_STATUS_KEY } from './orgArchive';
import { MERGE_PRIOR_STATUS_KEY } from './orgMerge';
import {
  ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
  ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
  ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
} from './tenantOffboarding';

export const ORG_LIFECYCLE_INTERNAL_SETTINGS_KEYS: readonly string[] = [
  ARCHIVE_PRIOR_STATUS_KEY,
  ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
  ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
  ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
  MERGE_PRIOR_STATUS_KEY,
];

/**
 * Drop every engine-owned key from a client-supplied `settings` payload.
 *
 * Returns the value unchanged when it is not a plain object (the column is
 * `z.any()`, so a client can send a string, an array or null) — validating the
 * blob's shape is not this function's job, only removing keys from it.
 * Non-mutating: the caller's parsed body is left alone.
 */
export function stripOrgLifecycleInternalSettings(settings: unknown): unknown {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return settings;
  }
  const source = settings as Record<string, unknown>;
  if (!ORG_LIFECYCLE_INTERNAL_SETTINGS_KEYS.some((key) => key in source)) {
    return settings;
  }
  const stripped: Record<string, unknown> = { ...source };
  for (const key of ORG_LIFECYCLE_INTERNAL_SETTINGS_KEYS) delete stripped[key];
  return stripped;
}
