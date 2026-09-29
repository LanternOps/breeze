/**
 * Monitor kinds whose conditions report per-subject evidence
 * (`EvaluationResult.subjects`) and therefore run through the subject alert
 * path in `evaluateDeviceAlerts` instead of the legacy device-level block.
 *
 * Every consumer that special-cases the subject path keys off this list, so a
 * new subject kind is one edit here:
 *  - maintenance suppression lets these kinds evaluate recovery
 *    (`alertService.evaluateDeviceAlerts`);
 *  - recurrence escalation alerts for these kinds are staged by the subject
 *    outbox (`subjectAlertOutbox.stagePendingSubjectEscalations`), because
 *    the subject path never calls `fireEscalationLatch`.
 */
export const SUBJECT_MONITOR_KINDS = ['hardware_health', 'time_sync'] as const;

export type SubjectMonitorKind = (typeof SUBJECT_MONITOR_KINDS)[number];

export function isSubjectMonitorKind(kind: string | null | undefined): kind is SubjectMonitorKind {
  return kind != null && (SUBJECT_MONITOR_KINDS as readonly string[]).includes(kind);
}
