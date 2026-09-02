/**
 * Alert Service
 *
 * Core alert lifecycle management:
 * - Create alerts with deduplication and cooldown
 * - Find applicable rules for devices
 * - Auto-resolve alerts when conditions clear
 * - Interpolate template strings
 */

import { db } from '../db';
import {
  alerts,
  alertRules,
  alertTemplates,
  devices,
  deviceGroups,
  deviceGroupMemberships,
  organizations,
  sites,
  configPolicyAlertRules
} from '../db/schema';
import { eq, and, inArray, isNull, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { evaluateConditions, evaluateAutoResolveConditions, interpolateTemplate } from './alertConditions';
import { isCooldownActive, setCooldown, isConfigPolicyRuleCooling, markConfigPolicyRuleCooldown, recordStateTransition, isFlapping } from './alertCooldown';
import { resolveAlertRulesForDevice, resolveMaintenanceConfigForDevice, isInMaintenanceWindow } from './featureConfigResolver';
import { publishEvent } from './eventBus';
import { resolveDeviceSiteId } from './deviceSiteResolver';
import { enqueueAlertCorrelation } from '../jobs/alertCorrelation';

// Types for alert creation
export interface CreateAlertParams {
  ruleId: string;
  deviceId: string;
  orgId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  message: string;
  context?: Record<string, unknown>;
}

// Rule with template info for evaluation
export interface RuleWithTemplate {
  rule: typeof alertRules.$inferSelect;
  template: typeof alertTemplates.$inferSelect;
  effectiveConditions: unknown;
  effectiveSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  effectiveCooldownMinutes: number;
  notificationChannelIds: string[];
  escalationPolicyId?: string;
}

/**
 * Create a new alert
 * - Checks cooldown to prevent duplicates
 * - Deduplicates against existing active alerts
 * - Publishes alert.triggered event
 *
 * @returns Created alert ID, or null if blocked by cooldown/dedupe
 */
export async function createAlert(params: CreateAlertParams): Promise<string | null> {
  const { ruleId, deviceId, orgId, severity, title, message, context } = params;

  // Get the rule to check cooldown settings
  const [rule] = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, ruleId))
    .limit(1);

  if (!rule) {
    console.warn(`[AlertService] Rule ${ruleId} not found`);
    return null;
  }

  // Get template for cooldown setting
  const [template] = await db
    .select()
    .from(alertTemplates)
    .where(eq(alertTemplates.id, rule.templateId))
    .limit(1);

  // Check override or template cooldown
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const cooldownMinutes = (overrides?.cooldownMinutes as number) ??
    template?.cooldownMinutes ?? 5;

  // Check cooldown
  const cooldownActive = await isCooldownActive(ruleId, deviceId);
  if (cooldownActive) {
    console.log(`[AlertService] Cooldown active for rule=${ruleId} device=${deviceId}`);
    return null;
  }

  // Check for existing open alert (dedupe)
  // Skip if there's any non-resolved alert — active, acknowledged, or suppressed
  // all mean the user is already aware of / managing this condition
  const [existingAlert] = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.ruleId, ruleId),
        eq(alerts.deviceId, deviceId),
        inArray(alerts.status, ['active', 'acknowledged', 'suppressed'])
      )
    )
    .limit(1);

  if (existingAlert) {
    console.log(`[AlertService] Open alert (${existingAlert.status}) already exists for rule=${ruleId} device=${deviceId}`);
    return null;
  }

  // Phase 6a: Flapping detection — suppress if rapid state changes detected
  const flapping = await isFlapping(ruleId, deviceId);
  if (flapping) {
    console.log(`[AlertService] Flapping detected for rule=${ruleId} device=${deviceId}, suppressing alert`);
    // Still set cooldown to prevent immediate re-evaluation
    await setCooldown(ruleId, deviceId, cooldownMinutes);
    return null;
  }

  // Record state transition for flapping detection
  await recordStateTransition(ruleId, deviceId, 'triggered');

  // Create the alert
  const [newAlert] = await db
    .insert(alerts)
    .values({
      ruleId,
      deviceId,
      orgId,
      severity,
      title,
      message,
      context: context ?? {},
      status: 'active',
      triggeredAt: new Date()
    })
    .returning();

  if (!newAlert) {
    console.error('[AlertService] Failed to create alert');
    return null;
  }

  // Set cooldown
  await setCooldown(ruleId, deviceId, cooldownMinutes);

  enqueueAlertCorrelationForDevice(orgId, deviceId);

  // Publish event — attach the device's site so site-restricted users see it
  const siteId = await resolveDeviceSiteId(deviceId);
  await publishEvent(
    'alert.triggered',
    orgId,
    {
      alertId: newAlert.id,
      ruleId,
      deviceId,
      severity,
      title,
      message
    },
    'alert-service',
    { siteId }
  );

  console.log(`[AlertService] Created alert ${newAlert.id} for rule=${ruleId} device=${deviceId}`);

  return newAlert.id;
}

