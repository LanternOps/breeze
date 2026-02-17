import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  alertRules,
  alertTemplates,
  alerts,
  notificationChannels,
  escalationPolicies,
} from '../../db/schema';
import {
  validateEmailConfig,
  validateWebhookConfig,
  validateSmsConfig,
  validatePagerDutyConfig,
} from '../../services/notificationSenders';

export type AlertRuleRow = typeof alertRules.$inferSelect;
export type AlertTemplateRow = typeof alertTemplates.$inferSelect;

export type AlertRuleOverrides = {
  description?: string;
  severity?: string;
  conditions?: unknown;
  cooldownMinutes?: number;
  cooldown?: number;
  autoResolve?: boolean;
  notificationChannelIds?: string[];
  notificationChannels?: string[];
  escalationPolicyId?: string;
  targets?: {
    type?: string;
    ids?: string[];
  };
  targetIds?: string[];
  templateOwned?: boolean;
  updatedAt?: string;
};

export { getPagination } from '../../utils/pagination';

export function ensureOrgAccess(orgId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  return auth.canAccessOrg(orgId);
}

export async function getAlertRuleWithOrgCheck(ruleId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [rule] = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, ruleId))
    .limit(1);

  if (!rule) {
    return null;
  }

  const hasAccess = ensureOrgAccess(rule.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return rule;
}

export async function getAlertWithOrgCheck(alertId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) {
    return null;
  }

  const hasAccess = ensureOrgAccess(alert.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return alert;
}

export async function getNotificationChannelWithOrgCheck(channelId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.id, channelId))
    .limit(1);

  if (!channel) {
    return null;
  }

  const hasAccess = ensureOrgAccess(channel.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return channel;
}

