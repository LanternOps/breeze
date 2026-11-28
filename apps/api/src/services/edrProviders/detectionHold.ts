import type { EdrDetectionStatus, EdrSeverity } from '@breeze/shared';

/** Severities that publish an event / raise an alert (alerts.ts). */
export const REPORTABLE_SEVERITIES: ReadonlySet<EdrSeverity> = new Set(['critical', 'high', 'medium']);

/**
 * PURE (#12825): a detection Breeze can neither date nor call active. No vendor time, a vendor
 * status of `unknown`, a reportable severity, and nothing reportable published for it yet
 * (`notifiedSeverity` null or below medium). It raises nothing while it stays that way, and it must
 * not consume its alert, so it is HELD: stamped `notified_severity = 'unknown'` (= nothing reportable
 * published). When the vendor later calls it open or in progress, the escalation rule in
 * `decideDetection` (alerts.ts) publishes it once, however long ago Breeze first saw it: the
 * transition itself is new. Used by the notifier and by the first-sync stamp in persist.ts.
 * A row with a vendor time is never held.
 */
export function isHeldAsUnknown(row: {
  detectedAt: Date | null | undefined;
  status: EdrDetectionStatus;
  severity: EdrSeverity;
  notifiedSeverity: EdrSeverity | null;
}): boolean {
  return (row.detectedAt === null || row.detectedAt === undefined)
    && row.status === 'unknown'
    && REPORTABLE_SEVERITIES.has(row.severity)
    && (row.notifiedSeverity === null || !REPORTABLE_SEVERITIES.has(row.notifiedSeverity));
}