/**
 * Check if an alert should be auto-resolved
 * Evaluates auto-resolve conditions and resolves if met
 *
 * @returns true if alert was auto-resolved
 */
export async function checkAutoResolve(alertId: string): Promise<boolean> {
  // Get the alert
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert || alert.status !== 'active') {
    return false;
  }

  // Config policy alerts don't have a legacy ruleId — skip legacy auto-resolve path
  if (!alert.ruleId) {
    return false;
  }

  // Get rule and template
  const [rule] = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, alert.ruleId))
    .limit(1);

  if (!rule) {
    return false;
  }

  const [template] = await db
    .select()
    .from(alertTemplates)
    .where(eq(alertTemplates.id, rule.templateId))
    .limit(1);

  if (!template) {
    return false;
  }

  // Check if auto-resolve is enabled
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const autoResolve = (overrides?.autoResolve as boolean) ?? template.autoResolve;

  if (!autoResolve) {
    return false;
  }

  // Get auto-resolve conditions (inverse conditions)
  const autoResolveConditions = (overrides?.autoResolveConditions as unknown) ??
    template.autoResolveConditions;

  if (!autoResolveConditions) {
    // If no specific auto-resolve conditions, use inverse of trigger conditions
    const triggerConditions = (overrides?.conditions as unknown) ?? template.conditions;
    const result = await evaluateConditions(triggerConditions, alert.deviceId);

    // Auto-resolve if trigger conditions are NO LONGER met.
    // Report what resolveAlert's compare-and-swap actually did: returning a bare
    // `true` here made every caller that LOST the race look like a resolver, which
    // is what inflates `checkAllAutoResolve`'s count (#4094).
    if (!result.triggered) {
      return await resolveAlert(alertId, 'Auto-resolved: conditions cleared');
    }
  } else {
    // Evaluate specific auto-resolve conditions
    const result = await evaluateAutoResolveConditions(autoResolveConditions, alert.deviceId);

    if (result.shouldResolve) {
      return await resolveAlert(alertId, `Auto-resolved: ${result.reason}`);
    }
  }

  return false;
}

/**
 * Resolve an alert
 */
/**
 * The two terminal statuses are `resolved` and `dismissed`; everything else is
 * still resolvable. Exported with the predicate builder below so tests can
 * assert the COMPILED SQL — a mocked-drizzle assertion that only checks column
 * names appear cannot tell `and` from `or`, nor catch this list gaining a
 * terminal status, and both mutations turn the CAS into a no-op or a
 * fleet-wide overwrite.
 */
export const RESOLVABLE_ALERT_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;

/** The `alert_status` enum, as the column itself types it. */
type AlertStatus = (typeof alerts.$inferSelect)['status'];

/**
 * What a resolve path reports when it LOSES the compare-and-swap.
 *
 * Deliberately states only what the code can verify — that the row is no longer in
 * a resolvable status. It does NOT claim "another request resolved it": an empty
 * `RETURNING` is also what an RLS-invisible write produces, and naming the benign
 * cause in user-visible text forecloses the one hypothesis worth chasing when the
 * cause is not benign.
 */
export const ALERT_CAS_LOST_MESSAGE =
  'Alert is no longer resolvable — it already reached a terminal status (resolved or dismissed).';

/**
 * The compare-and-swap predicate for resolving ONE alert by id. See the note above.
 *
 * This is the single definition of "this alert is still resolvable" for every
 * single-alert resolve path (#4094): `resolveAlert`, both HTTP resolve routes, the
 * `manage_alerts` AI tool, and the warranty auto-resolve sweep. Building a second
 * copy inline is how the predicate and its compiled-SQL test drifted apart once
 * already.
 *
 * Two paths deliberately do NOT use this builder because they write many rows at
 * once and need `inArray(alerts.id, ...)` rather than an id equality — they compose
 * `RESOLVABLE_ALERT_STATUSES` directly instead:
 *   - the correlation-group resolve (`routes/alerts/correlations.ts`);
 *   - the bulk alert action (`routes/alerts/alerts.ts`), which is stricter still —
 *     it pins each row to the exact status its snapshot saw.
 */
export function buildResolveAlertCas(alertId: string) {
  return buildAlertStatusCas(alertId, RESOLVABLE_ALERT_STATUSES);
}

/**
 * The one status an alert can be acknowledged FROM.
 *
 * Deliberately narrower than the resolvable set and not derivable from it: every
 * acknowledge call site already refuses a non-active alert at its pre-read, and
 * re-acknowledging an acknowledged alert is not a workflow anybody asked for. What
 * the pre-read could never do is stop the write, which is the #4101 bug — see
 * `buildAcknowledgeAlertCas`.
 */
