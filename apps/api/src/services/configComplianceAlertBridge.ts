/**
 * Configuration-policy compliance → alerts (#6669).
 *
 * `evaluateDeviceComplianceFromConfigPolicy` (policyEvaluationService.ts)
 * publishes `policy.violation` / `policy.compliant` carrying
 * `configPolicyComplianceRuleId` and no `policyId`. Before this module the
 * bridge (policyAlertBridge.ts) only understood legacy automation-policy
 * payloads and returned early, so a failing compliance rule never became an
 * alert. policyAlertBridge.ts now hands config-policy payloads here.
 *
 * Alert source shape — the same one patchAlerts.ts and policyAlertBridge.ts use,
 * the post-consolidation pattern for server-raised alerts with no authored
 * monitor: one GLOBAL built-in template (org_id AND partner_id NULL, legal per
 * `alert_templates_one_owner_chk`) plus one ORG-OWNED rule per (device org,
 * compliance rule), created lazily. `is_built_in = true` keeps both out of the
 * legacy-alerting retirement sweep (services/monitors/conversion/retirementSweep.ts).
 * Every alert goes through `createAlert` (cooldown, dedupe on the open alert,
 * `alert.triggered` → notifications / escalation / automations / AI verdict).
 *
 * Which enforcement levels alert follows what the Compliance tab promises:
 *   - `monitor` ("Monitor Only — report violations without taking action"): never
 *     alerts. A rule downgraded to `monitor` resolves any alert it already raised.
 *   - `warn` ("Notify users and log compliance warnings"): medium alert.
 *   - `enforce` ("Automatically remediate"): high alert (remediation also runs).
 *
 * Tenancy: the event's orgId is the DEVICE's org. A partner-wide policy
 * (org_id NULL) fans out to every org under its partner through
 * `resolveComplianceRulesForDevice`; the alert and its rule always take the
 * device's org, never the policy's owner.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  alertRules,
  alertTemplates,
  alerts,
  automationPolicyCompliance,
  configPolicyComplianceRules,
  configPolicyFeatureLinks,
  configurationPolicies,
  organizations,
} from '../db/schema';
import { createAlert, resolveAlert, RESOLVABLE_ALERT_STATUSES } from './alertService';

const { db } = dbModule;

export const CONFIG_COMPLIANCE_ALERT_SOURCE = 'config-policy-compliance';
export const CONFIG_COMPLIANCE_TEMPLATE_NAME = 'Configuration Compliance Violation';
const CONFIG_COMPLIANCE_RULE_PREFIX = 'Config Compliance Rule';
const COOLDOWN_MINUTES = 30;
const MAX_FAILED_RULE_MESSAGES = 5;

export type ConfigCompliancePayload = {
  configPolicyComplianceRuleId?: string;
  configPolicyComplianceRuleName?: string;
  /** The FEATURE LINK id (policyEvaluationService's naming), not the configuration policy id. */
  configPolicyId?: string;
  deviceId?: string;
  hostname?: string;
  status?: string;
  enforcementLevel?: string;
};

type Enforcement = 'monitor' | 'warn' | 'enforce';

export function isConfigCompliancePayload(payload: unknown): payload is ConfigCompliancePayload {
  return typeof payload === 'object'
    && payload !== null
    && typeof (payload as ConfigCompliancePayload).configPolicyComplianceRuleId === 'string';
}

/** `null` = this enforcement level does not alert. */
export function severityForEnforcement(level: Enforcement): 'high' | 'medium' | null {
  if (level === 'enforce') return 'high';
  if (level === 'warn') return 'medium';
  return null;
}

function ruleNameFor(complianceRuleId: string): string {
  return `${CONFIG_COMPLIANCE_RULE_PREFIX}:${complianceRuleId}`;
}

type ResolvedComplianceRule = {
  id: string;
  name: string;
  enforcementLevel: Enforcement;
  featureLinkId: string;
  policyId: string;
  policyName: string;
  policyOrgId: string | null;
  policyPartnerId: string | null;
};

async function loadComplianceRule(complianceRuleId: string): Promise<ResolvedComplianceRule | null> {
  const [row] = await db
    .select({
      id: configPolicyComplianceRules.id,
      name: configPolicyComplianceRules.name,
      enforcementLevel: configPolicyComplianceRules.enforcementLevel,
      featureLinkId: configPolicyComplianceRules.featureLinkId,
      policyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
      policyOrgId: configurationPolicies.orgId,
      policyPartnerId: configurationPolicies.partnerId,
    })
    .from(configPolicyComplianceRules)
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyFeatureLinks.id, configPolicyComplianceRules.featureLinkId))
    .innerJoin(configurationPolicies, eq(configurationPolicies.id, configPolicyFeatureLinks.configPolicyId))
    .where(eq(configPolicyComplianceRules.id, complianceRuleId))
    .limit(1);
  return row ?? null;
}

