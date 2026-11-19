/**
 * Device Compliance tab + badge show only results for rules that still exist (#12187).
 *
 * `automation_policy_compliance` config-axis rows are keyed by
 * (config_policy_id = feature link id, config_item_name = rule name, device_id).
 * Saving a policy replaces its `config_policy_compliance_rules` rows, so a
 * removed or renamed rule leaves its old result row behind. Nothing deletes it,
 * and the device views used to show it forever.
 *
 * The read-side fix is an EXISTS check against `config_policy_compliance_rules`
 * evaluated under the caller's own RLS context. The case a mocked unit test
 * cannot reach: an ORG-scoped caller whose device is governed by a
 * PARTNER-WIDE policy (`org_id NULL`). That rule is visible to the org session
 * only through `config_policy_compliance_rules_partner_wide_select`
 * (2026-10-05-110000), which keys on `breeze_current_partner_id()`. If the
 * check ran on a context without the org's partner, every partner-wide result
 * would silently vanish from the tab. This suite proves it does not.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
      // Stale: the whole feature link is gone (config_policy_id carries no FK).
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

    return { partnerId: partner.id, orgId: org.id, deviceId: device.id };
  });
}

describe('device compliance shows only live rules (#12187)', () => {
  it('tab: an org-scoped caller sees live org and partner-wide rule results, not stale ones', async () => {
    const s = await seed();

    const { rows } = await withDbAccessContext(orgContext(s.orgId, s.partnerId), () =>
      getConfigPolicyComplianceForDevice(s.deviceId, [s.orgId]),
    );

    expect(rows.map((r) => r.configItemName).sort()).toEqual(['Disk encryption', 'Firewall enabled']);
  });

  it('badge: counts live config-axis results plus the legacy axis, not stale ones', async () => {
    const s = await seed();

    const count = await withDbAccessContext(orgContext(s.orgId, s.partnerId), () =>
      countDeviceComplianceAttention(s.deviceId),
    );

    // Firewall enabled + Disk encryption + the legacy row.
    expect(count).toBe(3);
  });

  it('control: RLS is live — without the partner GUC the partner-wide rule is not visible', async () => {
    // Proves the org-scope cases above ran on the RLS-enforced breeze_app
    // connection: drop currentPartnerId and the partner-wide rule disappears,
    // so its result no longer passes the existence check.
    const s = await seed();
    const noPartnerCtx: DbAccessContext = { ...orgContext(s.orgId, s.partnerId), currentPartnerId: null };

    const { rows } = await withDbAccessContext(noPartnerCtx, () =>
      getConfigPolicyComplianceForDevice(s.deviceId, [s.orgId]),
    );

    expect(rows.map((r) => r.configItemName)).toEqual(['Firewall enabled']);
  });

  it('control: under system scope every rule is visible, so the filter alone drops the stale rows', async () => {
    const s = await seed();

    const { rows } = await withDbAccessContext(SYSTEM_CTX, () =>
      getConfigPolicyComplianceForDevice(s.deviceId, [s.orgId]),
    );
    const count = await withDbAccessContext(SYSTEM_CTX, () => countDeviceComplianceAttention(s.deviceId));

    expect(rows.map((r) => r.configItemName).sort()).toEqual(['Disk encryption', 'Firewall enabled']);
    expect(count).toBe(3);
  });
});