export const ACKNOWLEDGEABLE_ALERT_STATUSES = ['active'] as const;

/**
 * The statuses an alert can be suppressed FROM: everything except the two terminal
 * ones. `suppressed` is in the set on purpose — re-timing an existing mute
 * (extending or shortening it) is a legitimate operation, unlike re-acknowledging.
 *
 * Textually identical to `RESOLVABLE_ALERT_STATUSES` today, and kept a separate
 * constant anyway: the two express different invariants ("still silenceable" vs
 * "still resolvable") and must be free to diverge when a status is added. Aliasing
 * them would make a future non-terminal status silently inherit both answers.
 * `alertService.ackCasSql.test.ts` derives both from the `alert_status` enum so a
 * new value forces the classification instead of defaulting to one.
 */
export const SUPPRESSIBLE_ALERT_STATUSES = ['active', 'acknowledged', 'suppressed'] as const;

/**
 * What an acknowledge path reports when it LOSES the compare-and-swap.
 *
 * Same discipline as `ALERT_CAS_LOST_MESSAGE`: state only what the code can verify
 * (the row is no longer active), never "another request acknowledged it" — an empty
 * `RETURNING` is also what an RLS-invisible write produces, and naming the benign
 * cause in user-visible text forecloses the hypothesis worth chasing when the cause
 * is not benign.
 */
export const ALERT_ACKNOWLEDGE_CAS_LOST_MESSAGE =
  'Alert is no longer acknowledgeable — its status is no longer active.';

/** What a suppress path reports when it LOSES the compare-and-swap. */
export const ALERT_SUPPRESS_CAS_LOST_MESSAGE =
  'Alert is no longer suppressible — it already reached a terminal status (resolved or dismissed).';

/**
 * The statuses an alert can be dismissed FROM: every one except `dismissed` itself.
 *
 * The widest of the four sets, and deliberately the only one containing a TERMINAL
 * status. Dismiss is the "make this go away for good" action and is documented as
 * legal from any other status — clearing an already-`resolved` alert off the list is
 * the workflow it exists for, so excluding `resolved` here would break a supported
 * operation rather than close a race.
 *
 * `dismissed` is excluded for the opposite reason, and that exclusion is the entire
 * guard: with it in the set the predicate would match an already-dismissed row, the
 * losing caller's UPDATE would succeed, and `dismissedAt`/`dismissedBy` would be
 * re-stamped over the winner's — a CAS present in the code and absent in effect.
 */
export const DISMISSIBLE_ALERT_STATUSES = [
  'active',
  'acknowledged',
  'suppressed',
  'resolved',
] as const;

/**
 * What a dismiss path reports when it LOSES the compare-and-swap.
 *
 * Same discipline as the three above: state only what the code can verify. An empty
 * `RETURNING` here means the row is no longer dismissible, which is also what an
 * RLS-invisible or deleted row produces — so this does not claim "another request
 * dismissed it", however likely that is.
 *
 * Phrased "already reached the dismissed status" rather than "has already been
 * dismissed" for exactly that reason: the first states the eligibility fact the CAS
 * establishes, in the same shape `ALERT_CAS_LOST_MESSAGE` uses, while the second
 * reads as a claim about an actor and would quietly foreclose the RLS/deleted-row
 * hypothesis — the one worth chasing when the cause is not benign.
 */
export const ALERT_DISMISS_CAS_LOST_MESSAGE =
  'Alert is no longer dismissible — it already reached the dismissed status.';

/**
 * The compare-and-swap predicate for acknowledging ONE alert by id (#4101).
 *
 * The acknowledge handlers had the identical check-then-act shape the resolve paths
 * carried before #4094/#4099: read the status, then UPDATE by id unconditionally.
 * The damage is worse than a double-acknowledge. Tech A resolves — the resolve CAS
 * wins, `alert.resolved` publishes, the escalation is cancelled. Tech B's stale list
 * still shows the alert active and B clicks Acknowledge; B's id-only UPDATE stamps
 * `status='acknowledged'` over the resolution, leaving a reopened alert that still
 * carries `resolvedAt`/`resolvedBy` and whose escalation is already gone.
 *
 * Single definition for every single-alert acknowledge path: both HTTP routes
 * (`routes/alerts/alerts.ts`, `routes/mobile.ts`) and the `manage_alerts` AI tool.
 * The two multi-row acknowledge paths compose the status predicate directly because
 * they need `inArray(alerts.id, ...)` rather than an id equality:
 *   - the correlation-group acknowledge (`routes/alerts/correlations.ts`);
 *   - the bulk alert action (`routes/alerts/alerts.ts`), stricter still — it pins
 *     each row to the exact status its snapshot saw.
 */
