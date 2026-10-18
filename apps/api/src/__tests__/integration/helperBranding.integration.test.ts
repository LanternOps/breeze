/**
 * Helper runtime branding (Phase 2 Wave 1) against real Postgres.
 *
 * Properties under test:
 *  - branding is decided only by partner and organization candidates, merged
 *    field by field (partner <- organization);
 *  - operational helper settings still come from the winning candidate in the
 *    usual level order, and a site-level winner does not hide partner/org branding;
 *  - the heartbeat's policy-set path and the DB path produce the same result.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  devices,
} from '../../db/schema';
import { resolveDeviceHelperSettings } from '../../services/helperSettings';
import { brandingScopeId } from '../../services/helperBranding';
import { loadDeviceHierarchy } from '../../services/deviceHierarchy';
import { loadDevicePolicySet, withPolicySet } from '../../services/devicePolicySet';
import { createPartner, createOrganization, createSite, createDevice } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const policyIds: string[] = [];
const deviceIds: string[] = [];

afterAll(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (policyIds.length > 0) {
      await db.delete(configPolicyAssignments).where(inArray(configPolicyAssignments.configPolicyId, policyIds));
      await db.delete(configPolicyFeatureLinks).where(inArray(configPolicyFeatureLinks.configPolicyId, policyIds));
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, policyIds));
    }
    if (deviceIds.length > 0) {
      await db.delete(devices).where(inArray(devices.id, deviceIds));
    }
  });
});

async function seedPolicy(values: { partnerId?: string; orgId?: string; name: string }): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = await db
      .insert(configurationPolicies)
      .values({ partnerId: values.partnerId ?? null, orgId: values.orgId ?? null, name: values.name })
      .returning({ id: configurationPolicies.id });
    policyIds.push(row!.id);
    return row!.id;
  });
}

async function seedHelperLink(configPolicyId: string, inlineSettings: Record<string, unknown>): Promise<void> {
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(configPolicyFeatureLinks).values({ configPolicyId, featureType: 'helper', inlineSettings }));
}

async function seedAssignment(
  configPolicyId: string,
  level: 'partner' | 'organization' | 'site',
  targetId: string,
  priority = 0,
): Promise<void> {
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(configPolicyAssignments).values({ configPolicyId, level, targetId, priority }));
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const device = await createDevice({ orgId, siteId });
  deviceIds.push(device.id);
  return device.id;
}

/** Agent-shaped org session (see configPolicyInheritance): the heartbeat reads helper settings this way. */
function agentContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/**
 * Partner branding, organization branding that overrides one field, and a
 * site-level operational winner with no branding of its own.
 */
async function seedBrandedScenario() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const partnerPolicy = await seedPolicy({ partnerId: partner.id, name: 'partner branding' });
  await seedHelperLink(partnerPolicy, {
    enabled: true,
    branding: { displayName: 'Partner Assist', primaryColor: '#112233' },
  });
  await seedAssignment(partnerPolicy, 'partner', partner.id);

  const orgPolicy = await seedPolicy({ orgId: org.id, name: 'org branding' });
  await seedHelperLink(orgPolicy, { branding: { primaryColor: '#AABBCC' } });
  await seedAssignment(orgPolicy, 'organization', org.id);

  const sitePolicy = await seedPolicy({ orgId: org.id, name: 'site operational' });
  await seedHelperLink(sitePolicy, { enabled: false });
  await seedAssignment(sitePolicy, 'site', site.id);

  const deviceId = await seedDevice(org.id, site.id);
  return { partner, org, site, deviceId };
}

describe('helper branding — DB resolution path (live DB)', () => {
  it('merges partner then organization branding field by field, while a site winner keeps operational settings', async () => {
    const { partner, org, deviceId } = await seedBrandedScenario();
    const settings = await withDbAccessContext(agentContext(org.id, partner.id), () =>
      resolveDeviceHelperSettings(deviceId));

    expect(settings?.enabled).toBe(false);
    expect(settings?.branding).toEqual({
      state: 'set',
      scopeId: brandingScopeId(partner.id, org.id),
      values: { displayName: 'Partner Assist', primaryColor: '#AABBCC' },
    });
  });

  it('the heartbeat policy-set path returns exactly the DB path result for the same device', async () => {
    const { partner, org, deviceId } = await seedBrandedScenario();
    await withDbAccessContext(agentContext(org.id, partner.id), async () => {
      const viaDb = await resolveDeviceHelperSettings(deviceId);
      const hierarchy = await loadDeviceHierarchy(deviceId);
      expect(hierarchy).not.toBeNull();
      const set = await loadDevicePolicySet(hierarchy!);
      const viaSet = await resolveDeviceHelperSettings(deviceId, withPolicySet(set, hierarchy));

      expect(viaSet).toEqual(viaDb);
      expect(viaSet?.branding?.state).toBe('set');
    });
  });

  it('a helper with no branding anywhere resolves to an explicit cleared decision', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    const orgPolicy = await seedPolicy({ orgId: org.id, name: 'org helper only' });
    await seedHelperLink(orgPolicy, { enabled: true });
    await seedAssignment(orgPolicy, 'organization', org.id);

    const deviceId = await seedDevice(org.id, site.id);
    const settings = await withDbAccessContext(agentContext(org.id, partner.id), () =>
      resolveDeviceHelperSettings(deviceId));

    expect(settings?.enabled).toBe(true);
    expect(settings?.branding).toEqual({ state: 'cleared' });
  });
});
