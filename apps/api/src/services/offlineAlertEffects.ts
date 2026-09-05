/** Offline-only durable alert admission. DB preparation and admission never await Redis. */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { alerts, alertRules, alertTemplates, configPolicyAlertRules, devices, offlineTransitionEffects as effects, type OfflineEffect } from '../db/schema';
import { alertRuleOwnershipConditionForOrg, getApplicableRulesFromPolicy } from './alertService';
import { evaluateConditions, interpolateTemplate } from './alertConditions';
import { resolveMaintenanceConfigForDevice, isInMaintenanceWindow } from './featureConfigResolver';
import { getRedisConnection } from './redis';
import { enqueueAlertCorrelation } from '../jobs/alertCorrelation';
import { finishOfflineEffect, insertOfflineEffect, lockCurrentOfflineObservation, offlineEffectId, withOfflineEffectLease } from './offlineEffectsStore';
import type { OfflineObservation, OfflineRulePlan } from './offlineEffectsTypes';
import { applyOfflineAlertPostprocess, readOfflineAlertRedisSuppression } from './offlineAlertPostprocess';

function hasOfflineCondition(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOfflineCondition);
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.type === 'offline' || (Array.isArray(v.conditions) && v.conditions.some(hasOfflineCondition));
}

export async function expandOfflineAlertPlan(effect: OfflineEffect): Promise<string[]> {
  const payload = effect.payload;
  if (payload.type !== 'alert-plan') throw new Error('Expected alert plan');
  const children: string[] = [];
  await withOfflineEffectLease(effect, async () => {
    const device = await lockCurrentOfflineObservation(payload.observation);
    if (!device) return finishOfflineEffect(effect);
    const ownership = await alertRuleOwnershipConditionForOrg(device.orgId);
    const rules = await db.select({ rule: alertRules, template: alertTemplates }).from(alertRules)
      .innerJoin(alertTemplates, eq(alertRules.templateId, alertTemplates.id))
      .where(and(ownership, eq(alertRules.isActive, true), or(
        eq(alertRules.targetType, 'all'),
        and(eq(alertRules.targetType, 'org'), eq(alertRules.targetId, device.orgId)),
        and(eq(alertRules.targetType, 'site'), eq(alertRules.targetId, device.siteId)),
        and(eq(alertRules.targetType, 'device'), eq(alertRules.targetId, device.id)),
      )));
    const plans: OfflineRulePlan[] = [];
    for (const { rule, template } of rules) {
      const overrides = rule.overrideSettings as Record<string, unknown> | null;
      const conditions = overrides?.conditions ?? template.conditions;
      if (!hasOfflineCondition(conditions)) continue;
      plans.push({
        ruleId: rule.id, policy: false, name: rule.name, templateId: template.id,
        conditions, severity: (overrides?.severity as OfflineRulePlan['severity']) ?? template.severity,
        titleTemplate: template.titleTemplate, messageTemplate: template.messageTemplate,
        cooldownMinutes: (overrides?.cooldownMinutes as number) ?? template.cooldownMinutes,
      });
    }
    const policyRules = await getApplicableRulesFromPolicy(device.id);
    for (const rule of policyRules) plans.push({ ...rule, ruleId: rule.id, policy: true });
    for (const rule of plans) {
      children.push(await insertOfflineEffect(effect, { type: 'alert-rule', observation: payload.observation, rule }, rule.ruleId));
    }
    await finishOfflineEffect(effect);
  });
  return children;
}

async function prepareRule(observation: OfflineObservation, rule: OfflineRulePlan) {
  return withSystemDbAccessContext(async () => {
    const [sourceDevice] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, observation.deviceId), eq(devices.orgId, observation.orgId)));
    if (!sourceDevice) return null;
    // Read current eligibility without holding a device lock across Redis work.
    const table = rule.policy ? configPolicyAlertRules : alertRules;
    const [exists] = await db.select({ id: table.id }).from(table).where(eq(table.id, rule.ruleId));
    if (!exists) return null;
    if (rule.policy) {
      const maintenance = await resolveMaintenanceConfigForDevice(observation.deviceId);
      const status = maintenance ? isInMaintenanceWindow(maintenance) : null;
      if (status?.active && status.suppressAlerts) return null;
      const result = await evaluateConditions(rule.conditions, observation.deviceId);
      if (!result.triggered) return null;
      return result;
    }
    return { triggered: true, conditionsMet: ['Device offline'], conditionsNotMet: [], context: {} };
  }, 'offlineAlerts.prepare');
}

/** Durable receipts remain authoritative while postprocess is delayed or unavailable. */
async function durableSuppression(effect: OfflineEffect, rule: OfflineRulePlan) {
  const [summary] = await db.select({
    cooling: sql<boolean>`coalesce(bool_or(${effects.cooldownUntil} > clock_timestamp()), false)`,
    triggers: sql<number>`count(*) FILTER (WHERE ${effects.createdAt} > clock_timestamp() - interval '10 minutes' AND ${effects.payload}->>'recordTrigger' = 'true')::int`,
  }).from(effects).where(and(
    eq(effects.deviceId, effect.deviceId), eq(effects.orgId, effect.orgId),
    eq(effects.ruleId, rule.ruleId), eq(effects.kind, 'alert-postprocess'),
    or(sql`${effects.cooldownUntil} > clock_timestamp()`, sql`${effects.createdAt} > clock_timestamp() - interval '1 hour'`),
  ));
  const [latest] = await db.select({ payload: effects.payload }).from(effects).where(and(
    eq(effects.deviceId, effect.deviceId), eq(effects.orgId, effect.orgId),
    eq(effects.ruleId, rule.ruleId), eq(effects.kind, 'alert-postprocess'),
    sql`${effects.createdAt} > clock_timestamp() - interval '1 hour'`,
  )).orderBy(sql`${effects.createdAt} DESC`).limit(1);
  const [resolved] = await db.select({ count: sql<number>`count(*)::int` }).from(alerts).where(and(
    eq(alerts.deviceId, effect.deviceId), eq(alerts.orgId, effect.orgId),
    rule.policy ? eq(alerts.configPolicyId, rule.ruleId) : eq(alerts.ruleId, rule.ruleId),
    sql`${alerts.resolvedAt} > clock_timestamp() - interval '10 minutes'`,
  ));
  const multiplier = !rule.policy && latest?.payload.type === 'alert-postprocess'
    ? Math.min(latest.payload.multiplier * 2, 4) : 1;
  return { cooling: summary?.cooling ?? false, flapping: (summary?.triggers ?? 0) + (resolved?.count ?? 0) >= 4, multiplier };
}