export function buildAcknowledgeAlertCas(alertId: string) {
  return buildAlertStatusCas(alertId, ACKNOWLEDGEABLE_ALERT_STATUSES);
}

/**
 * The compare-and-swap predicate for suppressing ONE alert by id (#4101). Same
 * check-then-act defect and the same fix shape as `buildAcknowledgeAlertCas`; a
 * stale suppress landing on a just-resolved alert un-resolves it.
 */
export function buildSuppressAlertCas(alertId: string) {
  return buildAlertStatusCas(alertId, SUPPRESSIBLE_ALERT_STATUSES);
}

/**
 * The compare-and-swap predicate for dismissing ONE alert by id (#4293) — the last
 * single-alert transition to get one.
 *
 * What a lost race costs here is narrower than #4101 and is NOT a reopened alert:
 * because dismiss is legal from every other status, a dismiss landing on a
 * just-resolved alert is the intended outcome. The casualty is PROVENANCE. Two techs
 * dismiss the same alert; both id-only UPDATEs matched, so `dismissedAt`/`dismissedBy`
 * described whichever write landed second while BOTH callers got a 200, an ML feedback
 * emit and an audit row claiming the transition. For the terminal action, "who
 * dismissed this and when" is the field most likely to be asked about later.
 *
 * Unlike the other three transitions, dismiss has exactly ONE other write path, not
 * two: the bulk alert action. There is no correlation-group dismiss — `mutateAlerts`
 * in `routes/alerts/correlations.ts` takes only `'acknowledge' | 'resolve'`. Bulk
 * composes its predicate directly because it needs `inArray(alerts.id, ...)`, and it
 * pins each row to the exact status its snapshot saw, which is stricter than this set
 * but correct there — bulk reports a `skipped` count rather than an error, so a
 * concurrent change costs the caller a retry hint, not a refused operation.
 */
export function buildDismissAlertCas(alertId: string) {
  return buildAlertStatusCas(alertId, DISMISSIBLE_ALERT_STATUSES);
}

/**
 * The one place the CAS SHAPE lives. The four builders above differ only in which
 * statuses they admit; funnelling them through here means a change to the shape
 * (`and` → `or`, dropping the id equality) cannot land on one transition and miss
 * the other three — which is exactly how a predicate and its compiled-SQL test have
 * drifted apart in this file before.
 */
function buildAlertStatusCas(alertId: string, statuses: readonly AlertStatus[]) {
  return and(
    eq(alerts.id, alertId),
    inArray(alerts.status, [...statuses]),
  );
}

export async function resolveAlert(
  alertId: string,
  resolutionNote?: string,
  resolvedBy?: string
): Promise<boolean> {
  // Winner-takes-all. The status predicate IS the concurrency control: reading
  // the row first and then updating by id unconditionally lets two callers
  // both "resolve" the same alert and both run the fan-out below — the state
  // transition, the cooldown write, and an `alert.resolved` publish that
  // cancels escalations and feeds the AI triage loop guard.
  //
  // Two callers is not hypothetical: policy.compliant redelivery, the
  // auto-resolve sweep and monitorWorker can all reach the same alert, and
  // wave 3.5c makes event delivery at-least-once.
  //
  // RETURNING replaces the previous SELECT. Note it returns the POST-update
  // row: safe only because nothing below reads a column this SET writes
  // (status / resolvedAt / resolvedBy / resolutionNote). Adding such a read
  // later would silently observe the new value.
  const [alert] = await db
    .update(alerts)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: resolvedBy ?? null,
      resolutionNote: resolutionNote ?? null
    })
    .where(buildResolveAlertCas(alertId))
    .returning();

  // Already resolved by someone else (or gone). Not an error — just not ours.
  if (!alert) return false;

  // Phase 6a: Record resolution state transition for flapping detection
  try {
    if (alert.ruleId) {
      await recordStateTransition(alert.ruleId, alert.deviceId, 'resolved');
    } else if (alert.configPolicyId) {
      await recordStateTransition(alert.configPolicyId, alert.deviceId, 'resolved');
    }
  } catch (error) {
    console.error(`[AlertService] Failed to record state transition for resolved alert:`, error instanceof Error ? error.message : error);
  }

  // Set a cooldown after resolution to prevent immediate re-trigger.
  // Uses the rule's configured cooldown so the condition must persist
  // beyond the cooldown window before a new alert is created.
  if (alert.configPolicyId) {
    // Config policy alert — look up cooldown from configPolicyAlertRules
    const [cpRule] = await db
      .select()
      .from(configPolicyAlertRules)
      .where(eq(configPolicyAlertRules.id, alert.configPolicyId))
      .limit(1);

    if (cpRule) {
      await markConfigPolicyRuleCooldown(cpRule.id, alert.deviceId, cpRule.cooldownMinutes);
    }
  } else if (alert.ruleId) {
    // Legacy standalone alert rule
    const [rule] = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.id, alert.ruleId))
      .limit(1);

    if (rule) {
      const [template] = await db
        .select()
        .from(alertTemplates)
        .where(eq(alertTemplates.id, rule.templateId))
        .limit(1);

      const overrides = rule.overrideSettings as Record<string, unknown> | null;
      const cooldownMinutes = (overrides?.cooldownMinutes as number) ??
        template?.cooldownMinutes ?? 15;
      await setCooldown(alert.ruleId, alert.deviceId, cooldownMinutes);
    }
  }

  // Publish event — attach the device's site so site-restricted users see it.
  //
  // C2 fix: resolvedAt/resolvedBy/triggeredAt ride on the payload so a
  // subscriber never has to re-read this row to learn the resolve state —
  // a re-read on a fresh connection can observe this transaction's write
  // before it commits (the auto-resolve sweep and monitorWorker both call
  // this function from inside one `withSystemDbAccessContext` transaction
  // spanning the whole sweep). See `alertVerdictSubscriber.ts`'s contract
  // comment. Values come from `alert`, the RETURNING row this same UPDATE
  // just produced — never a second read.
  const siteId = await resolveDeviceSiteId(alert.deviceId);
  await publishEvent(
    'alert.resolved',
    alert.orgId,
    {
      alertId,
      ruleId: alert.ruleId,
      deviceId: alert.deviceId,
      resolutionNote,
      resolvedAt: alert.resolvedAt!.toISOString(),
      resolvedBy: alert.resolvedBy,
      triggeredAt: alert.triggeredAt.toISOString(),
    },
    'alert-service',
    { siteId }
  );

  console.log(`[AlertService] Resolved alert ${alertId}`);
  return true;
}

