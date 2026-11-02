/**
 * Notifications of a written reinstall flag (#8318 §7.3 "Notification"): the
 * `device.reinstall_suspected` event, an opt-in alert and an audit row, all
 * in the TARGET's org (a real org by construction: targets in hidden orgs
 * never qualify, so a parked device never raises an alert).
 *
 * What the target's org may learn about the source:
 *  - the source is in the SAME org → its id and hostname (the org already
 *    sees that device);
 *  - the source is parked in the partner holding area → nothing but that a
 *    possible reinstall awaits partner review (#7397, §7.3 "No leaks");
 *  - the source is in ANOTHER customer org of the partner → nothing either:
 *    a customer org's webhooks, alerts and audit log must not name another
 *    customer's device. The partner reads both orgs and finds the pair from
 *    the source's flag.
 */
import { and, eq, or, sql } from 'drizzle-orm';
import type { PossibleReplacementReason } from '@breeze/shared';
import { db } from '../../db';
import { alertRules, alertTemplates } from '../../db/schema';
import { alertRuleOwnershipConditionForOrg, createAlert } from '../alertService';
import { interpolateTemplate } from '../alertConditions';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { createAuditLogAsync } from '../auditService';
import { EVENT_TYPES, publishEvent } from '../eventBus';
import type { ReinstallEvidence } from './ranking';

/** `conditions->>'eventType'` of the built-in template (2027-01-19-110300) and the event type. */
export const DEVICE_REINSTALL_SUSPECTED_EVENT_TYPE = 'device.reinstall_suspected' as const;

/** The neutral label used whenever the source must not be named. */
export const PARKED_SOURCE_LABEL = 'A device awaiting partner review';
export const OTHER_ORG_SOURCE_LABEL = 'A newly enrolled device in another organization';

export interface ReinstallSuspicion {
  source: { id: string; orgId: string; hostname: string; parked: boolean };
  target: { id: string; orgId: string; siteId: string; hostname: string };
  reason: PossibleReplacementReason;
  evidence: ReinstallEvidence;
  detectedAt: Date;
  kind: 'new' | 'upgrade' | 'replace';
  trigger: 'enroll' | 'hardware_report';
}

/** Whether the target's org may see the source's id and hostname. */
export function sourceIdentityDisclosable(s: ReinstallSuspicion): boolean {
  return !s.source.parked && s.source.orgId === s.target.orgId;
}

export interface ReinstallSuspectedEventPayload {
  targetDeviceId: string;
  reason: PossibleReplacementReason;
  detectedAt: string;
  sourceParked: boolean;
  sourceDeviceId?: string;
  sourceHostname?: string;
}

/** The event payload. Pure; never carries an undisclosable source identity. */
export function buildReinstallSuspectedEventPayload(s: ReinstallSuspicion): ReinstallSuspectedEventPayload {
  return {
    targetDeviceId: s.target.id,
    reason: s.reason,
    detectedAt: s.detectedAt.toISOString(),
    sourceParked: s.source.parked,
    ...(sourceIdentityDisclosable(s) ? { sourceDeviceId: s.source.id, sourceHostname: s.source.hostname } : {}),
  };
}

const EVIDENCE_LABEL: Record<ReinstallEvidence, string> = {
  system_uuid: 'hardware (SMBIOS system UUID)',
  serial: 'hardware (serial number and manufacturer)',
  hostname: 'hostname',
};

/** `{{sourceLabel}}` for the alert message. Pure. */
export function reinstallSourceLabel(s: ReinstallSuspicion): string {
  if (s.source.parked) return PARKED_SOURCE_LABEL;
  if (!sourceIdentityDisclosable(s)) return OTHER_ORG_SOURCE_LABEL;
  return `The newly enrolled device ${s.source.hostname}`;
}

/** The alert context (stored on the alert row). Pure; same disclosure rule as the event. */
export function buildReinstallSuspectedAlertContext(s: ReinstallSuspicion): Record<string, unknown> {
  return {
    eventType: DEVICE_REINSTALL_SUSPECTED_EVENT_TYPE,
    hostname: s.target.hostname,
    targetDeviceId: s.target.id,
    reason: s.reason,
    reasonLabel: EVIDENCE_LABEL[s.evidence],
    detectedAt: s.detectedAt.toISOString(),
    sourceParked: s.source.parked,
    sourceLabel: reinstallSourceLabel(s),
    ...(sourceIdentityDisclosable(s) ? { sourceDeviceId: s.source.id, sourceHostname: s.source.hostname } : {}),
  };
}