export async function admitOfflineAlertRule(effect: OfflineEffect): Promise<string[]> {
  const payload = effect.payload;
  if (payload.type !== 'alert-rule') throw new Error('Expected alert rule');
  const { observation, rule } = payload;
  if (!Number.isInteger(rule.cooldownMinutes) || rule.cooldownMinutes < 0 || rule.cooldownMinutes > 10080) {
    throw new Error('Invalid offline alert cooldown');
  }
  const children: string[] = [];
  const prepared = await prepareRule(observation, rule);
  // Redis reads only; a timeout leaves the task pending. No fallback that could
  // acknowledge missing cooldown state as an intentional successful skip.
  const redis = prepared ? await readOfflineAlertRedisSuppression(getRedisConnection(), effect.deviceId, rule) : null;
  await withOfflineEffectLease(effect, async () => {
    const device = await lockCurrentOfflineObservation(observation);
    if (!device || !prepared) return finishOfflineEffect(effect);
    const table = rule.policy ? configPolicyAlertRules : alertRules;
    const [exists] = await db.select({ id: table.id }).from(table).where(eq(table.id, rule.ruleId));
    if (!exists) return finishOfflineEffect(effect);
    const durable = await durableSuppression(effect, rule);
    if (durable.cooling || redis?.cooling) return finishOfflineEffect(effect);
    const [open] = await db.select({ id: alerts.id }).from(alerts).where(and(
      eq(alerts.deviceId, device.id), rule.policy ? eq(alerts.configPolicyId, rule.ruleId) : eq(alerts.ruleId, rule.ruleId),
      inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
    )).limit(1);
    if (open) return finishOfflineEffect(effect);
    const flapping = durable.flapping || redis?.flapping === true;
    const multiplier = Math.max(durable.multiplier, redis?.multiplier ?? 1);
    const occurredAt = new Date().toISOString();
    const cooldownUntil = new Date(new Date(occurredAt).getTime() + rule.cooldownMinutes * multiplier * 60_000);
    const alertId = flapping ? null : offlineEffectId(effect.transitionId, 'alert', rule.ruleId);
    if (alertId) {
      const context = {
        deviceName: device.displayName || device.hostname, hostname: device.hostname,
        osType: device.osType, osVersion: device.osVersion, ruleName: rule.name, severity: rule.severity,
        lastSeenAt: observation.observedLastSeenAt, ...prepared.context,
      };
      const title = interpolateTemplate(rule.titleTemplate, context);
      const message = interpolateTemplate(rule.messageTemplate, context);
      const [inserted] = await db.insert(alerts).values({
        id: alertId, ruleId: rule.policy ? null : rule.ruleId,
        configPolicyId: rule.policy ? rule.ruleId : null, configItemName: rule.policy ? rule.name : null,
        deviceId: device.id, orgId: device.orgId, severity: rule.severity, title, message,
        status: 'active', triggeredAt: new Date(occurredAt),
        context: { ...context, conditionsMet: prepared.conditionsMet, conditionsNotMet: prepared.conditionsNotMet,
          cooldownMinutes: rule.cooldownMinutes, ...(rule.policy ? { source: 'config_policy' } : { templateId: rule.templateId }) },
      }).onConflictDoNothing().returning({ id: alerts.id });
      // Existing stable alert identity means this observation already admitted it,
      // even if it is now resolved; never reconstruct consequences from current config.
      if (!inserted) return finishOfflineEffect(effect);
      children.push(await insertOfflineEffect(effect, {
        type: 'alert-event', siteId: device.siteId, occurredAt,
        event: { alertId, deviceId: device.id, severity: rule.severity, title, message,
          ...(rule.policy ? { configPolicyAlertRuleId: rule.ruleId, configItemName: rule.name, source: 'config_policy' } : { ruleId: rule.ruleId }) },
      }, rule.ruleId));
    }
    children.push(await insertOfflineEffect(effect, {
      type: 'alert-postprocess', ruleId: rule.ruleId, policy: rule.policy, alertId,
      occurredAt, multiplier, recordTrigger: !flapping,
    }, rule.ruleId, cooldownUntil));
    await finishOfflineEffect(effect);
  });
  return children;
}

export async function postprocessOfflineAlert(effect: OfflineEffect): Promise<void> {
  const payload = effect.payload;
  if (payload.type !== 'alert-postprocess') throw new Error('Expected alert postprocess');
  const owned = await withSystemDbAccessContext(() => db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, effect.deviceId), eq(devices.orgId, effect.orgId))), 'offlineAlerts.postprocessOwner');
  if (!owned.length) return;
  await applyOfflineAlertPostprocess(getRedisConnection(), effect);
  if (payload.alertId) await enqueueAlertCorrelation({ orgId: effect.orgId, deviceId: effect.deviceId });
}