/**
 * LEGACY: Get all applicable rules for a device from standalone alertRules table.
 * Rules can target: all, org, site, group, or specific device.
 *
 * Alert rules are now managed via Configuration Policies.
 * This function remains for legacy/backward compatibility with standalone alertRules.
 * New alert evaluation should use getApplicableRulesFromPolicy() instead.
 */
/**
 * Rule-ownership condition for EVALUATION (#2128): a device is governed by the
 * standalone rules owned by its OWN org, plus the partner-wide rules (org_id
 * NULL) owned by that org's partner. Exported for the offline detector, which
 * runs the same standalone-rule sweep.
 */
export async function alertRuleOwnershipConditionForOrg(orgId: string): Promise<SQL> {
  const [ownerOrg] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId = ownerOrg?.partnerId ?? null;
  if (!partnerId) {
    // Orphaned org (no partner): only its own rules apply.
    return eq(alertRules.orgId, orgId) as unknown as SQL;
  }
  return sql`(${alertRules.orgId} = ${orgId} OR (${alertRules.orgId} IS NULL AND ${alertRules.partnerId} = ${partnerId}))`;
}

export async function getApplicableRules(deviceId: string): Promise<RuleWithTemplate[]> {
  // Get device info
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return [];
  }

  // Get device's group memberships
  const groupMemberships = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));

  const groupIds = groupMemberships.map(g => g.groupId);

  // Build conditions for rule matching
  const targetConditions = [
    eq(alertRules.targetType, 'all'),
    and(eq(alertRules.targetType, 'org'), eq(alertRules.targetId, device.orgId)),
    and(eq(alertRules.targetType, 'site'), eq(alertRules.targetId, device.siteId)),
    and(eq(alertRules.targetType, 'device'), eq(alertRules.targetId, deviceId))
  ];

  // Add group conditions if device is in any groups
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(alertRules.targetType, 'group'), inArray(alertRules.targetId, groupIds))
    );
  }

  // Get all active rules that apply to this device: the device org's own
  // rules plus its partner's partner-wide rules (#2128).
  const ownershipCondition = await alertRuleOwnershipConditionForOrg(device.orgId);
  const rules = await db
    .select()
    .from(alertRules)
    .where(
      and(
        ownershipCondition,
        eq(alertRules.isActive, true),
        or(...targetConditions)
      )
    );

  if (rules.length === 0) {
    return [];
  }

  // Get templates for all rules
  const templateIds = [...new Set(rules.map(r => r.templateId))];
  const templates = await db
    .select()
    .from(alertTemplates)
    .where(inArray(alertTemplates.id, templateIds));

  const templateMap = new Map(templates.map(t => [t.id, t]));

  // Build rule-with-template objects
  const result: RuleWithTemplate[] = [];

  for (const rule of rules) {
    const template = templateMap.get(rule.templateId);
    if (!template) continue;

    const overrides = rule.overrideSettings as Record<string, unknown> | null;

    result.push({
      rule,
      template,
      effectiveConditions: (overrides?.conditions as unknown) ?? template.conditions,
      effectiveSeverity: (overrides?.severity as 'critical' | 'high' | 'medium' | 'low' | 'info') ?? template.severity,
      effectiveCooldownMinutes: (overrides?.cooldownMinutes as number) ?? template.cooldownMinutes,
      notificationChannelIds: (overrides?.notificationChannelIds as string[]) ?? [],
      escalationPolicyId: overrides?.escalationPolicyId as string | undefined
    });
  }

  return result;
}

