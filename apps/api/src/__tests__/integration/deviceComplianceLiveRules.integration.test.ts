/**
 * Device Compliance tab + badge hide results of removed or renamed rules (#12187).
 *
 * `automation_policy_compliance` config-axis rows are keyed by
 * (config_policy_id = feature link id, config_item_name = rule name, device_id).
 * Saving a policy replaces its `config_policy_compliance_rules` rows, so a
 * removed or renamed rule leaves its old result row behind. Nothing deletes it,
 * and the device views used to show it forever.
 *
 * The read-side fix (`configComplianceResultNotStale`) runs under the caller's
 * own RLS context and fails open: a result is hidden only when its feature link
 * is readable and has no rule of that name. The cases a mocked unit test cannot
 * reach are the PARTNER-WIDE ones (`org_id NULL`): an org session reads those
 * rules only through the `*_partner_wide_select` branches (2026-10-05-110000),
 * keyed on `breeze_current_partner_id()`. With the partner set, stale
 * partner-wide results are hidden and live ones kept. Without it (org SSO
 * sessions), the link is unreadable and every partner-wide result is kept. A
 * fail-closed check would hide live violations there.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  automationPolicies,
  automationPolicyCompliance,
  configurationPolicies,
  configPolicyComplianceRules,
  configPolicyFeatureLinks,
} from '../../db/schema';
import { getConfigPolicyComplianceForDevice } from '../../routes/policyManagement/helpers';
import { countDeviceComplianceAttention } from '../../routes/devices/tabCounts';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

/**
 * The shape `buildDbAccessContext` gives an org token: its OWN partner in
 * `currentPartnerId` (what the partner-wide read branch keys on) and an empty
 * `accessiblePartnerIds`, so `breeze_has_partner_access` is false.
 */
function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });

  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [orgPolicy] = await db
      .insert(configurationPolicies)
      .values({ orgId: org.id, partnerId: null, name: 'Org baseline' })
      .returning();
    const [partnerPolicy] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: partner.id, name: 'Partner-wide baseline' })
      .returning();

    const [orgLink] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: orgPolicy!.id, featureType: 'compliance', inlineSettings: {} })
      .returning();
    const [partnerLink] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: partnerPolicy!.id, featureType: 'compliance', inlineSettings: {} })
      .returning();

    await db.insert(configPolicyComplianceRules).values([
      { featureLinkId: orgLink!.id, name: 'Firewall enabled', rules: [] },
      { featureLinkId: partnerLink!.id, name: 'Disk encryption', rules: [] },
    ]);

    const [legacyPolicy] = await db
      .insert(automationPolicies)
      .values({ orgId: org.id, name: 'Legacy policy', targets: {}, rules: [] })
      .returning();

    const result = (configPolicyId: string, configItemName: string) => ({
      policyId: null,
      configPolicyId,
      configItemName,
      deviceId: device.id,
      status: 'non_compliant' as const,
      details: {},
      lastCheckedAt: new Date(),
    });

    await db.insert(automationPolicyCompliance).values([
      // Live: org-owned rule.
      result(orgLink!.id, 'Firewall enabled'),
      // Stale: the same rule under its pre-rename name.
      result(orgLink!.id, 'Firewall on'),
      // Live: partner-wide rule, reachable by the org only via the read branch.
      result(partnerLink!.id, 'Disk encryption'),
      // Stale: a rule removed from the partner-wide policy.
      result(partnerLink!.id, 'Removed rule'),
      // Stale: these names are live only under the OTHER link, so a check that
      // matched on name alone would wrongly keep them.
      result(orgLink!.id, 'Disk encryption'),
      result(partnerLink!.id, 'Firewall enabled'),
      // Unknown: the feature link is gone (config_policy_id carries no FK). Under
      // RLS a deleted link looks the same as an unreadable one, so this row is
      // KEPT (fail open) — see configComplianceResultNotStale().
      result(randomUUID(), 'Deleted policy rule'),
      // Legacy automation-policy axis: not this fix's concern, still counted.
      {
        policyId: legacyPolicy!.id,
        configPolicyId: null,
        configItemName: null,
        deviceId: device.id,
        status: 'non_compliant' as const,
        details: {},
        lastCheckedAt: new Date(),
      },
    ]);

    return {
      partnerId: partner.id,
      orgId: org.id,
      deviceId: device.id,
      /** Render a result row as `<org|partner|gone>:<rule name>` for assertions. */
      label: (row: { configPolicyId: string | null; configItemName: string | null }) =>
        `${row.configPolicyId === orgLink!.id ? 'org' : row.configPolicyId === partnerLink!.id ? 'partner' : 'gone'}:${row.configItemName}`,
    };
  });
}

/** An org session whose token carries no partner, as org SSO logins issue today. */
function orgSsoContext(orgId: string): DbAccessContext {
  return { ...orgContext(orgId, '00000000-0000-0000-0000-000000000000'), currentPartnerId: null };
}

async function tabLabels(ctx: DbAccessContext, s: Awaited<ReturnType<typeof seed>>): Promise<string[]> {
  const { rows } = await withDbAccessContext(ctx, () => getConfigPolicyComplianceForDevice(s.deviceId, [s.orgId]));
  return rows.map(s.label).sort();
}

describe('device compliance hides results of removed or renamed rules (#12187)', () => {
  it('org session: hides stale org and partner-wide results, keeps live ones', async () => {
    const s = await seed();
    const ctx = orgContext(s.orgId, s.partnerId);

    expect(await tabLabels(ctx, s)).toEqual([
      'gone:Deleted policy rule',
      'org:Firewall enabled',
      'partner:Disk encryption',
    ]);
    // The three above + the legacy automation-policy row.
    expect(await withDbAccessContext(ctx, () => countDeviceComplianceAttention(s.deviceId))).toBe(4);
  });

  it('org session without a partner (SSO): live partner-wide results stay visible', async () => {
    const s = await seed();
    const ctx = orgSsoContext(s.orgId);

    // Non-vacuity: RLS is live and this context cannot read the partner-wide rule.
    const partnerRules = await withDbAccessContext(ctx, () =>
      db.select({ id: configPolicyComplianceRules.id }).from(configPolicyComplianceRules)
        .where(eq(configPolicyComplianceRules.name, 'Disk encryption')),
    );
    expect(partnerRules).toEqual([]);

    // The partner-wide link is unreadable, so its rows are kept (fail open);
    // the readable org link is still filtered.
    expect(await tabLabels(ctx, s)).toEqual([
      'gone:Deleted policy rule',
      'org:Firewall enabled',
      'partner:Disk encryption',
      'partner:Firewall enabled',
      'partner:Removed rule',
    ]);
    expect(await withDbAccessContext(ctx, () => countDeviceComplianceAttention(s.deviceId))).toBe(6);
  });

  it('system scope: same filter as an org session with full visibility', async () => {
    const s = await seed();

    expect(await tabLabels(SYSTEM_CTX, s)).toEqual([
      'gone:Deleted policy rule',
      'org:Firewall enabled',
      'partner:Disk encryption',
    ]);
    expect(await withDbAccessContext(SYSTEM_CTX, () => countDeviceComplianceAttention(s.deviceId))).toBe(4);
  });
});