/** The audit details on the target's org. Pure; same disclosure rule. */
export function buildReinstallSuspectedAuditDetails(s: ReinstallSuspicion): Record<string, unknown> {
  return {
    reason: s.reason,
    evidence: s.evidence,
    kind: s.kind,
    trigger: s.trigger,
    detectedAt: s.detectedAt.toISOString(),
    sourceParked: s.source.parked,
    ...(sourceIdentityDisclosable(s) ? { sourceDeviceId: s.source.id, sourceHostname: s.source.hostname } : {}),
  };
}

/**
 * The opt-in alert on the target, modelled on deviceIdentityCollisionAlert.ts:
 * no built-in template (mid-migration) or no active rule bound to it for the
 * target's org or partner → no alert. Runs in a system DB context.
 * @returns the alert id, or null when none was raised.
 */
export async function raiseReinstallSuspectedAlert(s: ReinstallSuspicion): Promise<string | null> {
  const [template] = await db
    .select({
      id: alertTemplates.id,
      severity: alertTemplates.severity,
      titleTemplate: alertTemplates.titleTemplate,
      messageTemplate: alertTemplates.messageTemplate,
    })
    .from(alertTemplates)
    .where(and(
      eq(alertTemplates.isBuiltIn, true),
      sql`${alertTemplates.conditions}->>'eventType' = ${DEVICE_REINSTALL_SUSPECTED_EVENT_TYPE}`,
    ))
    .limit(1);
  if (!template) return null;

  const ownershipCondition = await alertRuleOwnershipConditionForOrg(s.target.orgId);
  const [rule] = await db
    .select({ id: alertRules.id, name: alertRules.name, overrideSettings: alertRules.overrideSettings })
    .from(alertRules)
    .where(and(
      ownershipCondition,
      eq(alertRules.templateId, template.id),
      eq(alertRules.isActive, true),
      or(
        eq(alertRules.targetType, 'all'),
        and(eq(alertRules.targetType, 'org'), eq(alertRules.targetId, s.target.orgId)),
        and(eq(alertRules.targetType, 'site'), eq(alertRules.targetId, s.target.siteId)),
        and(eq(alertRules.targetType, 'device'), eq(alertRules.targetId, s.target.id)),
      ),
    ))
    .limit(1);
  if (!rule) return null;

  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const severity = (overrides?.severity as 'critical' | 'high' | 'medium' | 'low' | 'info') ?? template.severity;
  const context = { ...buildReinstallSuspectedAlertContext(s), ruleName: rule.name, severity, templateId: template.id };
  return createAlert({
    ruleId: rule.id,
    deviceId: s.target.id,
    orgId: s.target.orgId,
    severity,
    title: interpolateTemplate(template.titleTemplate, context),
    message: interpolateTemplate(template.messageTemplate, context),
    context,
  });
}

/** The event, in the target's org. Idempotent per written flag (eventId). */
export async function publishReinstallSuspectedEvent(s: ReinstallSuspicion): Promise<string> {
  return publishEvent(
    EVENT_TYPES.DEVICE_REINSTALL_SUSPECTED,
    s.target.orgId,
    buildReinstallSuspectedEventPayload(s),
    'reinstall-candidates',
    { siteId: s.target.siteId },
  );
}

/** The audit row, in the target's org, actor system. */
export async function writeReinstallSuspectedAudit(s: ReinstallSuspicion): Promise<void> {
  await createAuditLogAsync({
    orgId: s.target.orgId,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    action: DEVICE_REINSTALL_SUSPECTED_EVENT_TYPE,
    resourceType: 'device',
    resourceId: s.target.id,
    resourceName: s.target.hostname,
    details: buildReinstallSuspectedAuditDetails(s),
    result: 'success',
    initiatedBy: 'schedule',
  });
}