/**
 * Evaluate all rules for a device and create alerts as needed
 * Returns list of created alert IDs
 */
export async function evaluateDeviceAlerts(deviceId: string): Promise<string[]> {
  const applicableRules = await getApplicableRules(deviceId);

  if (applicableRules.length === 0) {
    return [];
  }

  // Get device info for template interpolation
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return [];
  }

  const createdAlerts: string[] = [];

  for (const { rule, template, effectiveConditions, effectiveSeverity, effectiveCooldownMinutes } of applicableRules) {
    try {
      // Evaluate conditions
      const result = await evaluateConditions(effectiveConditions, deviceId);

      if (result.triggered) {
        // Build template context
        const templateContext: Record<string, unknown> = {
          deviceName: device.displayName || device.hostname,
          hostname: device.hostname,
          osType: device.osType,
          osVersion: device.osVersion,
          ruleName: rule.name,
          severity: effectiveSeverity,
          ...result.context
        };

        // Interpolate title and message
        const title = interpolateTemplate(template.titleTemplate, templateContext);
        const message = interpolateTemplate(template.messageTemplate, templateContext);

        // Create alert — ALWAYS in the DEVICE's org (alerts.org_id NOT NULL):
        // a partner-wide rule (#2128) has no org of its own, and for org-owned
        // rules device.orgId is identical to rule.orgId by the ownership match
        // above. Notifications then route via the firing org's own channels.
        const alertId = await createAlert({
          ruleId: rule.id,
          deviceId,
          orgId: device.orgId,
          severity: effectiveSeverity,
          title,
          message,
          context: {
            ...result.context,
            conditionsMet: result.conditionsMet,
            conditionsNotMet: result.conditionsNotMet,
            templateId: template.id,
            cooldownMinutes: effectiveCooldownMinutes
          }
        });

        if (alertId) {
          createdAlerts.push(alertId);
        }
      }
    } catch (error) {
      console.error(`[AlertService] Error evaluating rule ${rule.id} for device ${deviceId}:`, error);
    }
  }

  return createdAlerts;
}

// ============================================
// Config Policy Alert Rule Evaluation
// ============================================

/**
 * Resolved config policy alert rule in a shape suitable for the alert evaluator.
 */
export interface ConfigPolicyAlertRule {
  id: string;
  name: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  conditions: unknown;
  cooldownMinutes: number;
  autoResolve: boolean;
  autoResolveConditions: unknown;
  titleTemplate: string;
  messageTemplate: string;
}

/**
 * Get applicable alert rules for a device from Configuration Policies.
 * Wraps resolveAlertRulesForDevice and maps the returned configPolicyAlertRules rows
 * into a normalized shape that the alert evaluator can consume.
 */
export async function getApplicableRulesFromPolicy(
  deviceId: string
): Promise<ConfigPolicyAlertRule[]> {
  const policyRules = await resolveAlertRulesForDevice(deviceId);

  return policyRules.map((row) => ({
    id: row.id,
    name: row.name,
    severity: row.severity,
    conditions: row.conditions,
    cooldownMinutes: row.cooldownMinutes,
    autoResolve: row.autoResolve,
    autoResolveConditions: row.autoResolveConditions,
    titleTemplate: row.titleTemplate,
    messageTemplate: row.messageTemplate,
  }));
}

/**
 * Evaluate config policy alert rules for a device and create alerts as needed.
 *
 * This is the config-policy counterpart to evaluateDeviceAlerts(). Instead of
 * querying the standalone alertRules table, it resolves rules from the
 * configuration policy hierarchy, respects maintenance windows, and writes
 * alerts with configPolicyId / configItemName rather than ruleId.
 *
 * @returns list of created alert IDs
 */
