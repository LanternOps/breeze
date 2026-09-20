import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { alertRules, alertTemplates } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import type { DbExecutor } from './monitorCompiler';
import { mapStandaloneRule } from './conversion/mapping';
import { previewTemplateGroup, convertTemplateGroup } from './conversion/convert';

/** Convert the entire shared template atomically, retaining the legacy route envelope. */

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
  conversionId: string;
  convertedRuleIds: string[];
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
export function assignmentForRule(rule: typeof alertRules.$inferSelect): { level: AssignmentLevel; targetId: string } | null {
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

export async function convertRuleToMonitor(ruleId: string, auth: AuthContext, executor: DbExecutor = db): Promise<ConversionResult> {
  const [rule] = await executor.select().from(alertRules).where(eq(alertRules.id, ruleId)).limit(1);
  if (!rule || rule.retiredAt) return { ok: false, failure: { kind: 'rule_not_found' } };

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

  const [template] = await executor
    .select()
    .from(alertTemplates)
    .where(eq(alertTemplates.id, rule.templateId))
    .limit(1);
  if (!template) return { ok: false, failure: { kind: 'template_not_found' } };

  const canSeeTemplate = template.orgId
    ? auth.canAccessOrg(template.orgId)
    : auth.scope === 'system' || (auth.scope === 'partner' && auth.partnerId === template.partnerId);
  if (!canSeeTemplate || template.retiredAt) return { ok: false, failure: { kind: 'template_not_found' } };
  if (template.managedByMonitorId) return { ok: false, failure: { kind: 'already_managed' } };
  if (!assignmentForRule(rule) || !mapStandaloneRule(rule, template).ok) {
    return { ok: false, failure: { kind: 'not_convertible' } };
  }

  // Confirmation binds every member and target, including siblings the selected
  // rule's route did not name. The group writer repeats authorization and hash
  // checks under its transaction locks before creating a single ledger entry.
  const preview = await previewTemplateGroup(template.id, auth, executor);
  if (preview.blockedBy) return { ok: false, failure: { kind: 'not_convertible' } };
  const converted = await convertTemplateGroup(template.id, preview.previewHash, auth, executor);
  const primary = converted.outputs.find((output) => output.sourceRuleId === rule.id && output.role === 'primary');
  if (!primary?.monitorId || !primary.policyId) throw new Error('Converted group missing primary rule output');
  return { ok: true, data: {
    monitorId: primary.monitorId,
    configPolicyId: primary.policyId,
    ruleName: rule.name,
    ruleOrgId: rule.orgId,
    conversionId: converted.conversionId,
    convertedRuleIds: converted.convertedRuleIds,
  } };
}
