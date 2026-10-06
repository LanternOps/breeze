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
 * A compliance rule is identified by (feature link, rule name), not by its row
 * id. Saving a rule set deletes and re-inserts every rule
 * (configurationPolicy.ts `deleteNormalizedRows` + `decomposeInlineSettings`),
 * so the id changes on every save. The evaluator already keys its own state on
 * (link, name): the automation_policy_compliance row and the due check's
 * last_checked_at. The org's alert rule uses the same key, so one alert rule,
 * and one open alert, covers the rule across saves.
 *
 * Alerts are resolved only through events: `policy.compliant` backed by a
 * persisted `compliant` row, or a downgrade to `monitor`. The template does not
 * auto-resolve, because the alert worker's sweep cannot evaluate a compliance
 * rule (see `ensureGlobalTemplate`).
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
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
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
import { insertBuiltInAlertRule, type BuiltInAlertRuleSource } from './builtInAlertRules';

const { db } = dbModule;

export const CONFIG_COMPLIANCE_ALERT_SOURCE = 'config-policy-compliance' satisfies BuiltInAlertRuleSource;
export const CONFIG_COMPLIANCE_TEMPLATE_NAME = 'Configuration Compliance Violation';
/** Every org alert rule this bridge creates is named `<prefix>:…` (complianceAlertReconcile.ts finds them by it). */
export const CONFIG_COMPLIANCE_RULE_PREFIX = 'Config Compliance Rule';
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

/** What identifies a compliance rule across saves (see the module comment). */
type ComplianceKey = { featureLinkId: string; ruleName: string };

/**
 * The org alert rule's name for a compliance rule. The rule name is hashed
 * because alert_rules.name is varchar(200), and a compliance rule name can be
 * 200 characters by itself.
 */
function alertRuleNameFor(key: ComplianceKey): string {
  const nameDigest = createHash('sha256').update(key.ruleName).digest('hex').slice(0, 32);
  return `${CONFIG_COMPLIANCE_RULE_PREFIX}:${key.featureLinkId}:${nameDigest}`;
}

/**
 * The name alert rules had when they were keyed by compliance rule id. It is
 * still searched when resolving, so an alert raised under that scheme can clear.
 */
function legacyAlertRuleNameFor(complianceRuleId: string): string {
  return `${CONFIG_COMPLIANCE_RULE_PREFIX}:${complianceRuleId}`;
}

export type ResolvedComplianceRule = {
  id: string;
  name: string;
  enforcementLevel: Enforcement;
  featureLinkId: string;
  policyId: string;
  policyName: string;
  policyOrgId: string | null;
  policyPartnerId: string | null;
};

async function loadComplianceRuleWhere(where: SQL | undefined): Promise<ResolvedComplianceRule | null> {
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
    .where(where)
    .orderBy(asc(configPolicyComplianceRules.sortOrder))
    .limit(1);
  return row ?? null;
}

/**
 * The rule an event refers to. Events go out after the scan commits, so a save
 * that lands before an event is handled has already replaced the rule under a
 * new id. The event's (link, name) then finds the rule that replaced it, and
 * the event is judged against that rule, since the persisted state it acts on
 * is keyed the same way. `null` only when no rule with that link and name
 * exists any more.
 */
async function loadEventRule(complianceRuleId: string, payload: ConfigCompliancePayload): Promise<ResolvedComplianceRule | null> {
  const byId = await loadComplianceRuleWhere(eq(configPolicyComplianceRules.id, complianceRuleId));
  if (byId) return byId;
  const key = keyFromPayload(payload);
  if (!key) return null;
  return loadComplianceRuleWhere(and(
    eq(configPolicyComplianceRules.featureLinkId, key.featureLinkId),
    eq(configPolicyComplianceRules.name, key.ruleName),
  ));
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

function keyOf(rule: ResolvedComplianceRule): ComplianceKey {
  return { featureLinkId: rule.featureLinkId, ruleName: rule.name };
}

/**
 * The event is a wake-up, not the truth. The scheduled scan publishes only
 * after the transaction holding its automation_policy_compliance upsert has
 * committed (policyEvaluationService `deferEnqueue`), so the row is visible
 * here. A delayed or retried event that lands after a newer evaluation must act
 * on the persisted state.
 */
async function persistedCompliance(key: ComplianceKey, deviceId: string) {
  const [row] = await db
    .select({ status: automationPolicyCompliance.status, details: automationPolicyCompliance.details })
    .from(automationPolicyCompliance)
    .where(and(
      isNull(automationPolicyCompliance.policyId),
      eq(automationPolicyCompliance.configPolicyId, key.featureLinkId),
      eq(automationPolicyCompliance.configItemName, key.ruleName),
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
      // The conditions above only mark where the alert came from; the condition
      // registry cannot evaluate them. With auto-resolve on, the alert worker's
      // sweep read them as "no longer met" and closed every compliance alert
      // while the device was still failing. The bridge resolves these alerts
      // (handleConfigComplianceCompliant). Rows created before this change are
      // corrected by 2026-11-10-120100-config-compliance-alert-template-no-auto-resolve.sql.
      autoResolve: false,
      isBuiltIn: true,
      cooldownMinutes: COOLDOWN_MINUTES,
    })
    .returning({ id: alertTemplates.id });
  if (!created) throw new Error('[configComplianceAlertBridge] failed to create template');
  return created.id;
}

async function findRuleIds(orgId: string, names: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: alertRules.id })
    .from(alertRules)
    .where(and(
      eq(alertRules.orgId, orgId),
      inArray(alertRules.name, names),
      isNull(alertRules.retiredAt),
    ));
  return rows.map((r) => r.id);
}

