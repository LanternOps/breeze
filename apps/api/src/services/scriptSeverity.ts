/**
 * Script exit-code severity mapping (Feature #3)
 *
 * Translates a script execution's exit code into an alert severity (or
 * null = no alert) based on an opt-in per-script mapping.
 *
 * Convention documented for techs:
 *   Exit 0         -> no alert
 *   Exit 1         -> info / low
 *   Exit 2         -> medium (warning)
 *   Exit 3         -> high (alert)
 *   Exit 4         -> critical (urgent)
 *   Exit 5+        -> falls back to highest-defined-lower severity, OR
 *                     'medium' if no lower code is defined
 *   Negative codes -> 'critical' (abnormal termination, e.g. SIGKILL = -9
 *                     on Unix; PowerShell/cmd return non-negative codes)
 *
 * The mapping is per-script and stored as JSONB on
 * `scripts.exit_code_severity_mapping`. Keys are non-negative integer
 * strings; values are an AlertSeverity literal or null.
 *
 * When the mapping is NULL or `{}` (empty), legacy behavior is preserved:
 *   exit 0 = ok (null), any non-zero = 'medium' (matches the previous
 *   "create alert at default severity on non-zero" path). Treating `{}`
 *   identically to null is important for the UI clear-all-rows path —
 *   otherwise a user clearing every row would silently escalate every
 *   non-zero exit to critical. (See #798 review.)
 *
 * Wire-format validator: `exitCodeSeverityMappingSchema` in @breeze/shared.
 */

import type { AlertSeverity } from '@breeze/shared';
import type { ScriptExitCodeSeverityMapping } from '../db/schema/scripts';

export type { ScriptExitCodeSeverityMapping };

/**
 * Derive the alert severity (or null = no alert) for a script execution.
 *
 * @param exitCode - The script's exit code. `null`/`undefined` is treated as 0 (success).
 *                   Negative codes are interpreted as abnormal termination → 'critical'.
 * @param mapping  - Per-script override mapping, or null for legacy behavior.
 *                   An empty object `{}` is treated identically to null.
 * @returns AlertSeverity to use, or null if no alert should be raised.
 */
export function deriveSeverityFromScript(
  exitCode: number | null | undefined,
  mapping: ScriptExitCodeSeverityMapping | null | undefined
): AlertSeverity | null {
  // Normalize NaN / Infinity / nullish to 0; keep finite negative codes
  // intact so they can be handled explicitly below.
  const code = typeof exitCode === 'number' && Number.isFinite(exitCode) ? exitCode : 0;

  // Negative exit codes mean the process did not exit normally (Unix
  // signal kill: SIGKILL = -9, SIGSEGV = -11, etc.). Treat as critical
  // regardless of mapping — abnormal termination is always alert-worthy,
  // and ints in the mapping cannot match a negative code anyway.
  if (code < 0) {
    return 'critical';
  }

  // Treat an empty mapping object identically to null. A UI that lets the
  // user clear all rows yields `{}`, and we don't want that to silently
  // escalate every non-zero exit to critical via the no-lower-defined-code
  // fallback. (See #798 review.)
  const effectiveMapping =
    mapping && typeof mapping === 'object' && Object.keys(mapping).length > 0
      ? mapping
      : null;

  // Legacy: no opt-in mapping. Non-zero exit creates an alert at the
  // default 'medium' severity; exit 0 is silent.
  if (!effectiveMapping) {
    return code === 0 ? null : 'medium';
  }

  const key = String(code);
  if (key in effectiveMapping) {
    return effectiveMapping[key] ?? null;
  }

  // Mapping is set but did not list 0: treat as silent (do not alert).
  if (code === 0) {
    return null;
  }

  // Fallback: pick the entry for the next-lower defined exit code, so an
  // exit of 7 with mapping defined up to 4 still escalates to whatever 4
  // specified (typically 'critical').
  const definedCodes = Object.keys(effectiveMapping)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n >= 0 && n < code)
    .sort((a, b) => b - a); // descending

  for (const lowerCode of definedCodes) {
    const sev = effectiveMapping[String(lowerCode)];
    if (sev) return sev;
  }

  // No lower defined code (or all lower codes mapped to null). Fall back
  // to 'medium' rather than 'critical' — the user explicitly mapped
  // specific codes, so unmapped ones should not auto-escalate beyond what
  // they configured. This matches Tactical RMM's "don't escalate unmapped
  // codes" convention and the legacy non-zero default. (See #798 review.)
  return 'medium';
}
