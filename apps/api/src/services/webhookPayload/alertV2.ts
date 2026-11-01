import { z } from 'zod';

export const ALERT_V2_EVENT_TYPES = ['alert.triggered', 'alert.acknowledged', 'alert.resolved', 'alert.suppressed', 'alert.escalated'] as const;
export type AlertV2EventType = typeof ALERT_V2_EVENT_TYPES[number];

export function isAlertV2EventType(type: string): type is AlertV2EventType {
  return (ALERT_V2_EVENT_TYPES as readonly string[]).includes(type);
}

const nullableString = z.string().nullable();
const nullableTimestamp = z.string().datetime({ offset: true }).nullable();
const ownerKind = z.enum(['device', 'topology_site', 'backup_workload']);

/** Every top-level key is part of the stable v2 contract, including nulls. */
export const alertWebhookDataV2Schema = z.object({
  alertId: nullableString,
  ruleId: nullableString,
  monitorId: nullableString,
  deviceId: nullableString,
  owner: z.object({ kind: ownerKind, ref: nullableString }).strict().nullable(),
  ownerKind: ownerKind.nullable(),
  ownerLabel: nullableString,
  subjectName: nullableString,
  episodeId: nullableString,
  status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).nullable(),
  title: nullableString,
  message: nullableString,
  triggeredAt: nullableTimestamp,
  acknowledgedAt: nullableTimestamp,
  resolvedAt: nullableTimestamp,
  deviceHostname: nullableString,
  siteId: nullableString,
  siteName: nullableString,
  orgName: nullableString,
  alertUrl: z.string(),
  externalTickets: z.array(z.object({
    source: z.string(),
    externalId: z.string(),
    externalUrl: nullableString,
    externalNumber: nullableString,
  }).strict()),
  acknowledgedByPrincipalId: nullableString,
  resolvedByPrincipalId: nullableString,
  enrichmentIncomplete: z.boolean(),
  subjectKey: nullableString,
  resolutionNote: nullableString,
  resolvedBy: nullableString,
  resolutionReason: nullableString,
  acknowledgedBy: nullableString,
  suppressedBy: nullableString,
  suppressedUntil: nullableTimestamp,
  responsesOwner: z.boolean().nullable(),
  kind: nullableString,
  source: nullableString,
  details: z.record(z.string(), z.unknown()),
}).strict();
export type AlertWebhookDataV2 = z.infer<typeof alertWebhookDataV2Schema>;

export const alertWebhookDataV2PartnerSchema = alertWebhookDataV2Schema.extend({
  orgExternalIds: z.array(z.object({ system: z.string(), externalId: z.string() }).strict()),
}).strict();
export type AlertWebhookDataV2Partner = z.infer<typeof alertWebhookDataV2PartnerSchema>;
