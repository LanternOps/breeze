/**
 * Script exit-code severity mapping (Feature #3)
 *
 * Translates a script execution's exit code into an alert severity (or
 * null = no alert) based on an opt-in per-script mapping.
 *
 * Convention documented for techs:
 *   Exit 0  -> no alert
 *   Exit 1  -> info / low
 *   Exit 2  -> medium (warning)
 *   Exit 3  -> high (alert)
 *   Exit 4  -> critical (urgent)
 *   Exit 5+ -> critical (legacy non-zero compat)
 *
 * The mapping is per-script and stored as JSONB on `scripts.exit_code_severity_mapping`.
 * Keys are non-negative integer strings; values are an AlertSeverity literal or null.
 *
 * When the mapping is NULL (default), legacy behavior is preserved:
 *   exit 0 = ok (null), any non-zero = 'medium' (matches the previous
 *   "create alert at default severity on non-zero" path).
 */

import type { AlertSeverity } from '@breeze/shared';
import type { ScriptExitCodeSeverityMapping } from '../db/schema/scripts';

export type { ScriptExitCodeSeverityMapping };

/**
 * Derive the alert severity (or null = no alert) for a script execution.
 *
 * @param exitCode - The script's exit code. `null`/`undefined` is treated as 0 (success).
 * @param mapping  - Per-script override mapping, or null for legacy behavior.
 * @returns AlertSeverity to use, or null if no alert should be raised.
 */
export function deriveSeverityFromScript(
  exitCode: number | null | undefined,
  mapping: ScriptExitCodeSeverityMapping | null | undefined
): AlertSeverity | null {
  const code = typeof exitCode === 'number' && Number.isFinite(exitCode) ? exitCode : 0;

  // Legacy: no opt-in mapping. Non-zero exit creates an alert at the default
  // 'medium' severity; exit 0 is silent.
  if (!mapping) {
    return code === 0 ? null : 'medium';
  }

  const key = String(code);
  if (key in mapping) {
    return mapping[key] ?? null;
  }

  // Fallback: pick the entry for the next-lower defined exit code, so that
  // an exit of 7 with mapping defined up to 4 still escalates to whatever
  // 4 specified (typically 'critical'). If no lower code is defined, default
  // to 'critical' (the highest practical severity for unmapped non-zero).
  if (code === 0) {
    // Mapping is set but did not list 0: treat as silent (do not alert).
    return null;
  }

  const definedCodes = Object.keys(mapping)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n >= 0 && n < code)
    .sort((a, b) => b - a); // descending

  for (const lowerCode of definedCodes) {
    const sev = mapping[String(lowerCode)];
    if (sev) return sev;
  }

  return 'critical';
}
