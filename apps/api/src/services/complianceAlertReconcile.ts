/**
 * Closes compliance alerts whose rule no longer applies.
 *
 * Compliance alerts do not auto-resolve (#7518): the alert worker's sweep
 * cannot evaluate a compliance rule. They close on a compliance event —
 * policy.compliant, or a violation for a rule downgraded to monitor. A rule
 * that stops applying is never evaluated again, so it never sends that event,
 * and without this module its alert stayed open forever:
 *
 *   - configuration policies (configComplianceAlertBridge.ts): the rule set was
 *     renamed or removed, the compliance feature was removed, the policy was
 *     deleted, deactivated or unassigned, or the device is now governed by
 *     another policy (moved site/org/group, a closer assignment, a role or OS
 *     filter);
 *   - automation policies (policyAlertBridge.ts): the policy was disabled or
 *     deleted, or no longer targets the device.
 *
 * "Applies" is decided exactly the way the evaluators decide what to evaluate:
 * `resolveComplianceAssignmentForDevice` (the scan's
 * `resolveComplianceRulesForDevice`) and evaluatePolicy's target resolution.
 * So an alert is closed only for a rule the evaluator will not look at again;
 * a rule that still applies keeps its alert whatever its state, and closes
 * through the bridge. Resolution is per DEVICE: a partner-wide policy is judged
 * against each device's own hierarchy, the same way it fanned out.
 *
 * Runs from the `reconcile-compliance-alerts` job (policyEvaluationWorker):
 * scoped, after a config write (complianceAlertReconcileTrigger.ts), and
 * unscoped every 15 minutes as the safety net for paths with no hook. Each
 * device and each automation policy is reconciled in its own short system
 * transaction, so one failure cannot hold back the rest.
 */
import { and, asc, eq, gt, inArray, like, sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  alertRules,
  alerts,
  automationPolicies,
  configPolicyComplianceRules,
  configPolicyFeatureLinks,
  configurationPolicies,
  organizations,
} from '../db/schema';
import { resolveAlert, RESOLVABLE_ALERT_STATUSES } from './alertService';
import { CONFIG_COMPLIANCE_ALERT_SOURCE, CONFIG_COMPLIANCE_RULE_PREFIX } from './configComplianceAlertBridge';
import { resolveComplianceAssignmentForDevice, type ResolvedDeviceComplianceRules } from './featureConfigResolver';
import { POLICY_ALERT_SOURCE, POLICY_RULE_PREFIX } from './policyAlertBridge';
import { automationPolicyTargetedDeviceIds } from './policyEvaluationService';
import { captureException } from './sentry';
import type { ComplianceAlertReconcileScope } from './complianceAlertReconcileTrigger';

const { db, withSystemDbAccessContext } = dbModule;

/** Devices whose open configuration-policy compliance alerts one run checks at most. */
const MAX_DEVICES_PER_RUN = 2000;
const DEVICE_PAGE_SIZE = 100;
const RESOLUTION_PREFIX = 'Rule no longer applies';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ComplianceAlertReconcileResult = {
  /** Devices with an open configuration-policy compliance alert that were checked. */
  devicesChecked: number;
  /** Automation policies with an open alert that were checked. */
  policiesChecked: number;
  alertsResolved: number;
  /**
   * Set when the run stopped at `maxDevices` with devices left: pass it as
   * `afterDeviceId` to continue. Null once every device in scope was checked.
   */
  nextDeviceCursor: string | null;
};

type AlertScope = 'all' | { orgIds: string[] } | { partnerId: string };

type OpenAlert = {
  id: string;
  deviceId: string;
  context: Record<string, unknown> | null;
  overrideSettings: Record<string, unknown> | null;
};