/** Exported for testing (#7650 concurrent first-fire); handleConfigComplianceViolation calls it. */
export async function ensureRule(orgId: string, rule: ResolvedComplianceRule): Promise<string> {
  const key = keyOf(rule);
  const name = alertRuleNameFor(key);
  const [existing] = await findRuleIds(orgId, [name]);
  if (existing) return existing;

  const templateId = await ensureGlobalTemplate();
  // Concurrent first fire returns the winner's row, never a second rule (#7650).
  return insertBuiltInAlertRule({
    orgId,
    templateId,
    name,
    overrideSettings: {
      source: CONFIG_COMPLIANCE_ALERT_SOURCE,
      configPolicyFeatureLinkId: key.featureLinkId,
      configPolicyComplianceRuleName: key.ruleName,
      cooldownMinutes: COOLDOWN_MINUTES,
    },
  });
}

/**
 * Resolves every open alert this compliance rule raised on the device. Searches
 * ALL same-named rules for the org — the lazy ensureRule has no unique index, so
 * a race can leave two, and an alert under either must still clear — plus the
 * legacy id-keyed rule for `complianceRuleId`. `key` is null only when a
 * deleted rule's event carries no link or name.
 */
async function resolveOpenAlerts(
  orgId: string,
  key: ComplianceKey | null,
  complianceRuleId: string,
  deviceId: string,
  note: string,
) {
  const names = [legacyAlertRuleNameFor(complianceRuleId)];
  if (key) names.unshift(alertRuleNameFor(key));
  const ruleIds = await findRuleIds(orgId, names);
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

function warnMalformed(kind: string, orgId: string, payload: ConfigCompliancePayload): void {
  console.warn(
    `[configComplianceAlertBridge] dropping ${kind} compliance event with no deviceId/ruleId `
    + `(org ${orgId}, rule ${payload.configPolicyComplianceRuleId ?? 'NULL'}, device ${payload.deviceId ?? 'NULL'})`,
  );
}

export async function handleConfigComplianceViolation(orgId: string, payload: ConfigCompliancePayload): Promise<void> {
  const { configPolicyComplianceRuleId: complianceRuleId, deviceId } = payload;
  if (!complianceRuleId || !deviceId) {
    warnMalformed('violation', orgId, payload);
    return;
  }

  const rule = await loadEventRule(complianceRuleId, payload);
  if (!rule) return; // Rule deleted since the evaluation — nothing to alert on.
  if (!(await policyReachesOrg(rule, orgId))) return;

  const severity = severityForEnforcement(rule.enforcementLevel);
  if (severity === null) {
    // Report-only. If the rule was downgraded while an alert was open, clear it —
    // otherwise it would never resolve, since no later event re-raises it.
    await resolveOpenAlerts(orgId, keyOf(rule), rule.id, deviceId, 'Auto-resolved: compliance rule is now Monitor Only (report without alerting)');
    return;
  }

  const persisted = await persistedCompliance(keyOf(rule), deviceId);
  if (!persisted) {
    // The scan publishes only after its upsert commits, so a missing row means
    // the key no longer lines up (rule renamed, device purged), or an event was
    // published before its commit again, which would drop every first failing
    // check (the bug the deferral fixed).
    console.warn(
      `[configComplianceAlertBridge] no persisted compliance row for rule ${rule.id} `
      + `("${rule.name}", link ${rule.featureLinkId}) on device ${deviceId}; not alerting`,
    );
    return;
  }
  if (persisted.status !== 'non_compliant') {
    // Stale or reordered violation: a newer evaluation has moved on. Creating an
    // alert here would strand it with no later event to clear it.
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
  if (!complianceRuleId || !deviceId) {
    warnMalformed('compliant', orgId, payload);
    return;
  }

  // Resolution does not need the compliance rule to still exist: a deleted rule
  // must still be able to clear what it raised, so its key falls back to the
  // event's link and name. The alert rules searched are org-owned and keyed by
  // that link, so they can only match this org's alerts.
  const rule = await loadEventRule(complianceRuleId, payload);
  if (rule && !(await policyReachesOrg(rule, orgId))) return;
  const key = rule ? keyOf(rule) : keyFromPayload(payload);

  if (key) {
    const persisted = await persistedCompliance(key, deviceId);
    // `policy.compliant` is also published for an evaluation ERROR; an error is
    // not evidence the device recovered, and a reordered compliant event must
    // not clear a newer violation — including one recorded under the rule's new
    // id after a save. Only a persisted `compliant` (or no row) clears.
    if (persisted && persisted.status !== 'compliant') return;
  }

  await resolveOpenAlerts(orgId, key, complianceRuleId, deviceId, 'Auto-resolved: device returned to compliance');
}

function keyFromPayload(payload: ConfigCompliancePayload): ComplianceKey | null {
  const { configPolicyId: featureLinkId, configPolicyComplianceRuleName: ruleName } = payload;
  return featureLinkId && ruleName ? { featureLinkId, ruleName } : null;
}
