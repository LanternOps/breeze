import { z } from 'zod';

export const ML_FEEDBACK_METADATA_MAX_BYTES = 8192;

export const ML_FEEDBACK_SOURCE_TYPES = [
  'alert',
  'ticket',
  'device',
  'anomaly',
  'correlation',
  'rca',
  'remediation',
  'user_risk',
] as const;

export const ML_FEEDBACK_EVENT_TYPES = [
  'alert.acknowledged',
  'alert.resolved',
  'alert.suppressed',
  'alert.dismissed',
  'alert.reopened',
  'correlation.accepted',
  'correlation.split',
  'correlation.merged',
  'correlation.dismissed',
  'anomaly.dismissed',
  'anomaly.promoted',
  'anomaly.resolved',
  'rca.helpful',
  'rca.not_helpful',
  'rca.edited',
  'rca.used_in_ticket',
  'suggestion.accepted',
  'suggestion.edited',
  'suggestion.rejected',
  'suggestion.executed',
  'suggestion.failed',
  'ticket.category_changed',
  'ticket.priority_changed',
  'ticket.assignee_changed',
  'ticket.triage_rejected',
  'ticket.resolved',
  'ticket.reopened',
  'device.failure_confirmed',
  'device.replaced',
  'device.false_alarm',
  'user_risk.true_positive',
  'user_risk.false_positive',
  'training.assigned',
  'training.completed',
] as const;

export const ML_FEEDBACK_OUTCOMES = [
  'acknowledged',
  'resolved',
  'suppressed',
  'dismissed',
  'reopened',
  'promoted',
  'accepted',
  'split',
  'merged',
  'helpful',
  'not_helpful',
  'edited',
  'used_in_ticket',
  'rejected',
  'executed',
  'failed',
  'category_changed',
  'priority_changed',
  'assignee_changed',
  'failure_confirmed',
  'replaced',
  'false_alarm',
  'true_positive',
  'false_positive',
  'assigned',
  'completed',
] as const;

export type MlFeedbackEventSourceType = typeof ML_FEEDBACK_SOURCE_TYPES[number];
export type MlFeedbackEventType = typeof ML_FEEDBACK_EVENT_TYPES[number];
export type MlFeedbackEventOutcome = typeof ML_FEEDBACK_OUTCOMES[number];

export function getJsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return 0;
  return new TextEncoder().encode(encoded).length;
}

export const mlFeedbackMetadataSchema = z.record(z.string(), z.unknown()).refine(
  (value) => getJsonByteLength(value) <= ML_FEEDBACK_METADATA_MAX_BYTES,
  `metadata must be ${ML_FEEDBACK_METADATA_MAX_BYTES} bytes or less`,
);

export const mlFeedbackEventSchema = z.object({
  // `.guid()` (lenient) rather than `.uuid()` (strict-RFC): Zod v4's strict UUID
  // check can reject the all-zero nil sentinel `00000000-0000-0000-0000-000000000000`
  // across minor versions. orgId is always a real tenant UUID and actorUserId is
  // normalized to null for system actors (see actorUserIdOrNull in
  // mlFeedbackEmitters.ts), but emitting a nil sentinel must never be silently
  // 400-rejected here. `.guid()` accepts any well-formed UUID-shaped string.
  orgId: z.string().guid(),
  sourceType: z.enum(ML_FEEDBACK_SOURCE_TYPES),
  sourceId: z.string().min(1).max(255),
  eventType: z.enum(ML_FEEDBACK_EVENT_TYPES),
  dedupeKey: z.string().trim().min(1).max(255).nullable().optional(),
  actorUserId: z.string().guid().nullable().optional(),
  outcome: z.enum(ML_FEEDBACK_OUTCOMES),
  confidence: z.number().min(0).max(1).nullable().optional(),
  metadata: mlFeedbackMetadataSchema.default({}),
  occurredAt: z.coerce.date().default(() => new Date()),
});

export type MlFeedbackEventInput = z.input<typeof mlFeedbackEventSchema>;
export type MlFeedbackEvent = z.output<typeof mlFeedbackEventSchema>;