/**
 * The policy must be owned by the device's org, or be partner-wide and owned by
 * that org's partner. Anything else is a race (policy deleted, org re-parented)
 * or a forged payload — log it rather than silently swallowing it.
 */
async function policyReachesOrg(rule: ResolvedComplianceRule, orgId: string): Promise<boolean> {
  if (rule.policyOrgId !== null) {
    if (rule.policyOrgId === orgId) return true;
    console.warn(
      `[configComplianceAlertBridge] dropping compliance event for rule ${rule.id}: `
      + `policy org ${rule.policyOrgId} does not match event org ${orgId}`,
    );
    return false;
  }
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (org && rule.policyPartnerId && org.partnerId === rule.policyPartnerId) return true;
  console.warn(
    `[configComplianceAlertBridge] dropping compliance event for partner-wide rule ${rule.id}: `
    + `event org ${orgId} is not under owning partner ${rule.policyPartnerId ?? 'NULL'}`,
  );
  return false;
}

/**
 * The event is a wake-up, not the truth: the evaluator upserts
 * automation_policy_compliance BEFORE it publishes. A delayed or retried event
 * that lands after a newer evaluation must act on the persisted state.
 */
async function persistedCompliance(rule: ResolvedComplianceRule, deviceId: string) {
  const [row] = await db
    .select({ status: automationPolicyCompliance.status, details: automationPolicyCompliance.details })
    .from(automationPolicyCompliance)
    .where(and(
      isNull(automationPolicyCompliance.policyId),
      eq(automationPolicyCompliance.configPolicyId, rule.featureLinkId),
      eq(automationPolicyCompliance.configItemName, rule.name),
      eq(automationPolicyCompliance.deviceId, deviceId),
    ))
    .orderBy(desc(automationPolicyCompliance.updatedAt))
    .limit(1);
  return row ?? null;
}

function failedRuleMessages(details: unknown): string[] {
  const ruleResults = (details as { ruleResults?: unknown } | null)?.ruleResults;
  if (!Array.isArray(ruleResults)) return [];
  return ruleResults
    .filter((r): r is { passed: boolean; message: string } =>
      typeof r === 'object' && r !== null
      && (r as { passed?: unknown }).passed === false
      && typeof (r as { message?: unknown }).message === 'string')
    .map((r) => r.message)
    .slice(0, MAX_FAILED_RULE_MESSAGES);
}

async function ensureGlobalTemplate(): Promise<string> {
  const [existing] = await db
    .select({ id: alertTemplates.id })
    .from(alertTemplates)
    .where(and(
      isNull(alertTemplates.orgId),
      isNull(alertTemplates.partnerId),
      eq(alertTemplates.name, CONFIG_COMPLIANCE_TEMPLATE_NAME),
    ))
    // No unique index on name: a race can create two; always take the oldest.
    .orderBy(alertTemplates.createdAt)
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(alertTemplates)
    .values({
      orgId: null,
      partnerId: null,
      name: CONFIG_COMPLIANCE_TEMPLATE_NAME,
      description: 'Auto-generated template for configuration-policy compliance violations',
      conditions: { source: CONFIG_COMPLIANCE_ALERT_SOURCE },
      severity: 'medium',
      titleTemplate: 'Compliance violation on {{hostname}}',
      messageTemplate: '{{ruleName}} is not met on {{hostname}}',
      autoResolve: true,
      isBuiltIn: true,
      cooldownMinutes: COOLDOWN_MINUTES,
    })
    .returning({ id: alertTemplates.id });
  if (!created) throw new Error('[configComplianceAlertBridge] failed to create template');
  return created.id;
}

async function findRuleIds(orgId: string, complianceRuleId: string): Promise<string[]> {
  const rows = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(and(
      eq(alertRules.orgId, orgId),
      eq(alertRules.name, ruleNameFor(complianceRuleId)),
      isNull(alertRules.retiredAt),
    ));
  return rows.map((r) => r.id);
}

