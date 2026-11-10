/**
 * One path for "a winning config-policy link's stored settings failed the
 * strict schema, so the resolver fell back to platform defaults" (#8585).
 *
 * Resolvers run per device / per command, so an invalid link would otherwise
 * log one warning per resolution and leave no durable trace. This dedupes the
 * warning per (org, feature, link) for a window and journals the first
 * occurrence to the audit log, so the bad row is findable after the log line
 * has scrolled away. Fail-open resolvers stay fail-open: nothing here throws.
 */

import { createAuditLogAsync } from './auditService';
import { runOutsideAuditRequestTracking } from './auditRequestTracking';

const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED = 5_000;

const lastReportedAt = new Map<string, number>();

export interface InvalidStoredSettingsReport {
  /** Feature type, e.g. 'system_protection', 'containment'. */
  feature: string;
  orgId: string;
  deviceId: string;
  featureLinkId: string;
  sourcePolicyId: string | null;
  /** Schema issue PATHS only: zod messages can echo rejected values or key names. */
  issues: string[];
}

export function reportInvalidStoredSettings(report: InvalidStoredSettingsReport): void {
  const now = Date.now();
  const key = `${report.orgId}|${report.feature}|${report.featureLinkId}`;
  const last = lastReportedAt.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;

  if (lastReportedAt.size >= MAX_TRACKED) {
    for (const [k, at] of lastReportedAt) {
      if (now - at >= DEDUPE_WINDOW_MS) lastReportedAt.delete(k);
    }
    if (lastReportedAt.size >= MAX_TRACKED) lastReportedAt.clear();
  }
  lastReportedAt.set(key, now);

  console.warn(
    `[featureConfigResolver] Malformed ${report.feature} settings; using platform defaults`,
    {
      deviceId: report.deviceId,
      featureLinkId: report.featureLinkId,
      sourcePolicyId: report.sourcePolicyId,
      issues: report.issues,
    },
  );

  void Promise.resolve()
    .then(() =>
      runOutsideAuditRequestTracking(() => createAuditLogAsync({
        orgId: report.orgId,
        actorType: 'system',
        actorId: '00000000-0000-0000-0000-000000000000',
        action: 'config_policy.invalid_stored_settings',
        resourceType: 'config_policy_feature_link',
        resourceId: report.featureLinkId,
        result: 'failure',
        details: {
          feature: report.feature,
          sourcePolicyId: report.sourcePolicyId,
          deviceId: report.deviceId,
          issues: report.issues,
        },
      })),
    )
    .catch((err) => {
      console.error('[featureConfigResolver] Failed to journal invalid stored settings', {
        feature: report.feature,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export function resetInvalidStoredSettingsReportsForTest(): void {
  lastReportedAt.clear();
}
