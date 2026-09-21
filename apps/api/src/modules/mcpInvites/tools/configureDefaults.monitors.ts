import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { monitorsInlineSettingsSchema } from '@breeze/shared';
import { db } from '../../../db';
import { organizations, monitorDefinitions, configurationPolicies, configPolicyAssignments } from '../../../db/schema';
import { addFeatureLink, listFeatureLinks, updateFeatureLink } from '../../../services/configurationPolicy';

const BASELINE_NAME = 'Default monitoring';
const BASELINE_DESCRIPTION = 'Baseline monitor attachments created by configure_defaults.';
export async function applyStandardAlertPolicy(orgId: string, _framework: 'standard' | 'cis', expectedPartnerId: string): Promise<{ created: boolean; skipped_reason?: string }> {
  return db.transaction(async (tx) => {
    // Serializes bootstrap calls for this org without granting any new DB scope.
    const [org] = await tx.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, expectedPartnerId)))
      .limit(1).for('update');
    if (!org) throw new Error('Organization not found for bootstrap partner');
    const builtIns = await tx.select({ id: monitorDefinitions.id }).from(monitorDefinitions)
      .where(and(eq(monitorDefinitions.partnerId, expectedPartnerId), isNull(monitorDefinitions.orgId),
        isNotNull(monitorDefinitions.builtinKey), eq(monitorDefinitions.enabled, true)))
      .orderBy(asc(monitorDefinitions.builtinKey));
    if (builtIns.length === 0) return { created: false, skipped_reason: 'no enabled built-in monitors found' };
    let [policy] = await tx.select().from(configurationPolicies).where(and(
      eq(configurationPolicies.orgId, orgId), isNull(configurationPolicies.partnerId),
      eq(configurationPolicies.name, BASELINE_NAME), eq(configurationPolicies.description, BASELINE_DESCRIPTION),
    )).limit(1).for('update');
    if (policy && policy.status !== 'active') return { created: false, skipped_reason: 'default monitoring policy is inactive' };
    let created = false;
    if (!policy) {
      [policy] = await tx.insert(configurationPolicies).values({
        orgId, partnerId: null, name: BASELINE_NAME, description: BASELINE_DESCRIPTION,
        status: 'active', createdBy: null,
      }).returning();
      if (!policy) throw new Error('Could not create default monitoring policy');
      created = true;
    }
    const assignments = await tx.insert(configPolicyAssignments).values({
      configPolicyId: policy.id, level: 'organization', targetId: orgId, priority: 0, assignedBy: null,
    }).onConflictDoNothing().returning({ id: configPolicyAssignments.id });
    created ||= assignments.length > 0;
    const links = await listFeatureLinks(policy.id, tx);
    const link = links.find((item) => item.featureType === 'monitors');
    const settings = monitorsInlineSettingsSchema.parse(link?.inlineSettings ?? { items: [] });
    const existing = new Set(settings.items.map((item) => item.monitorId));
    const missing = builtIns.filter((monitor) => !existing.has(monitor.id));
    if (missing.length === 0) return { created };
    const nextOrder = settings.items.reduce((max, item) => Math.max(max, item.sortOrder ?? 0), -1) + 1;
    const next = monitorsInlineSettingsSchema.parse({ ...settings, items: [
      ...settings.items,
      ...missing.map((monitor, i) => ({ monitorId: monitor.id, enabled: true, overrides: null, sortOrder: nextOrder + i })),
    ] });
    if (link) {
      await updateFeatureLink(link.id, { inlineSettings: next }, policy.id, undefined, tx);
    } else {
      const added = await addFeatureLink(policy.id, 'monitors', null, next, undefined, tx);
      if (!added) throw new Error('Default monitoring feature link changed concurrently');
    }
    return { created: true };
  });
}
