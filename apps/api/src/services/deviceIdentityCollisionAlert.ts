/**
 * Device identity collision alert (#2764).
 *
 * Enrollment no longer refuses a hostname collision with a 409 — it enrolls a
 * FRESH device row and links it back to the row it may be replacing (see
 * routes/agents/enrollment.ts). Prevention is replaced by detection: when the
 * colliding row is *currently online*, the operator gets a real alert (not just
 * an audit line) so a genuine lookalike/impersonation attempt is visible, and
 * the ordinary "machine was reimaged" case gets a one-click cleanup surface.
 *
 * Deliberately best-effort:
 *  - If the built-in template is missing (self-hoster mid-migration) → skip.
 *  - If the org (or its partner) has no active rule bound to that template →
 *    skip silently. Alerting is opt-in per org exactly like every other
 *    standalone template-based rule; enrollment must never fail because an
 *    operator has not configured a rule.
 *  - The caller wraps this in `.catch()`: an alert failure can never fail the
 *    enrollment that triggered it.
 *
 * Must run in a DB access context (system scope) — the caller invokes it AFTER
 * the enrollment transaction context has closed, in its own system context, so
 * it never pins a pooled connection across the enrollment path (#1105).
 */

import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { alertRules, alertTemplates } from '../db/schema';
import { createAlert, alertRuleOwnershipConditionForOrg } from './alertService';
import { interpolateTemplate } from './alertConditions';

/**
 * `conditions->>'eventType'` marker of the built-in template seeded by
 * migration 2026-08-12-device-identity-collision-alert-template.sql. Event-
 * driven templates are resolved by this marker rather than evaluated by the
 * condition registry, exactly like the network-baseline templates.
 */
export const DEVICE_IDENTITY_COLLISION_EVENT_TYPE = 'device.identity_collision';

export interface DeviceIdentityCollisionAlertInput {
  orgId: string;
  siteId: string;
  hostname: string;
  /** The freshly enrolled row (the alert hangs off this device). */
  newDeviceId: string;
  /** The online row the new one may be replacing. */
  existingDeviceId: string;
  /** Every row that collided on org + site + hostname, oldest first. */
  collidingDeviceIds: string[];
}

/**
 * @returns the created alert id, or null when no alert was raised (no
 *          template, no rule, cooldown/dedupe inside createAlert).
 */
export async function raiseDeviceIdentityCollisionAlert(
  input: DeviceIdentityCollisionAlertInput,
): Promise<string | null> {
  const [template] = await db
    .select({
      id: alertTemplates.id,
      severity: alertTemplates.severity,
      titleTemplate: alertTemplates.titleTemplate,
      messageTemplate: alertTemplates.messageTemplate,
    })
    .from(alertTemplates)
    .where(
      and(
        eq(alertTemplates.isBuiltIn, true),
        sql`${alertTemplates.conditions}->>'eventType' = ${DEVICE_IDENTITY_COLLISION_EVENT_TYPE}`,
      ),
    )
    .limit(1);

  if (!template) {
    return null;
  }

  // Same ownership + targeting resolution the offline detector uses for
  // standalone template rules (#2128): the device's own org plus the
  // partner-wide rules owned by that org's partner.
  const ownershipCondition = await alertRuleOwnershipConditionForOrg(input.orgId);
  const [rule] = await db
    .select({
      id: alertRules.id,
      name: alertRules.name,
      overrideSettings: alertRules.overrideSettings,
    })
    .from(alertRules)
    .where(
      and(
        ownershipCondition,
        eq(alertRules.templateId, template.id),
        eq(alertRules.isActive, true),
        or(
          eq(alertRules.targetType, 'all'),
          and(eq(alertRules.targetType, 'org'), eq(alertRules.targetId, input.orgId)),
          and(eq(alertRules.targetType, 'site'), eq(alertRules.targetId, input.siteId)),
          and(eq(alertRules.targetType, 'device'), eq(alertRules.targetId, input.newDeviceId)),
        ),
      ),
    )
    .limit(1);

  if (!rule) {
    // No rule configured for this org — detection is audited either way
    // (agent.enroll / hostname_collision_enrolled_fresh_row); the alert is
    // the optional operator-facing surface.
    return null;
  }

  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const severity =
    (overrides?.severity as 'critical' | 'high' | 'medium' | 'low' | 'info') ?? template.severity;

  const context: Record<string, unknown> = {
    eventType: DEVICE_IDENTITY_COLLISION_EVENT_TYPE,
    hostname: input.hostname,
    newDeviceId: input.newDeviceId,
    existingDeviceId: input.existingDeviceId,
    collidingDeviceIds: input.collidingDeviceIds,
    ruleName: rule.name,
    severity,
    templateId: template.id,
  };

  return await createAlert({
    ruleId: rule.id,
    deviceId: input.newDeviceId,
    orgId: input.orgId,
    severity,
    title: interpolateTemplate(template.titleTemplate, context),
    message: interpolateTemplate(template.messageTemplate, context),
    context,
  });
}