export async function getEscalationPolicyWithOrgCheck(policyId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [policy] = await db
    .select()
    .from(escalationPolicies)
    .where(eq(escalationPolicies.id, policyId))
    .limit(1);

  if (!policy) {
    return null;
  }

  const hasAccess = ensureOrgAccess(policy.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return policy;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getOverrides(value: unknown): AlertRuleOverrides {
  return isRecord(value) ? value as AlertRuleOverrides : {};
}

export function normalizeTargetsForRule(
  data: {
    targets?: { type?: string; ids?: string[] };
    targetType?: string;
    targetId?: string;
  },
  orgId: string
) {
  const inputTargets = data.targets ?? (data.targetType ? { type: data.targetType, ids: data.targetId ? [data.targetId] : [] } : { type: 'all', ids: [] });
  const targetType = inputTargets.type ?? 'all';
  const targetIds = Array.isArray(inputTargets.ids) ? inputTargets.ids.filter(Boolean) : [];
  let targetId: string | undefined;

  if (targetType === 'all' || targetType === 'org') {
    targetId = orgId;
  } else {
    targetId = targetIds[0] ?? data.targetId;
  }

  return {
    targetType,
    targetId,
    targetIds,
    targets: {
      type: targetType,
      ids: targetIds.length > 0 ? targetIds : (targetType === 'all' || targetType === 'org') ? [] : targetIds
    }
  };
}

export function getNotificationChannelIds(overrides: AlertRuleOverrides) {
  if (Array.isArray(overrides.notificationChannelIds)) return overrides.notificationChannelIds;
  if (Array.isArray(overrides.notificationChannels)) return overrides.notificationChannels;
  return [];
}

export function containsNotificationBindingOverride(value: unknown) {
  return isRecord(value)
    && ('notificationChannelIds' in value
      || 'notificationChannels' in value
      || 'escalationPolicyId' in value);
}

export function validateNotificationChannelConfig(
  type: 'email' | 'slack' | 'teams' | 'webhook' | 'pagerduty' | 'sms',
  config: unknown
): string[] {
  if (!isRecord(config)) {
    return ['Config must be an object'];
  }

  if (type === 'email') {
    return validateEmailConfig(config).errors;
  }

  if (type === 'webhook') {
    return validateWebhookConfig(config).errors;
  }

  if (type === 'sms') {
    return validateSmsConfig(config).errors;
  }

  if (type === 'slack' || type === 'teams') {
    const webhookUrl = (config as { webhookUrl?: unknown }).webhookUrl;
    if (typeof webhookUrl !== 'string' || webhookUrl.length === 0) {
      return [`${type} webhookUrl must be a non-empty string`];
    }

    return validateWebhookConfig({ url: webhookUrl, method: 'POST' }).errors;
  }

  if (type === 'pagerduty') {
    return validatePagerDutyConfig(config).errors;
  }

  return [];
}

export async function validateAlertRuleNotificationBindings(
  orgId: string,
  overrides: AlertRuleOverrides
): Promise<string | null> {
  const requestedChannelIds = [...new Set(getNotificationChannelIds(overrides).filter(Boolean))];
  if (requestedChannelIds.length > 0) {
    const channels = await db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(
        and(
          eq(notificationChannels.orgId, orgId),
          inArray(notificationChannels.id, requestedChannelIds)
        )
      );

    if (channels.length !== requestedChannelIds.length) {
      return 'Notification channels must belong to the same organization as the alert rule';
    }
  }

  if (typeof overrides.escalationPolicyId === 'string' && overrides.escalationPolicyId.length > 0) {
    const [policy] = await db
      .select({ id: escalationPolicies.id })
      .from(escalationPolicies)
      .where(
        and(
          eq(escalationPolicies.id, overrides.escalationPolicyId),
          eq(escalationPolicies.orgId, orgId)
        )
      )
      .limit(1);

    if (!policy) {
      return 'Escalation policy must belong to the same organization as the alert rule';
    }
  }

  return null;
}

export function formatAlertRuleResponse(rule: AlertRuleRow, template?: AlertTemplateRow | null) {
  const overrides = getOverrides(rule.overrideSettings);
  const overrideTargets = overrides.targets;
  const targetType = overrideTargets?.type ?? rule.targetType ?? 'all';
  const targetIds = Array.isArray(overrideTargets?.ids)
    ? overrideTargets?.ids
    : Array.isArray(overrides.targetIds)
      ? overrides.targetIds
      : (targetType === 'all' || targetType === 'org') ? [] : [rule.targetId];

  const notificationChannelIds = getNotificationChannelIds(overrides);
  const severity = overrides.severity ?? template?.severity ?? 'medium';
  const cooldownMinutes = overrides.cooldownMinutes ?? overrides.cooldown ?? template?.cooldownMinutes ?? 15;
  const autoResolve = overrides.autoResolve ?? template?.autoResolve ?? false;

  return {
    id: rule.id,
    orgId: rule.orgId,
    name: rule.name,
    description: overrides.description ?? template?.description ?? null,
    enabled: rule.isActive,
    isActive: rule.isActive,
    severity,
    targets: {
      type: targetType,
      ids: targetIds
    },
    targetType: rule.targetType,
    targetId: rule.targetId,
    conditions: overrides.conditions ?? template?.conditions ?? [],
    cooldownMinutes,
    autoResolve,
    escalationPolicyId: overrides.escalationPolicyId ?? null,
    notificationChannelIds,
    notificationChannels: notificationChannelIds,
    templateId: rule.templateId,
    templateName: template?.name,
    createdAt: rule.createdAt,
    updatedAt: overrides.updatedAt ?? rule.createdAt
  };
}

export async function resolveAlertTemplate(params: {
  templateId?: string;
  orgId: string;
  name?: string;
  description?: string;
  severity?: string;
  conditions?: unknown;
  cooldownMinutes?: number;
  autoResolve?: boolean;
}) {
  const templateName = params.name?.trim() || 'Custom Alert Template';
  const templateSeverity = (params.severity ?? 'medium') as AlertTemplateRow['severity'];
  const templateConditions = params.conditions ?? {};
  const templateCooldownMinutes = params.cooldownMinutes ?? 15;
  const templateAutoResolve = params.autoResolve ?? false;

  if (params.templateId) {
    const [existing] = await db
      .select()
      .from(alertTemplates)
      .where(eq(alertTemplates.id, params.templateId))
      .limit(1);

    if (existing) {
      return { template: existing, created: false };
    }

    const [createdTemplate] = await db
      .insert(alertTemplates)
      .values({
        id: params.templateId,
        orgId: params.orgId,
        name: templateName,
        description: params.description,
        conditions: templateConditions,
        severity: templateSeverity,
        titleTemplate: `${templateName} alert`,
        messageTemplate: `Alert triggered for ${templateName}.`,
        autoResolve: templateAutoResolve,
        cooldownMinutes: templateCooldownMinutes,
        isBuiltIn: false
      })
      .returning();

    return { template: createdTemplate, created: true };
  }

  const [createdTemplate] = await db
    .insert(alertTemplates)
    .values({
      orgId: params.orgId,
      name: templateName,
      description: params.description,
      conditions: templateConditions,
      severity: templateSeverity,
      titleTemplate: `${templateName} alert`,
      messageTemplate: `Alert triggered for ${templateName}.`,
      autoResolve: templateAutoResolve,
      cooldownMinutes: templateCooldownMinutes,
      isBuiltIn: false
    })
    .returning();

  return { template: createdTemplate, created: true };
}
