/**
 * #8142 (scaling W03) — config_policy_hardware_monitoring_settings had no
 * partner-wide SELECT branch, so an org-scoped context (the agent heartbeat
 * after W03) could not read a partner-wide hardware-monitoring policy's
 * settings without widening breeze.accessible_partner_ids. Same three
 * properties as configPolicyPartnerWideSelect.integration.test.ts: own-partner
 * reads, no writes, no foreign partner, nothing on a NULL partner GUC.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyFeatureLinks,
  configPolicyHardwareMonitoringSettings,
  configurationPolicies,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const orgCtx = (orgId: string, currentPartnerId: string | null): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId,
});

async function seedPartnerWideHwmon(partnerId: string): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: null, partnerId, name: `hwmon pw ${randomUUID()}`, status: 'active',
    }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'hardware_monitoring',
    }).returning();
    const [settings] = await db.insert(configPolicyHardwareMonitoringSettings).values({
      featureLinkId: link!.id, enabled: true, pollIntervalMinutes: 7, diskHealthIntervalMinutes: 60,
    }).returning();
    return settings!.id;
  });
}

describe('config_policy_hardware_monitoring_settings partner-wide SELECT branch (#8142)', () => {
  runDb('an org session of the owning partner reads its partner-wide row and never a foreign partner\'s', async () => {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const foreign = (await createPartner())!;
    const own = await seedPartnerWideHwmon(partner.id);
    const other = await seedPartnerWideHwmon(foreign.id);

    const seen = await withDbAccessContext(orgCtx(org.id, partner.id), () =>
      db.select({ id: configPolicyHardwareMonitoringSettings.id })
        .from(configPolicyHardwareMonitoringSettings)
        .where(inArray(configPolicyHardwareMonitoringSettings.id, [own, other])));
    expect(seen.map((r) => r.id)).toEqual([own]);

    const agentNoPartner = await withDbAccessContext(orgCtx(org.id, null), () =>
      db.select({ id: configPolicyHardwareMonitoringSettings.id })
        .from(configPolicyHardwareMonitoringSettings)
        .where(inArray(configPolicyHardwareMonitoringSettings.id, [own, other])));
    expect(agentNoPartner).toEqual([]);
  });

  runDb('the branch grants no write: an UPDATE from the org session touches zero rows', async () => {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const own = await seedPartnerWideHwmon(partner.id);

    const updated = await withDbAccessContext(orgCtx(org.id, partner.id), () =>
      db.update(configPolicyHardwareMonitoringSettings)
        .set({ pollIntervalMinutes: 30 })
        .where(eq(configPolicyHardwareMonitoringSettings.id, own))
        .returning({ id: configPolicyHardwareMonitoringSettings.id }));
    expect(updated).toEqual([]);
    const [after] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ poll: configPolicyHardwareMonitoringSettings.pollIntervalMinutes })
        .from(configPolicyHardwareMonitoringSettings)
        .where(eq(configPolicyHardwareMonitoringSettings.id, own)));
    expect(after?.poll).toBe(7);
  });
});
