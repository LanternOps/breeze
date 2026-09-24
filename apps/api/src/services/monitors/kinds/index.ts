import type { MonitorKind } from '@breeze/shared';
import { MonitorValidationError } from './types';
import type { MonitorKindSpec } from './types';
import { cpuKind } from './cpu';
import { memoryKind } from './memory';
import { diskKind } from './disk';
import { offlineKind } from './offline';
import { eventLogKind } from './eventLog';
import { patchComplianceKind } from './patchCompliance';
import { serviceKind } from './service';
import { processKind } from './process';
import { processResourceKind } from './processResource';
import { certExpiryKind } from './certExpiry';
import { bandwidthKind } from './bandwidth';
import { diskIoKind } from './diskIo';
import { networkErrorsKind } from './networkErrors';
// W04 coverage (#5287 / #5291).
import { antivirusKind } from './antivirus';
import { softwarePresenceKind } from './softwarePresence';
import { backupContinuityKind } from './backupContinuity';
import { scriptKind } from './script';
import { networkCheckKind } from './networkCheck';
import { compositeKind } from './composite';
// W03 (hardware & RAID monitoring).
import { hardwareHealthKind } from './hardwareHealth';

export type { MonitorKindSpec, MonitorCompileContext } from './types';
export { MonitorValidationError } from './types';

/**
 * Every monitor kind, keyed by `MonitorKind` (from `@breeze/shared`).
 *
 * Typed as `Record<MonitorKind, MonitorKindSpec<any>>` (an explicit annotation,
 * not `as const satisfies`) on purpose: each kind file keeps its own precise
 * `C` internally, but a caller indexing this map with a *union* of kinds (a
 * `for (const kind of MONITOR_KINDS)` loop, or `MONITOR_KIND_SPECS[def.kind]`
 * off a stored row) needs one uniform `MonitorKindSpec` type back — preserving
 * per-key literal types here makes TS compute an intersection of all 13
 * `toAlertCondition` parameter types at call sites like that, which no real
 * condition satisfies.
 */
export const MONITOR_KIND_SPECS: Record<MonitorKind, MonitorKindSpec<any>> = {
  cpu: cpuKind,
  memory: memoryKind,
  disk: diskKind,
  offline: offlineKind,
  event_log: eventLogKind,
  patch_compliance: patchComplianceKind,
  service: serviceKind,
  process: processKind,
  process_resource: processResourceKind,
  cert_expiry: certExpiryKind,
  bandwidth: bandwidthKind,
  disk_io: diskIoKind,
  network_errors: networkErrorsKind,
  antivirus: antivirusKind,
  software_presence: softwarePresenceKind,
  backup_continuity: backupContinuityKind,
  script: scriptKind,
  network_check: networkCheckKind,
  // Defer the circular import read when composite.ts is the entry module.
  get composite() { return compositeKind; },
  hardware_health: hardwareHealthKind,
};

export function getMonitorKindSpec(kind: string): MonitorKindSpec {
  const spec = (MONITOR_KIND_SPECS as Record<string, MonitorKindSpec>)[kind];
  if (!spec) throw new MonitorValidationError(`unknown monitor kind: ${kind}`);
  return spec;
}

/**
 * Merges a config-policy attachment's `overrides` into a stored condition,
 * restricted to `spec.overridableKeys`, then re-validates the MERGED result
 * through the kind's own zod schema. Re-validating (rather than trusting the
 * override in isolation) is what makes an out-of-range override — e.g. a
 * `value` above the schema's max — throw instead of silently persisting an
 * invalid condition down the attachment path.
 */
export function applyOverrides<C extends Record<string, unknown>>(
  spec: MonitorKindSpec<C>,
  condition: C,
  overrides: Record<string, unknown> | null | undefined,
): C {
  if (!overrides) return condition;
  const merged: Record<string, unknown> = { ...condition };
  for (const key of spec.overridableKeys) {
    if (key in overrides) merged[key] = overrides[key];
  }
  return spec.conditionSchema.parse(merged); // zod throws on out-of-range → surfaces as 400 at the API
}
