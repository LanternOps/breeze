/**
 * Input schemas for the W07 alert correlation + signal-triage tools (full-control
 * W07, #6777): `get_alert_correlations`, `manage_alert_correlations`,
 * `manage_device_anomalies`, `reliability_feedback`, and the extra `get_fleet_health`
 * actions. Plain strict `z.object`s with an `action` enum (no unions or refined
 * schemas) so `toolActionEnum` can read `.shape.action.options` and the chat SDK
 * `tool()` declarations can take `.shape` directly (`inputShape()` in
 * aiAgentSdkTools.ts). Per-action required fields are enforced in the handlers
 * through the SAME shared validators the REST routes use. No `z.undefined()`
 * anywhere: it empties the model's tool list.
 *
 * Keys, enums and page parameters mirror each tool's registry `input_schema`
 * one-for-one; aiToolSchemas.alertTriage.test.ts pins that.
 */
import { z } from 'zod';
import { pageZodShape } from './aiToolPagination';

// The action vocabularies live here (a light module) so the schema graph never
// pulls in the db-bound handlers.
export const ALERT_CORRELATION_READ_ACTIONS = [
  'groups', 'get', 'by_alert', 'links', 'analyze', 'evaluation', 'explain',
] as const;
export const ALERT_CORRELATION_WRITE_ACTIONS = [
  'acknowledge_group', 'resolve_group', 'acknowledge_related', 'feedback', 'rca_feedback',
] as const;
export const DEVICE_ANOMALY_ACTIONS = ['list', 'dismiss', 'resolve', 'promote'] as const;
export const FLEET_HEALTH_ACTIONS = ['list', 'history', 'offenders', 'evaluation', 'org_summary'] as const;

/** `correlation.*` and `rca.*` outcomes, as one vocabulary: the handler pairs the action with the right family. */
export const CORRELATION_FEEDBACK_OUTCOMES = ['split', 'merged', 'dismissed'] as const;
export const RCA_FEEDBACK_OUTCOMES = ['helpful', 'not_helpful', 'edited', 'used_in_ticket'] as const;
export const RELIABILITY_FEEDBACK_OUTCOMES = ['failure_confirmed', 'replaced', 'false_alarm'] as const;
export const ANOMALY_LIST_STATUSES = ['open', 'dismissed', 'promoted', 'resolved', 'cleared', 'all'] as const;

const uuid = z.string().guid();

export const alertTriageToolShapes = {
  get_alert_correlations: {
    action: z.enum(ALERT_CORRELATION_READ_ACTIONS),
    orgId: uuid.optional(),
    groupId: uuid.optional(),
    alertId: uuid.optional(),
    alertIds: z.array(uuid).max(100).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    windowMinutes: z.number().int().min(5).max(1440).optional(),
    windowHours: z.number().int().min(1).max(24).optional(),
    maxEvidenceItems: z.number().int().min(5).max(100).optional(),
    labelWindowDays: z.number().int().min(1).max(365).optional(),
    ...pageZodShape(10, 50),
  },
  manage_alert_correlations: {
    action: z.enum(ALERT_CORRELATION_WRITE_ACTIONS),
    groupId: uuid.optional(),
    alertId: uuid.optional(),
    outcome: z.enum([...CORRELATION_FEEDBACK_OUTCOMES, ...RCA_FEEDBACK_OUTCOMES]).optional(),
    alertIds: z.array(uuid).max(100).optional(),
    targetGroupId: uuid.optional(),
    note: z.string().trim().max(1000).optional(),
  },
  manage_device_anomalies: {
    action: z.enum(DEVICE_ANOMALY_ACTIONS),
    deviceId: uuid,
    anomalyId: uuid.optional(),
    status: z.enum(ANOMALY_LIST_STATUSES).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    note: z.string().max(500).optional(),
  },
  reliability_feedback: {
    deviceId: uuid,
    outcome: z.enum(RELIABILITY_FEEDBACK_OUTCOMES),
    occurredAt: z.string().datetime().optional(),
    sourceEventId: uuid.optional(),
    snapshotComputedAt: z.string().datetime().optional(),
  },
} as const;

/** The extra `get_fleet_health` parameters (merged with the existing list filters in aiToolSchemas.ts). */
export const fleetHealthActionShape = {
  action: z.enum(FLEET_HEALTH_ACTIONS).optional(),
  deviceId: uuid.optional(),
  days: z.number().int().min(1).max(365).optional(),
  topN: z.number().int().min(1).max(20).optional(),
  atRiskMaxScore: z.number().int().min(0).max(100).optional(),
  labelWindowDays: z.number().int().min(1).max(365).optional(),
} as const;

export const alertTriageToolSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(alertTriageToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]),
);