async function ensureRule(orgId: string, rule: ResolvedComplianceRule): Promise<string> {
  const [existing] = await findRuleIds(orgId, rule.id);
  if (existing) return existing;

  const templateId = await ensureGlobalTemplate();
  const [created] = await db
    .insert(alertRules)
    .values({
      orgId,
      templateId,
      name: ruleNameFor(rule.id),
      targetType: 'org',
      targetId: orgId,
      isActive: true,
      overrideSettings: {
        source: CONFIG_COMPLIANCE_ALERT_SOURCE,
        configPolicyComplianceRuleId: rule.id,
        cooldownMinutes: COOLDOWN_MINUTES,
      },
    })
    .returning({ id: alertRules.id });
  if (!created) throw new Error(`[configComplianceAlertBridge] failed to create rule for org ${orgId}`);
  return created.id;
}

/**
 * Resolves every open alert this compliance rule raised on the device. Searches
 * ALL same-named rules for the org — the lazy ensureRule has no unique index, so
 * a race can leave two, and an alert under either must still clear.
 */
async function resolveOpenAlerts(orgId: string, complianceRuleId: string, deviceId: string, note: string) {
  const ruleIds = await findRuleIds(orgId, complianceRuleId);
  if (ruleIds.length === 0) return;
  const open = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(
      inArray(alerts.ruleId, ruleIds),
      eq(alerts.deviceId, deviceId),
      inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
    ));
  for (const alert of open) {
    await resolveAlert(alert.id, note);
  }
}

export async function handleConfigComplianceViolation(orgId: string, payload: ConfigCompliancePayload): Promise<void> {
  const { configPolicyComplianceRuleId: complianceRuleId, deviceId } = payload;
  if (!complianceRuleId || !deviceId) return;

  const rule = await loadComplianceRule(complianceRuleId);
  if (!rule) return; // Rule deleted since the evaluation — nothing to alert on.
  if (!(await policyReachesOrg(rule, orgId))) return;

  const severity = severityForEnforcement(rule.enforcementLevel);
  if (severity === null) {
    // Report-only. If the rule was downgraded while an alert was open, clear it —
    // otherwise it would never resolve, since no later event re-raises it.
    await resolveOpenAlerts(orgId, rule.id, deviceId, 'Auto-resolved: compliance rule is now Monitor Only (report without alerting)');
    return;
  }

  const persisted = await persistedCompliance(rule, deviceId);
  if (persisted?.status !== 'non_compliant') {
    // Stale or reordered violation: the persisted evaluation has moved on (or
    // was never written). Creating an alert here would strand it.
    return;
  }

  const hostname = payload.hostname ?? deviceId;
  const failed = failedRuleMessages(persisted.details);
  const ruleId = await ensureRule(orgId, rule);
  await createAlert({
    ruleId,
    deviceId,
    orgId,
    severity,
    title: `Compliance violation: ${rule.name} on ${hostname}`,
    message: failed.length > 0
      ? `${failed.join(' ')} (configuration policy "${rule.policyName}")`
      : `Compliance rule "${rule.name}" in configuration policy "${rule.policyName}" is not met on ${hostname}.`,
    context: {
      source: CONFIG_COMPLIANCE_ALERT_SOURCE,
      configPolicyId: rule.policyId,
      configPolicyName: rule.policyName,
      configPolicyFeatureLinkId: rule.featureLinkId,
      configPolicyComplianceRuleId: rule.id,
      configPolicyComplianceRuleName: rule.name,
      enforcementLevel: rule.enforcementLevel,
      failedRules: failed,
    },
  });
}

export async function handleConfigComplianceCompliant(orgId: string, payload: ConfigCompliancePayload): Promise<void> {
  const { configPolicyComplianceRuleId: complianceRuleId, deviceId } = payload;
  if (!complianceRuleId || !deviceId) return;

  // Resolution does not need the compliance rule to still exist: a deleted rule
  // must still be able to clear what it raised. The org-owned alert rule is
  // keyed by the compliance rule id, so it can only match this org's alerts.
  const rule = await loadComplianceRule(complianceRuleId);
  if (rule) {
    if (!(await policyReachesOrg(rule, orgId))) return;
    const persisted = await persistedCompliance(rule, deviceId);
    // `policy.compliant` is also published for an evaluation ERROR; an error is
    // not evidence the device recovered, and a reordered compliant event must
    // not clear a newer violation. Only a persisted `compliant` (or no row) clears.
    if (persisted && persisted.status !== 'compliant') return;
  }

  await resolveOpenAlerts(orgId, complianceRuleId, deviceId, 'Auto-resolved: device returned to compliance');
}