const OPEN_ALERT_COLUMNS = {
  id: alerts.id,
  deviceId: alerts.deviceId,
  context: alerts.context,
  overrideSettings: alertRules.overrideSettings,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toOpenAlert(row: { id: string; deviceId: string; context: unknown; overrideSettings: unknown }): OpenAlert {
  return { id: row.id, deviceId: row.deviceId, context: asRecord(row.context), overrideSettings: asRecord(row.overrideSettings) };
}

export async function reconcileComplianceAlerts(
  scope?: ComplianceAlertReconcileScope,
  options: { maxDevices?: number; afterDeviceId?: string | null } = {},
): Promise<ComplianceAlertReconcileResult> {
  const alertScope = await resolveAlertScope(scope);
  if (!alertScope) {
    return { devicesChecked: 0, policiesChecked: 0, alertsResolved: 0, nextDeviceCursor: null };
  }
  const config = await reconcileConfigPolicyAlerts(alertScope, options.maxDevices ?? MAX_DEVICES_PER_RUN, options.afterDeviceId ?? null);
  const automation = await reconcileAutomationPolicyAlerts(alertScope);
  const result = {
    devicesChecked: config.devicesChecked,
    policiesChecked: automation.policiesChecked,
    alertsResolved: config.alertsResolved + automation.alertsResolved,
    nextDeviceCursor: config.nextDeviceCursor,
  };
  if (result.alertsResolved > 0) {
    console.log(
      `[complianceAlertReconcile] closed ${result.alertsResolved} alert(s) whose rule no longer applies `
      + `(${result.devicesChecked} device(s), ${result.policiesChecked} automation polic(ies) checked)`,
    );
  }
  return result;
}

/**
 * A policy id becomes its owner's scope. A policy deleted since the write that
 * scheduled this run is skipped: its delete scheduled a run for its owner.
 */
async function resolveAlertScope(scope: ComplianceAlertReconcileScope | undefined): Promise<AlertScope | null> {
  if (!scope) return 'all';
  if ('orgId' in scope) return { orgIds: [scope.orgId] };
  if ('partnerId' in scope) return { partnerId: scope.partnerId };
  const [policy] = await withSystemDbAccessContext(() => db
    .select({ orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId })
    .from(configurationPolicies)
    .where(eq(configurationPolicies.id, scope.configPolicyId))
    .limit(1));
  if (!policy) return null;
  if (policy.orgId) return { orgIds: [policy.orgId] };
  return policy.partnerId ? { partnerId: policy.partnerId } : null;
}

function alertOrgCondition(scope: AlertScope): SQL | undefined {
  if (scope === 'all') return undefined;
  if ('orgIds' in scope) return inArray(alerts.orgId, scope.orgIds);
  return inArray(
    alerts.orgId,
    db.select({ id: organizations.id }).from(organizations).where(eq(organizations.partnerId, scope.partnerId)),
  );
}

/** Open alerts raised by one of the two bridges: its rule name prefix AND its source marker. */
function openBridgeAlertCondition(rulePrefix: string, source: string, scope: AlertScope): SQL {
  return and(
    like(alertRules.name, `${rulePrefix}:%`),
    sql`${alertRules.overrideSettings}->>'source' = ${source}`,
    inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
    alertOrgCondition(scope),
  )!;
}

async function closeAlert(alertId: string, reason: string): Promise<boolean> {
  return resolveAlert(alertId, `${RESOLUTION_PREFIX}: ${reason}`, undefined, false, 'source_retired');
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function reportFailure(what: string, error: unknown): void {
  console.error(`[complianceAlertReconcile] ${what} failed; the next run retries it:`, error);
  captureException(error);
}

// ── Configuration policies ──────────────────────────────────────────────────

type ComplianceKey = { featureLinkId: string; ruleName: string };

const keyString = (key: ComplianceKey) => `${key.featureLinkId}\u0000${key.ruleName}`;

/**
 * The (feature link, rule set name) an alert stands for: what the bridge keys
 * the alert on, and what stays the same when a save re-creates the rule set.
 * Every alert the bridge raises carries it in its context.
 */
function complianceKeyOf(alert: OpenAlert): ComplianceKey | null {
  const featureLinkId = stringField(alert.context, 'configPolicyFeatureLinkId')
    ?? stringField(alert.overrideSettings, 'configPolicyFeatureLinkId');
  const ruleName = stringField(alert.context, 'configPolicyComplianceRuleName')
    ?? stringField(alert.overrideSettings, 'configPolicyComplianceRuleName');
  return featureLinkId && ruleName ? { featureLinkId, ruleName } : null;
}

async function reconcileConfigPolicyAlerts(
  scope: AlertScope,
  maxDevices: number,
  afterDeviceId: string | null,
): Promise<{ devicesChecked: number; alertsResolved: number; nextDeviceCursor: string | null }> {
  const condition = openBridgeAlertCondition(CONFIG_COMPLIANCE_RULE_PREFIX, CONFIG_COMPLIANCE_ALERT_SOURCE, scope);
  let cursor = afterDeviceId;
  let devicesChecked = 0;
  let alertsResolved = 0;

  while (devicesChecked < maxDevices) {
    const pageSize = Math.min(DEVICE_PAGE_SIZE, maxDevices - devicesChecked);
    const page = await withSystemDbAccessContext(() => db
      .selectDistinct({ deviceId: alerts.deviceId })
      .from(alerts)
      .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
      .where(and(condition, cursor ? gt(alerts.deviceId, cursor) : undefined))
      .orderBy(asc(alerts.deviceId))
      .limit(pageSize));

    for (const { deviceId } of page) {
      try {
        alertsResolved += await withSystemDbAccessContext(() => reconcileConfigDevice(deviceId, condition));
      } catch (error) {
        reportFailure(`reconciling compliance alerts on device ${deviceId}`, error);
      }
    }
    devicesChecked += page.length;
    if (page.length < pageSize) return { devicesChecked, alertsResolved, nextDeviceCursor: null };
    cursor = page[page.length - 1]!.deviceId;
  }
  return { devicesChecked, alertsResolved, nextDeviceCursor: cursor };
}

/** One resolver lookup for the device, then a reason for each alert whose rule it no longer follows. */
async function reconcileConfigDevice(deviceId: string, condition: SQL): Promise<number> {
  const open = (await db
    .select(OPEN_ALERT_COLUMNS)
    .from(alerts)
    .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
    .where(and(condition, eq(alerts.deviceId, deviceId)))).map(toOpenAlert);
  if (open.length === 0) return 0;

  const assignment = await resolveComplianceAssignmentForDevice(deviceId);
  const applying = new Set((assignment?.rules ?? []).map((rule) => keyString({ featureLinkId: rule.featureLinkId, ruleName: rule.name })));

  let resolved = 0;
  for (const alert of open) {
    const key = complianceKeyOf(alert);
    if (!key) {
      console.warn(`[complianceAlertReconcile] compliance alert ${alert.id} names no feature link or rule set; leaving it open`);
      continue;
    }
    if (applying.has(keyString(key))) continue;
    const reason = await whyConfigRuleNoLongerApplies(key, alert, assignment);
    if (await closeAlert(alert.id, reason)) resolved += 1;
  }
  return resolved;
}

async function whyConfigRuleNoLongerApplies(
  key: ComplianceKey,
  alert: OpenAlert,
  assignment: ResolvedDeviceComplianceRules | null,
): Promise<string> {
  const [link] = await db
    .select({ policyName: configurationPolicies.name, policyStatus: configurationPolicies.status })
    .from(configPolicyFeatureLinks)
    .innerJoin(configurationPolicies, eq(configurationPolicies.id, configPolicyFeatureLinks.configPolicyId))
    .where(eq(configPolicyFeatureLinks.id, key.featureLinkId))
    .limit(1);

  if (!link) {
    const policyId = stringField(alert.context, 'configPolicyId');
    const [policy] = policyId && UUID_RE.test(policyId)
      ? await db
        .select({ name: configurationPolicies.name })
        .from(configurationPolicies)
        .where(eq(configurationPolicies.id, policyId))
        .limit(1)
      : [];
    if (policy) return `the compliance feature was removed from configuration policy "${policy.name}"`;
    return `configuration policy "${stringField(alert.context, 'configPolicyName') ?? 'unknown'}" was deleted`;
  }

  const [ruleSet] = await db
    .select({ id: configPolicyComplianceRules.id })
    .from(configPolicyComplianceRules)
    .where(and(
      eq(configPolicyComplianceRules.featureLinkId, key.featureLinkId),
      eq(configPolicyComplianceRules.name, key.ruleName),
    ))
    .limit(1);
  if (!ruleSet) return `rule set "${key.ruleName}" was renamed or removed in configuration policy "${link.policyName}"`;

  if (link.policyStatus !== 'active') return `configuration policy "${link.policyName}" is ${link.policyStatus}`;

  // The rule set exists in an active policy, and the device's own resolution
  // does not reach it: either another policy's assignment wins for the device
  // now, or no assignment of this policy reaches it any more.
  if (assignment && !assignment.rules.some((rule) => rule.featureLinkId === key.featureLinkId)) {
    return `configuration policy "${assignment.configPolicyName}" now takes precedence for this device`;
  }
  return `configuration policy "${link.policyName}" is no longer assigned to this device`;
}

// ── Automation policies ─────────────────────────────────────────────────────

async function reconcileAutomationPolicyAlerts(scope: AlertScope): Promise<{ policiesChecked: number; alertsResolved: number }> {
  const condition = openBridgeAlertCondition(POLICY_RULE_PREFIX, POLICY_ALERT_SOURCE, scope);
  const rows = await withSystemDbAccessContext(() => db
    .selectDistinct({ policyId: sql<string | null>`${alertRules.overrideSettings}->>'policyId'` })
    .from(alerts)
    .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
    .where(condition));

  let alertsResolved = 0;
  let policiesChecked = 0;
  for (const { policyId } of rows) {
    if (!policyId || !UUID_RE.test(policyId)) continue;
    policiesChecked += 1;
    try {
      alertsResolved += await withSystemDbAccessContext(() => reconcileAutomationPolicy(policyId, condition));
    } catch (error) {
      reportFailure(`reconciling alerts of automation policy ${policyId}`, error);
    }
  }
  return { policiesChecked, alertsResolved };
}

async function reconcileAutomationPolicy(policyId: string, condition: SQL): Promise<number> {
  const open = (await db
    .select(OPEN_ALERT_COLUMNS)
    .from(alerts)
    .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
    .where(and(condition, sql`${alertRules.overrideSettings}->>'policyId' = ${policyId}`))).map(toOpenAlert);
  if (open.length === 0) return 0;

  const [policy] = await db.select().from(automationPolicies).where(eq(automationPolicies.id, policyId)).limit(1);

  let reasonFor: (alert: OpenAlert) => string | null;
  if (!policy) {
    reasonFor = (alert) => `automation policy "${stringField(alert.context, 'policyName')
      ?? stringField(alert.overrideSettings, 'policyName') ?? 'unknown'}" was deleted`;
  } else if (!policy.enabled) {
    reasonFor = () => `automation policy "${policy.name}" is disabled`;
  } else {
    const targeted = await automationPolicyTargetedDeviceIds(policy, [...new Set(open.map((a) => a.deviceId))]);
    reasonFor = (alert) => (targeted.has(alert.deviceId)
      ? null
      : `this device is no longer targeted by automation policy "${policy.name}"`);
  }

  let resolved = 0;
  for (const alert of open) {
    const reason = reasonFor(alert);
    if (reason && await closeAlert(alert.id, reason)) resolved += 1;
  }
  return resolved;
}
