import type { AlertRule } from './schemas';
import { builtInTemplates, customTemplates, customTemplateOrgById, alertRules, correlationAlerts, correlationLinks, correlationGroups } from './data';
import { getPagination } from '../../utils/pagination';

export { getPagination } from '../../utils/pagination';

export function paginate<T>(items: T[], query: { page?: string; limit?: string }) {
  const { page, limit, offset } = getPagination(query);
  return {
    data: items.slice(offset, offset + limit),
    page,
    limit,
    total: items.length
  };
}

export function parseBoolean(value?: string) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function resolveScopedOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId?: string | null;
    accessibleOrgIds?: string[] | null;
  }
) {
  if (auth.orgId) {
    return auth.orgId;
  }

  if (auth.scope === 'partner' && Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  return null;
}

export function getAllTemplates(orgId: string) {
  return [
    ...builtInTemplates,
    ...[...customTemplates.values()].filter((template) => customTemplateOrgById.get(template.id) === orgId)
  ];
}

export function getTemplateById(templateId: string, orgId: string) {
  const builtIn = builtInTemplates.find((template) => template.id === templateId);
  if (builtIn) {
    return builtIn;
  }

  const customTemplate = customTemplates.get(templateId);
  if (!customTemplate) {
    return null;
  }

  if (customTemplateOrgById.get(templateId) !== orgId) {
    return null;
  }

  return customTemplate;
}

export function isBuiltInTemplate(templateId: string) {
  return builtInTemplates.some((template) => template.id === templateId);
}

export function getRuleForOrg(ruleId: string, orgId: string) {
  const rule = alertRules.get(ruleId);
  if (!rule || rule.orgId !== orgId) {
    return null;
  }
  return rule;
}

export function matchesTargetFilter(rule: AlertRule, targetType?: string, targetValue?: string) {
  if (!targetType) return true;

  const targets = rule.targets;
  if (targetType === 'tag') {
    return Boolean(targetValue && targets.tags?.includes(targetValue));
  }

  if (targetType === 'device') {
    return Boolean(targetValue && targets.deviceIds?.includes(targetValue));
  }

  if (targetType === 'site') {
    return Boolean(targetValue && targets.siteIds?.includes(targetValue));
  }

  if (targetType === 'organization') {
    if (!targetValue) {
      return targets.scope === 'organization';
    }
    return targets.orgId === targetValue;
  }

  return true;
}

export function getScopedCorrelationAlerts(orgId: string) {
  return correlationAlerts.filter((alert) => {
    const rule = alertRules.get(alert.ruleId);
    return rule?.orgId === orgId;
  });
}

export function getCorrelationLinksForAlert(alertId: string) {
  return correlationLinks.filter(
    (link) => link.alertId === alertId || link.relatedAlertId === alertId
  );
}

export function getRelatedAlerts(alertId: string) {
  const relatedIds = new Set<string>();
  for (const link of getCorrelationLinksForAlert(alertId)) {
    relatedIds.add(link.alertId === alertId ? link.relatedAlertId : link.alertId);
  }
  return correlationAlerts.filter((alert) => relatedIds.has(alert.id));
}

export function getCorrelationGroupsForAlert(alertId: string) {
  return correlationGroups.filter((group) =>
    group.alerts.some((alert) => alert.id === alertId)
  );
}