export async function evaluateDeviceAlertsFromPolicy(deviceId: string): Promise<string[]> {
  // 1. Check maintenance window — skip evaluation if alerts are suppressed
  const maintenanceConfig = await resolveMaintenanceConfigForDevice(deviceId);
  if (maintenanceConfig) {
    const windowStatus = isInMaintenanceWindow(maintenanceConfig);
    if (windowStatus.active && windowStatus.suppressAlerts) {
      console.log(`[AlertService] Maintenance window active with suppressAlerts=true for device=${deviceId}; skipping config policy alert evaluation`);
      return [];
    }
  }

  // 2. Resolve config policy alert rules for this device
  const policyRules = await getApplicableRulesFromPolicy(deviceId);

  if (policyRules.length === 0) {
    return [];
  }

  // 3. Get device info for template interpolation
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return [];
  }

  const createdAlerts: string[] = [];

  for (const rule of policyRules) {
    try {
      // 4. Check cooldown (uses cpar:<ruleId>:<deviceId> key pattern)
      const cooling = await isConfigPolicyRuleCooling(rule.id, deviceId);
      if (cooling) {
        console.log(`[AlertService] Config policy cooldown active for cpar=${rule.id} device=${deviceId}`);
        continue;
      }

      // 5. Deduplicate against existing open alerts sourced from this config policy rule
      const [existingAlert] = await db
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.configPolicyId, rule.id),
            eq(alerts.deviceId, deviceId),
            inArray(alerts.status, ['active', 'acknowledged', 'suppressed'])
          )
        )
        .limit(1);

      if (existingAlert) {
        console.log(`[AlertService] Open alert (${existingAlert.status}) already exists for cpar=${rule.id} device=${deviceId}`);
        continue;
      }

      // 6. Evaluate conditions
      const result = await evaluateConditions(rule.conditions, deviceId);

      if (result.triggered) {
        // Phase 6a: Flapping detection for config policy rules
        const flapping = await isFlapping(rule.id, deviceId);
        if (flapping) {
          console.log(`[AlertService] Flapping detected for cpar=${rule.id} device=${deviceId}, suppressing alert`);
          await markConfigPolicyRuleCooldown(rule.id, deviceId, rule.cooldownMinutes);
          continue;
        }

        // Record state transition for flapping detection
        await recordStateTransition(rule.id, deviceId, 'triggered');

        // 7. Build template context
        const templateContext: Record<string, unknown> = {
          deviceName: device.displayName || device.hostname,
          hostname: device.hostname,
          osType: device.osType,
          osVersion: device.osVersion,
          ruleName: rule.name,
          severity: rule.severity,
          ...result.context,
        };

        // 8. Interpolate title and message from config policy alert rule templates
        const title = interpolateTemplate(rule.titleTemplate, templateContext);
        const message = interpolateTemplate(rule.messageTemplate, templateContext);

        // 9. Create alert with config policy references (ruleId left null)
        const [newAlert] = await db
          .insert(alerts)
          .values({
            ruleId: null,
            deviceId,
            orgId: device.orgId,
            configPolicyId: rule.id,
            configItemName: rule.name,
            severity: rule.severity,
            title,
            message,
            context: {
              ...result.context,
              conditionsMet: result.conditionsMet,
              conditionsNotMet: result.conditionsNotMet,
              cooldownMinutes: rule.cooldownMinutes,
              source: 'config_policy',
            },
            status: 'active',
            triggeredAt: new Date(),
          })
          .returning();

        if (newAlert) {
          // 10. Set cooldown
          await markConfigPolicyRuleCooldown(rule.id, deviceId, rule.cooldownMinutes);

          enqueueAlertCorrelationForDevice(device.orgId, deviceId);

          // 11. Publish event — carry siteId so site-restricted users get it
          await publishEvent(
            'alert.triggered',
            device.orgId,
            {
              alertId: newAlert.id,
              configPolicyAlertRuleId: rule.id,
              configItemName: rule.name,
              deviceId,
              severity: rule.severity,
              title,
              message,
              source: 'config_policy',
            },
            'alert-service',
            { siteId: device.siteId }
          );

          console.log(`[AlertService] Created config policy alert ${newAlert.id} for cpar=${rule.id} device=${deviceId}`);
          createdAlerts.push(newAlert.id);
        }
      }
    } catch (error) {
      console.error(`[AlertService] Error evaluating config policy rule ${rule.id} for device ${deviceId}:`, error);
    }
  }

  return createdAlerts;
}

/**
 * Check active alerts sourced from configuration policies for auto-resolution.
 *
 * For each active alert where configPolicyId IS NOT NULL, looks up the
 * corresponding config policy alert rule and evaluates auto-resolve logic:
 *   1. If autoResolve is disabled on the rule, skip.
 *   2. If autoResolveConditions are set, evaluate them -- resolve if they fire.
 *   3. Otherwise, evaluate the trigger conditions -- resolve if they NO LONGER fire.
 *
 * After resolution, sets the config policy cooldown so the alert is not
 * immediately re-created.
 *
 * @param deviceId - Device to check auto-resolution for
 * @returns count of resolved alerts
 */
