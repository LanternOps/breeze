import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { alertRules, alertTemplates } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import { addFeatureLink, assignPolicy, createConfigPolicy } from '../configurationPolicy';
import { convertAlertConditionToMonitor } from './monitorConversion';
import { createMonitorDefinition } from './monitorService';

/**
 * Convert a legacy standalone alert rule into a monitor (#5289).
 *
 * The one-way door off `alert_rules` (that router is deprecated). Kept out of
 * the route file so the route stays a thin HTTP shell, and out of
 * routes/alerts/rules.ts entirely: importing the configuration-policy service
 * there pulls a far larger module graph into that file and broke seven existing
 * suites' db/schema mocks.
 *
 * All-or-nothing in one transaction — a half-converted rule (monitor created,
 * old rule still active) would double-alert on every device it targets.
 */

export type ConversionFailure =
  | { kind: 'rule_not_found' }
  | { kind: 'template_not_found' }
  | { kind: 'already_managed' }
  | { kind: 'not_convertible' }
  | { kind: 'partner_wide_denied'; message: string };

export interface ConversionSuccess {
  monitorId: string;
  configPolicyId: string;
  ruleName: string;
  ruleOrgId: string | null;
}

export type ConversionResult =
  | { ok: true; data: ConversionSuccess }
  | { ok: false; failure: ConversionFailure };

type AssignmentLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

/**
 * Where the converted policy must be assigned so the monitor reaches exactly
 * the devices the rule did. 'all' means "everything this rule's owner covers":
 * org-level for an org rule, partner-level for a partner-wide one.
 */
function assignmentForRule(rule: typeof alertRules.$inferSelect): { level: AssignmentLevel; targetId: string } | null {
  switch (rule.targetType) {
    case 'all':
      if (rule.orgId) return { level: 'organization', targetId: rule.orgId };
      if (rule.partnerId) return { level: 'partner', targetId: rule.partnerId };
      return null;
    case 'org':
      return { level: 'organization', targetId: rule.targetId };
    case 'site':
      return { level: 'site', targetId: rule.targetId };
    case 'group':
      return { level: 'device_group', targetId: rule.targetId };
    case 'device':
      return { level: 'device', targetId: rule.targetId };
    default:
      return null;
  }
}

export async function convertRuleToMonitor(ruleId: string, auth: AuthContext): Promise<ConversionResult> {
  const [rule] = await db.select().from(alertRules).where(eq(alertRules.id, ruleId)).limit(1);
  if (!rule) return { ok: false, failure: { kind: 'rule_not_found' } };

  // Dual-axis access, mirroring getAlertRuleWithOrgCheck: an org-owned rule via
  // org access; a partner-wide rule only for system scope or the owning
  // partner's own PARTNER-scoped token. An org token carries a partnerId too,
  // so matching on that alone would hand every partner-wide rule to every org
  // user under that partner (#4952).
  const canSee = rule.orgId
    ? auth.canAccessOrg(rule.orgId)
    : auth.scope === 'system' || (auth.scope === 'partner' && auth.partnerId === rule.partnerId);
  if (!canSee) return { ok: false, failure: { kind: 'rule_not_found' } };
  if (rule.managedByMonitorId) return { ok: false, failure: { kind: 'already_managed' } };
  if (rule.orgId === null && !canManagePartnerWidePolicies(auth)) {
    return { ok: false, failure: { kind: 'partner_wide_denied', message: PARTNER_WIDE_WRITE_DENIED_MESSAGE } };
  }

  const [template] = await db
    .select()
    .from(alertTemplates)
    .where(eq(alertTemplates.id, rule.templateId))
    .limit(1);
  if (!template) return { ok: false, failure: { kind: 'template_not_found' } };

  const overrides = (rule.overrideSettings ?? {}) as Record<string, unknown>;
  const converted = convertAlertConditionToMonitor(overrides.conditions ?? template.conditions);
  // A condition group, a multi-condition rule, or a metric with no monitor
  // kind: converting would change what the rule measures.
  if (!converted) return { ok: false, failure: { kind: 'not_convertible' } };

  const assignment = assignmentForRule(rule);
  if (!assignment) return { ok: false, failure: { kind: 'not_convertible' } };

  const severity =
    (overrides.severity as 'critical' | 'high' | 'medium' | 'low' | 'info' | undefined) ?? template.severity;
  const channelIds = Array.isArray(overrides.notificationChannelIds)
    ? (overrides.notificationChannelIds as string[])
    : [];

  const data = await db.transaction(async () => {
    const monitor = await createMonitorDefinition(
      {
        ownerScope: rule.orgId ? 'organization' : 'partner',
        orgId: rule.orgId ?? undefined,
        name: rule.name,
        description: template.description ?? undefined,
        kind: converted.kind,
        enabled: rule.isActive,
        condition: converted.condition,
        severity,
        cooldownMinutes: (overrides.cooldownMinutes as number | undefined) ?? template.cooldownMinutes,
        autoResolve: template.autoResolve,
        responses: [],
        deliveryMode: channelIds.length > 0 ? 'channels' : 'inherit',
        deliveryChannelIds: channelIds,
        escalationPolicyId: (overrides.escalationPolicyId as string | undefined) ?? null,
        recurrenceActions: [],
        pauseResponsesOnEscalation: true,
      } as Parameters<typeof createMonitorDefinition>[0],
      auth,
    );

    const policy = await createConfigPolicy(
      rule.orgId ? { orgId: rule.orgId } : { partnerId: rule.partnerId as string },
      { name: `Converted: ${rule.name}` },
      auth.user.id,
    );
    if (!policy) throw new Error('Failed to create configuration policy');

    await assignPolicy(policy.id, assignment.level, assignment.targetId, 0, auth.user.id);
    await addFeatureLink(policy.id, 'monitors', null, {
      items: [{ monitorId: monitor.id, enabled: true }],
    });

    // The old rule is deactivated, never deleted: its alert history keeps
    // pointing at it, and convertedToMonitorId is what the UI reads to send a
    // technician to the monitor that replaced it.
    await db
      .update(alertRules)
      .set({ isActive: false, overrideSettings: { ...overrides, convertedToMonitorId: monitor.id } })
      .where(eq(alertRules.id, ruleId));

    return {
      monitorId: monitor.id,
      configPolicyId: policy.id,
      ruleName: rule.name,
      ruleOrgId: rule.orgId,
    };
  });

  return { ok: true, data };
}
