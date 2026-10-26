/**
 * The security_scan command payload (#6263 W01–W05). A leaf module so the scan
 * route, the claim and the AI tool share one builder without importing the
 * claim's or the pump's dependency graph.
 */
import type { SecurityScanSettings, YaraRuleSetRef } from '@breeze/shared';

/**
 * The ONLY place a security_scan command payload is built. `settings === null`
 * means no policy governs the device: the agent's built-in defaults apply and
 * nothing is auto-quarantined. `ruleSets` (W02 §C1) is emitted only when
 * non-empty, so a legacy scan's payload is byte-identical to W01's.
 *
 * #6263 W05: `triggerDefender` (default true, the W01 behaviour) and
 * `detectOnly`, which forces `autoQuarantine: false` onto the wire even when no
 * policy governs the device — a sweep is detect-only whatever the agent's
 * defaults are.
 */
export function buildSecurityScanPayload(
  scanRecordId: string,
  scanType: string,
  settings: SecurityScanSettings | null,
  paths?: string[],
  ruleSets?: readonly YaraRuleSetRef[],
  opts: { triggerDefender?: boolean; detectOnly?: boolean } = {},
): Record<string, unknown> {
  return {
    scanRecordId,
    scanType,
    ...(paths && paths.length > 0 ? { paths } : {}),
    triggerDefender: opts.triggerDefender ?? true,
    ...(settings
      ? {
          exclusions: settings.exclusions,
          maxFileSizeMb: settings.maxFileSizeMb,
          timeoutMinutes: settings.scanTimeoutMinutes,
          autoQuarantine: opts.detectOnly ? false : settings.autoQuarantine,
        }
      : opts.detectOnly
        ? { autoQuarantine: false }
        : {}),
    ...(ruleSets && ruleSets.length > 0
      ? { ruleSets: ruleSets.map((r) => ({ id: r.id, version: r.version, sha256: r.sha256, url: r.url })) }
      : {}),
  };
}