export async function checkAutoResolveFromConfigPolicy(deviceId: string): Promise<number> {
  // Find active alerts created from config policies for this device
  const activeAlerts = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.deviceId, deviceId),
        eq(alerts.status, 'active'),
        isNotNull(alerts.configPolicyId)
      )
    );

  if (activeAlerts.length === 0) {
    return 0;
  }

  // Collect all configPolicyIds referenced by these alerts to batch-load rules
  const configPolicyIds = [...new Set(activeAlerts.map((a) => a.configPolicyId!))];

  const ruleRows = await db
    .select()
    .from(configPolicyAlertRules)
    .where(inArray(configPolicyAlertRules.id, configPolicyIds));

  const ruleMap = new Map(ruleRows.map((r) => [r.id, r]));

  let resolvedCount = 0;

  // Both branches below count — and previously also wrote the config-policy
  // cooldown — only on `resolveAlert`'s compare-and-swap WINNER (#4094). Doing it
  // unconditionally meant a caller that lost the race to the monitor worker or a
  // policy.compliant redelivery still reported a resolution it did not perform and
  // still stamped a cooldown, suppressing the next legitimate alert for that rule.
  // The explicit cooldown write is gone rather than merely gated: on the winning
  // path `resolveAlert` already calls `markConfigPolicyRuleCooldown` with the same
  // rule id, device and `cooldownMinutes` (see its config-policy branch), so it was
  // a duplicate of a write the winner performs anyway.
  for (const alert of activeAlerts) {
    try {
      const rule = ruleMap.get(alert.configPolicyId!);
      if (!rule) {
        // Config policy rule was deleted; leave the alert as-is.
        continue;
      }

      if (!rule.autoResolve) {
        continue;
      }

      if (rule.autoResolveConditions) {
        // Evaluate specific auto-resolve conditions
        const result = await evaluateAutoResolveConditions(
          rule.autoResolveConditions,
          alert.deviceId
        );

        if (result.shouldResolve && await resolveAlert(alert.id, `Auto-resolved: ${result.reason}`)) {
          resolvedCount++;
        }
      } else {
        // No specific auto-resolve conditions; use inverse of trigger conditions
        const result = await evaluateConditions(rule.conditions, alert.deviceId);

        if (!result.triggered && await resolveAlert(alert.id, 'Auto-resolved: conditions cleared')) {
          resolvedCount++;
        }
      }
    } catch (error) {
      console.error(
        `[AlertService] Error checking config policy auto-resolve for alert ${alert.id}:`,
        error
      );
    }
  }

  return resolvedCount;
}

/**
 * Check all active alerts for auto-resolution
 * Returns count of resolved alerts
 */
export async function checkAllAutoResolve(orgId?: string): Promise<number> {
  // Get active alerts (optionally filtered by org)
  const conditions = [eq(alerts.status, 'active')];
  if (orgId) {
    conditions.push(eq(alerts.orgId, orgId));
  }

  const activeAlerts = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(...conditions));

  let resolvedCount = 0;

  for (const alert of activeAlerts) {
    try {
      const resolved = await checkAutoResolve(alert.id);
      if (resolved) {
        resolvedCount++;
      }
    } catch (error) {
      console.error(`[AlertService] Error checking auto-resolve for alert ${alert.id}:`, error);
    }
  }

  return resolvedCount;
}

function enqueueAlertCorrelationForDevice(orgId: string, deviceId: string): void {
  void enqueueAlertCorrelation({ orgId, deviceId }).catch((error) => {
    console.error(
      `[AlertService] Failed to enqueue alert correlation for org=${orgId} device=${deviceId}:`,
      error
    );
  });
}

/**
 * Get alert statistics for an organization
 */
export async function getAlertStats(orgId: string): Promise<{
  active: number;
  acknowledged: number;
  resolved: number;
  suppressed: number;
  bySeverity: Record<string, number>;
}> {
  const allAlerts = await db
    .select({
      status: alerts.status,
      severity: alerts.severity
    })
    .from(alerts)
    .where(eq(alerts.orgId, orgId));

  const stats = {
    active: 0,
    acknowledged: 0,
    resolved: 0,
    suppressed: 0,
    bySeverity: {} as Record<string, number>
  };

  for (const alert of allAlerts) {
    // Count by status
    if (alert.status === 'active') stats.active++;
    else if (alert.status === 'acknowledged') stats.acknowledged++;
    else if (alert.status === 'resolved') stats.resolved++;
    else if (alert.status === 'suppressed') stats.suppressed++;

    // Count by severity (only for active/acknowledged)
    if (alert.status === 'active' || alert.status === 'acknowledged') {
      stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1;
    }
  }

  return stats;
}
