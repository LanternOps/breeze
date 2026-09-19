/**
 * Per-device config-policy resolvers in services/featureConfigResolver.ts honour
 * partner-wide policies (#2930) after #4673 W03.
 *
 * #4673 Wave 3 deleted `withPartnerWideVisibility` — a nested
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` escape — from
 * every per-device resolver in featureConfigResolver.ts. Those resolvers now
 * read partner-wide config rows (`org_id NULL, partner_id = P`) through the
 * SELECT-only RLS branch `<table>_partner_wide_select`
 * (`USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())`,
 * migration 2026-10-05-110000-config-policy-partner-wide-select.sql), which
 * reads the `breeze.current_partner_id` GUC set from
 * `DbAccessContext.currentPartnerId`.
 *
 * Eight of those resolvers had NO real-database test under a non-system
 * context, so nothing proved they still return partner-wide rows after the
 * escape was removed. Their only tests mock Drizzle and evaluate no RLS at
 * all. This file closes that gap for:
 *
 *   resolveAlertRulesForDevice, resolveGoverningAlertRulePolicyForDevice,
 *   resolveAutomationsForDevice, resolveComplianceRulesForDevice,
 *   resolveMaintenanceConfigForDevice, resolveSoftwarePolicyForDevice,
 *   resolveVulnerabilityEnabledForDevice, resolveBackupConfigForDevice,
 *   resolveBackupProtectionForDevice
 *
 * Model: agentPolicyResolversPartnerWide.integration.test.ts (same pattern,
 * for the four agent-facing resolvers in routes/agents/helpers.ts).
 *
 * Each resolver gets a POSITIVE case (partner-wide policy resolves under a
 * real org-scoped context, via `orgContext`) and a BLIND case (the same seed,
 * but under a context with `currentPartnerId: null` — `partnerWideBlindContext`
 * — must return the default/empty result). The blind case is the load-bearing
 * negative control: under a reintroduced system-context escape,
 * `breeze.current_partner_id` would be irrelevant and the positive result
 * would appear regardless of the GUC. Only failing blind + passing positive
 * together pin that the SELECT-only RLS branch — not an escape — is what
 * grants the read.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAlertRules,
  configPolicyAutomations,
  configPolicyComplianceRules,
  configPolicyMaintenanceSettings,
  configPolicyBackupSettings,
  softwarePolicies,
  devices,
} from '../../db/schema';
import {
  resolveAlertRulesForDevice,
  resolveGoverningAlertRulePolicyForDevice,
  resolveAutomationsForDevice,
  resolveComplianceRulesForDevice,
  resolveMaintenanceConfigForDevice,
  resolveSoftwarePolicyForDevice,
  resolveVulnerabilityEnabledForDevice,
  resolveBackupConfigForDevice,
  resolveBackupProtectionForDevice,
} from '../../services/featureConfigResolver';
import { createPartner, createOrganization, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

// The realistic non-agent request shape too: an org-scoped context carrying
// the org's own partner in `currentPartnerId` (the field the SELECT-only
// `*_partner_wide_select` policies read via breeze_current_partner_id()),
// while `accessiblePartnerIds` stays [] (that field gates partner-axis
// WRITES via breeze_has_partner_access and is a different axis entirely).
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

// The SAME context minus `currentPartnerId` — what a hand-built org context
// looked like before the GUC was wired up, or what a reintroduced escape would
// make irrelevant. Used by every BLIND case below: if a system-context escape
// were ever reintroduced, the partner-wide policy would resolve here too, and
// these assertions would fail.
function partnerWideBlindContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: null,
  };
}

const createdPolicies: string[] = [];
const createdDevices: string[] = [];
const createdSoftwarePolicies: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdDevices) {
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdPolicies) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
    for (const id of createdSoftwarePolicies) {
      await db.delete(softwarePolicies).where(eq(softwarePolicies.id, id));
    }
  });
  createdDevices.length = 0;
  createdPolicies.length = 0;
  createdSoftwarePolicies.length = 0;
});

async function seedDevice(orgId: string, siteId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [d] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole: 'workstation',
      })
      .returning();
    createdDevices.push(d!.id);
    return d!;
  });
}

async function assign(configPolicyId: string, level: 'partner' | 'organization', targetId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    await db.insert(configPolicyAssignments).values({
      configPolicyId,
      level,
      targetId,
      priority: 0,
    });
  });
}

type Owner = { orgId: string | null; partnerId: string | null };

async function createPolicy(owner: Owner, namePrefix: string): Promise<string> {
  const [policy] = await db
    .insert(configurationPolicies)
    .values({ orgId: owner.orgId, partnerId: owner.partnerId, name: `${namePrefix} ${randomUUID()}`, status: 'active' })
    .returning();
  createdPolicies.push(policy!.id);
  return policy!.id;
}

// alert rule condition/severity are arbitrary but valid; `name` is the field
// each test asserts on to prove THIS row resolved.
async function seedAlertRulePolicy(owner: Owner, ruleName: string): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const policyId = await createPolicy(owner, 'alert rule policy');
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyId, featureType: 'alert_rule' })
      .returning();
    await db.insert(configPolicyAlertRules).values({
      featureLinkId: link!.id,
      name: ruleName,
      severity: 'critical',
      conditions: { metric: 'cpu_percent', operator: 'gt', value: 90 },
    });
    return policyId;
  });
}

async function seedAutomationPolicy(owner: Owner, automationName: string): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const policyId = await createPolicy(owner, 'automation policy');
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyId, featureType: 'automation' })
      .returning();
    await db.insert(configPolicyAutomations).values({
      featureLinkId: link!.id,
      name: automationName,
      triggerType: 'manual',
      actions: [{ type: 'run_script' }],
    });
    return policyId;
  });
}

async function seedComplianceRulePolicy(owner: Owner, ruleName: string): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const policyId = await createPolicy(owner, 'compliance policy');
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyId, featureType: 'compliance' })
      .returning();
    await db.insert(configPolicyComplianceRules).values({
      featureLinkId: link!.id,
      name: ruleName,
      rules: { requiredSetting: 'disk_encryption_enabled' },
    });
    return policyId;
  });
}

// durationHours default is 2 (schema default) — every seed here uses a
// different value so a resolved row is unmistakable from the column default.
async function seedMaintenancePolicy(owner: Owner, durationHours: number): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const policyId = await createPolicy(owner, 'maintenance policy');
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyId, featureType: 'maintenance' })
      .returning();
    await db.insert(configPolicyMaintenanceSettings).values({
      featureLinkId: link!.id,
      durationHours,
    });
    return policyId;
  });
}

// No settings child for software_policy — the id lives directly on the
// feature link's featurePolicyId column. But `config_policy_feature_links`
// carries a trigger-enforced FK (`config_policy_feature_links_reference_owner_fk`,
// migration 2026-07-27-a) requiring feature_policy_id to name a REAL
// software_policies row owned by the SAME axis as the parent policy — a bare
// random uuid is rejected with 23503. So this seeds the target row too, and
// returns its id as the distinctive value the resolver must echo back.
async function seedSoftwarePolicyLink(owner: Owner): Promise<{ configPolicyId: string; featurePolicyId: string }> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [target] = await db
      .insert(softwarePolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: `software policy target ${randomUUID()}`,
        mode: 'allowlist',
        rules: { software: [] },
      })
      .returning();
    createdSoftwarePolicies.push(target!.id);

    const policyId = await createPolicy(owner, 'software policy link');
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policyId,
      featureType: 'software_policy',
      featurePolicyId: target!.id,
    });
    return { configPolicyId: policyId, featurePolicyId: target!.id };
  });
}

// No settings child for vulnerability either — the flag lives in the feature
// link's inlineSettings JSONB.
async function seedVulnerabilityPolicy(owner: Owner, enabled: boolean): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const policyId = await createPolicy(owner, 'vulnerability policy');
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policyId,
      featureType: 'vulnerability',
      inlineSettings: { enabled },
    });
    return policyId;
  });
}

// config_policy_backup_settings carries a DB-trigger-enforced
// `config_policy_backup_settings_owner_match` constraint
// (migration 2026-07-26-a): its org_id/partner_id must match the PARENT
// policy's ownership exactly — hence `owner` is threaded onto the settings
// row too, not just the policy. backupMode default is 'file'; every seed
// below uses 'system_image' so a resolved row is unmistakable from the
// column default.
async function seedBackupSettingsPolicy(
  owner: Owner,
  opts: { retention?: Record<string, unknown> } = {},
): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const policyId = await createPolicy(owner, 'backup policy');
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policyId, featureType: 'backup' })
      .returning();
    await db.insert(configPolicyBackupSettings).values({
      featureLinkId: link!.id,
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      backupMode: 'system_image',
      ...(opts.retention ? { retention: opts.retention } : {}),
    });
    return policyId;
  });
}

describe('per-device config-policy resolvers honour partner-wide policies (#2930, #4673 W03)', () => {
  describe('resolveAlertRulesForDevice', () => {
    // Default (no visible policy) is []. Any resolved row is non-empty and
    // named — the seeded name proves it is THIS row, not a coincidence.
    it('resolves a partner-wide alert rule under an org-scoped context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const ruleName = `Partner-Wide High CPU ${randomUUID()}`;
      const policyId = await seedAlertRulePolicy({ orgId: null, partnerId: partner.id }, ruleName);
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveAlertRulesForDevice(device.id),
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe(ruleName);
    });

    it('a partner-wide alert rule is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const ruleName = `Partner-Wide High CPU ${randomUUID()}`;
      const policyId = await seedAlertRulePolicy({ orgId: null, partnerId: partner.id }, ruleName);
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        resolveAlertRulesForDevice(device.id),
      );
      expect(blind).toEqual([]); // default: no visible assignment -> []

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveAlertRulesForDevice(device.id),
      );
      expect(sighted).toHaveLength(1);
    });
  });

  describe('resolveGoverningAlertRulePolicyForDevice', () => {
    // Default (device has hierarchy but the candidate policy is not among the
    // visible assigned policies) is {outcome:'unassigned'}. 'governs' requires
    // the row to be BOTH assigned AND resolvable -> proves visibility.
    it("a partner-wide policy 'governs' when it is the candidate under an org-scoped context", async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedAlertRulePolicy(
        { orgId: null, partnerId: partner.id },
        `governs-candidate-${randomUUID()}`,
      );
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveGoverningAlertRulePolicyForDevice(device.id, policyId),
      );

      expect(result).toEqual({ outcome: 'governs' });
    });

    it("a partner-wide policy is 'unassigned' without breeze.current_partner_id", async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedAlertRulePolicy(
        { orgId: null, partnerId: partner.id },
        `governs-candidate-${randomUUID()}`,
      );
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        resolveGoverningAlertRulePolicyForDevice(device.id, policyId),
      );
      // Default: the candidate is invisible under RLS, so it never lands in
      // the `assigned` set -> unassigned, NOT governs.
      expect(blind).toEqual({ outcome: 'unassigned' });

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveGoverningAlertRulePolicyForDevice(device.id, policyId),
      );
      expect(sighted).toEqual({ outcome: 'governs' });
    });
  });

  describe('resolveAutomationsForDevice', () => {
    // Default (no visible policy) is [].
    it('resolves a partner-wide automation under an org-scoped context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const automationName = `Partner-Wide Restart Service ${randomUUID()}`;
      const policyId = await seedAutomationPolicy({ orgId: null, partnerId: partner.id }, automationName);
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveAutomationsForDevice(device.id),
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe(automationName);
    });

    it('a partner-wide automation is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const automationName = `Partner-Wide Restart Service ${randomUUID()}`;
      const policyId = await seedAutomationPolicy({ orgId: null, partnerId: partner.id }, automationName);
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        resolveAutomationsForDevice(device.id),
      );
      expect(blind).toEqual([]);

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveAutomationsForDevice(device.id),
      );
      expect(sighted).toHaveLength(1);
    });
  });

  describe('resolveComplianceRulesForDevice', () => {
    // Default (no visible policy) is [].
    it('resolves a partner-wide compliance rule under an org-scoped context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const ruleName = `Partner-Wide Disk Encryption ${randomUUID()}`;
      const policyId = await seedComplianceRulePolicy({ orgId: null, partnerId: partner.id }, ruleName);
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveComplianceRulesForDevice(device.id),
      );

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe(ruleName);
    });

    it('a partner-wide compliance rule is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const ruleName = `Partner-Wide Disk Encryption ${randomUUID()}`;
      const policyId = await seedComplianceRulePolicy({ orgId: null, partnerId: partner.id }, ruleName);
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        resolveComplianceRulesForDevice(device.id),
      );
      expect(blind).toEqual([]);

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveComplianceRulesForDevice(device.id),
      );
      expect(sighted).toHaveLength(1);
    });
  });

  describe('resolveMaintenanceConfigForDevice', () => {
    // Default (no visible policy) is null. resolveMaintenanceConfigForDevice
    // does NOT call resolveDeviceTimezone (verified by reading the source) so
    // no partner-axis escape dependency to worry about here.
    it('resolves a partner-wide maintenance window under an org-scoped context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const DISTINCTIVE_DURATION_HOURS = 9; // schema default is 2
      const policyId = await seedMaintenancePolicy(
        { orgId: null, partnerId: partner.id },
        DISTINCTIVE_DURATION_HOURS,
      );
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveMaintenanceConfigForDevice(device.id),
      );

      expect(result).not.toBeNull();
      expect(result!.durationHours).toBe(DISTINCTIVE_DURATION_HOURS);
    });

    it('a partner-wide maintenance window is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedMaintenancePolicy({ orgId: null, partnerId: partner.id }, 9);
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        resolveMaintenanceConfigForDevice(device.id),
      );
      expect(blind).toBeNull();

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveMaintenanceConfigForDevice(device.id),
      );
      expect(sighted).not.toBeNull();
      expect(sighted!.durationHours).toBe(9);
    });
  });

  describe('resolveSoftwarePolicyForDevice', () => {
    // Default (no visible policy) is null. There is no settings child for
    // software_policy — the id lives on the feature link's featurePolicyId —
    // so the seeded UUID itself is the distinctive value.
    it('resolves a partner-wide software policy link under an org-scoped context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const { configPolicyId, featurePolicyId } = await seedSoftwarePolicyLink({ orgId: null, partnerId: partner.id });
      await assign(configPolicyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveSoftwarePolicyForDevice(device.id),
      );

      expect(result).toBe(featurePolicyId);
    });

    it('a partner-wide software policy link is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const { configPolicyId, featurePolicyId } = await seedSoftwarePolicyLink({ orgId: null, partnerId: partner.id });
      await assign(configPolicyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        resolveSoftwarePolicyForDevice(device.id),
      );
      expect(blind).toBeNull();

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveSoftwarePolicyForDevice(device.id),
      );
      expect(sighted).toBe(featurePolicyId);
    });
  });

  describe('resolveVulnerabilityEnabledForDevice', () => {
    // Default (no visible policy) is false. There is no settings child — the
    // flag lives in the feature link's inlineSettings JSONB.
    it('resolves a partner-wide vulnerability opt-in under an org-scoped context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedVulnerabilityPolicy({ orgId: null, partnerId: partner.id }, true);
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveVulnerabilityEnabledForDevice(device.id),
      );

      expect(result).toBe(true);
    });

    it('a partner-wide vulnerability opt-in is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedVulnerabilityPolicy({ orgId: null, partnerId: partner.id }, true);
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        resolveVulnerabilityEnabledForDevice(device.id),
      );
      expect(blind).toBe(false); // default: hidden -> not enabled

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveVulnerabilityEnabledForDevice(device.id),
      );
      expect(sighted).toBe(true);
    });
  });

  describe('resolveBackupConfigForDevice', () => {
    // Default (no visible policy) is null. Reaches resolveDeviceTimezone ->
    // resolvePartnerTimezoneForDeviceRow -> readWithPartnerAxisVisibility,
    // which opens its OWN system context internally, so it resolves fine
    // under both an org context and the blind context — not worked around.
    it('resolves a partner-wide backup config under an org-scoped context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedBackupSettingsPolicy({ orgId: null, partnerId: partner.id });
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveBackupConfigForDevice(device.id),
      );

      expect(result).not.toBeNull();
      // 'system_image' is not the schema default ('file') — proves the
      // partner-wide settings row resolved rather than a coincidental match.
      expect(result!.settings?.backupMode).toBe('system_image');
      expect(result!.settings?.backupMode).not.toBe('file');
    });

    it('a partner-wide backup config is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedBackupSettingsPolicy({ orgId: null, partnerId: partner.id });
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        resolveBackupConfigForDevice(device.id),
      );
      expect(blind).toBeNull();

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveBackupConfigForDevice(device.id),
      );
      expect(sighted).not.toBeNull();
      expect(sighted!.settings?.backupMode).toBe('system_image');
    });
  });

  describe('resolveBackupProtectionForDevice', () => {
    // Default (no visible policy) is null. The distinctive value is the whole
    // `retention` shape: legalHold true / a reason / an immutability mode+days
    // — every field differs from "no protection" (legalHold:false,
    // legalHoldReason:null, immutabilityMode:null, immutableDays:null).
    const DISTINCTIVE_RETENTION = {
      legalHold: true,
      legalHoldReason: 'Litigation hold — matter 2026-CV-4471',
      immutabilityMode: 'provider' as const,
      immutableDays: 45,
    };

    it('resolves partner-wide backup protection under an org-scoped context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedBackupSettingsPolicy(
        { orgId: null, partnerId: partner.id },
        { retention: DISTINCTIVE_RETENTION },
      );
      await assign(policyId, 'partner', partner.id);

      const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveBackupProtectionForDevice(device.id),
      );

      expect(result).not.toBeNull();
      expect(result!.legalHold).toBe(true);
      expect(result!.legalHoldReason).toBe(DISTINCTIVE_RETENTION.legalHoldReason);
      expect(result!.immutabilityMode).toBe('provider');
      expect(result!.immutableDays).toBe(45);
    });

    it('partner-wide backup protection is INVISIBLE without breeze.current_partner_id', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const policyId = await seedBackupSettingsPolicy(
        { orgId: null, partnerId: partner.id },
        { retention: DISTINCTIVE_RETENTION },
      );
      await assign(policyId, 'partner', partner.id);

      const blind = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
        resolveBackupProtectionForDevice(device.id),
      );
      // Default: no visible assignment at all -> null (not merely
      // legalHold:false — the resolver returns null outright when rows.length
      // is 0, before any retention parsing happens).
      expect(blind).toBeNull();

      const sighted = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
        resolveBackupProtectionForDevice(device.id),
      );
      expect(sighted).not.toBeNull();
      expect(sighted!.legalHold).toBe(true);
      expect(sighted!.immutableDays).toBe(45);
    });
  });
});
