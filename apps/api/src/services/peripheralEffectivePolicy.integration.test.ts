import '../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../__tests__/integration/setup';
import { eq } from 'drizzle-orm';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  organizations,
  partners,
  peripheralPolicies,
  sites,
} from '../db/schema';
import { loadAndResolveEffectivePeripheralPolicySet } from './peripheralEffectivePolicy';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedOrganization(partnerId: string, label: string) {
  const database = getTestDb();
  const suffix = randomUUID();
  const [organization] = await database.insert(organizations).values({
    partnerId,
    currencyCode: 'USD',
    name: `${label} ${suffix}`,
    slug: `${label.toLowerCase()}-${suffix}`,
    type: 'customer',
    status: 'active',
  }).returning();
  const [site] = await database.insert(sites).values({ orgId: organization!.id, name: `${label} Site` }).returning();
  const [device] = await database.insert(devices).values({
    orgId: organization!.id,
    siteId: site!.id,
    agentId: `agent-${suffix}`,
    hostname: `${label.toLowerCase()}-device`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '1.0.0',
    status: 'offline',
  }).returning();
  return { organization: organization!, site: site!, device: device! };
}

describe('loadAndResolveEffectivePeripheralPolicySet', () => {
  runDb('loads both ownership axes under system context without leaking another organization or partner', async () => {
    const database = getTestDb();
    const suffix = randomUUID();
    const [partner] = await database.insert(partners).values({
      name: `Resolver Partner ${suffix}`,
      slug: `resolver-partner-${suffix}`,
      type: 'msp',
      plan: 'pro',
      status: 'active',
    }).returning();
    const [otherPartner] = await database.insert(partners).values({
      name: `Other Partner ${suffix}`,
      slug: `other-partner-${suffix}`,
      type: 'msp',
      plan: 'pro',
      status: 'active',
    }).returning();
    const first = await seedOrganization(partner!.id, 'First');
    const second = await seedOrganization(partner!.id, 'Second');
    const foreign = await seedOrganization(otherPartner!.id, 'Foreign');

    const [group] = await database.insert(deviceGroups).values({
      orgId: first.organization.id,
      siteId: first.site.id,
      name: 'Resolver Group',
      type: 'static',
    }).returning();
    await database.insert(deviceGroupMemberships).values({
      orgId: first.organization.id,
      deviceId: first.device.id,
      groupId: group!.id,
      addedBy: 'manual',
    });

    const inserted = await database.insert(peripheralPolicies).values([
      {
        orgId: null,
        partnerId: partner!.id,
        name: 'Partner USB fallback',
        deviceClass: 'all_usb',
        action: 'block',
        targetType: 'organization',
        priority: 0,
        targetIds: {},
        exceptions: [],
        isActive: true,
      },
      {
        orgId: first.organization.id,
        partnerId: null,
        name: 'First org storage',
        deviceClass: 'storage',
        action: 'allow',
        targetType: 'organization',
        priority: 0,
        targetIds: {},
        exceptions: [],
        isActive: true,
      },
      {
        orgId: first.organization.id,
        partnerId: null,
        name: 'First group storage',
        deviceClass: 'storage',
        action: 'read_only',
        targetType: 'group',
        priority: 999,
        targetIds: { groupIds: [group!.id] },
        exceptions: [],
        isActive: true,
      },
      {
        orgId: first.organization.id,
        partnerId: null,
        name: 'First device storage',
        deviceClass: 'storage',
        action: 'alert',
        targetType: 'device',
        priority: 1000,
        targetIds: { deviceIds: [first.device.id] },
        exceptions: [],
        isActive: true,
      },
      {
        orgId: second.organization.id,
        partnerId: null,
        name: 'Second org Bluetooth',
        deviceClass: 'bluetooth',
        action: 'allow',
        targetType: 'organization',
        priority: 1,
        targetIds: {},
        exceptions: [],
        isActive: true,
      },
      {
        orgId: foreign.organization.id,
        partnerId: null,
        name: 'Foreign Thunderbolt',
        deviceClass: 'thunderbolt',
        action: 'block',
        targetType: 'organization',
        priority: 1,
        targetIds: {},
        exceptions: [],
        isActive: true,
      },
    ]).returning();

    const firstResult = await loadAndResolveEffectivePeripheralPolicySet(first.device.id);
    expect(firstResult?.identity.groupIds).toEqual([group!.id]);
    expect(firstResult?.effectivePolicies.map((policy) => [policy.effectiveClass, policy.policyId])).toEqual([
      ['all_usb', inserted[0]!.id],
      ['storage', inserted[3]!.id],
    ]);

    const secondResult = await loadAndResolveEffectivePeripheralPolicySet(second.device.id);
    expect(secondResult?.effectivePolicies.map((policy) => [policy.effectiveClass, policy.policyId])).toEqual([
      ['all_usb', inserted[0]!.id],
      ['bluetooth', inserted[4]!.id],
      ['storage', inserted[0]!.id],
    ]);
    expect(JSON.stringify([firstResult, secondResult])).not.toContain(inserted[5]!.id);
  });
});

// #9619 — a Peripheral Control feature link governs which devices get the
// peripheral policy. Exercises the real SQL (winner walk, ownership, active
// filter, loader wiring) that the pure-resolver unit tests cannot.
describe('config-policy link governance (#9619)', () => {
  async function seedPartner(label: string) {
    const suffix = randomUUID();
    const [partner] = await getTestDb().insert(partners).values({
      name: `${label} ${suffix}`,
      slug: `${label.toLowerCase()}-${suffix}`,
      type: 'msp',
      plan: 'pro',
      status: 'active',
    }).returning();
    return partner!;
  }

  async function addSiteDevice(orgId: string, label: string) {
    const database = getTestDb();
    const suffix = randomUUID();
    const [site] = await database.insert(sites).values({ orgId, name: `${label} Site ${suffix}` }).returning();
    const [device] = await database.insert(devices).values({
      orgId,
      siteId: site!.id,
      agentId: `agent-${suffix}`,
      hostname: `${label.toLowerCase()}-${suffix}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'offline',
    }).returning();
    return { site: site!, device: device! };
  }

  async function peripheralPolicy(owner: { orgId?: string; partnerId?: string }, name: string) {
    const [row] = await getTestDb().insert(peripheralPolicies).values({
      orgId: owner.orgId ?? null,
      partnerId: owner.partnerId ?? null,
      name,
      deviceClass: 'storage',
      action: 'block',
      targetType: 'organization',
      priority: 0,
      targetIds: {},
      exceptions: [],
      isActive: true,
    }).returning();
    return row!;
  }

  async function configPolicy(
    owner: { orgId?: string; partnerId?: string },
    peripheralId: string | null,
    assignment: { level: 'partner' | 'organization' | 'site' | 'device_group' | 'device'; targetId: string },
  ) {
    const database = getTestDb();
    const [policy] = await database.insert(configurationPolicies).values({
      orgId: owner.orgId ?? null,
      partnerId: owner.partnerId ?? null,
      name: `CP ${randomUUID()}`,
      status: 'active',
    }).returning();
    if (peripheralId) {
      await database.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id,
        featureType: 'peripheral_control',
        featurePolicyId: peripheralId,
      });
    }
    await database.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: assignment.level,
      targetId: assignment.targetId,
      priority: 0,
    });
    return policy!;
  }

  const idsFor = async (deviceId: string) =>
    (await loadAndResolveEffectivePeripheralPolicySet(deviceId))?.effectivePolicies
      .filter((p) => p.configuredClass === 'storage' && p.effectiveClass === 'storage')
      .map((p) => p.policyId) ?? [];

  runDb('a linked policy applies only to the devices its config policy is assigned to; deactivating or unlinking reverts to standalone targeting', async () => {
    const partner = await seedPartner('LinkA');
    const base = await seedOrganization(partner.id, 'LinkA');
    const other = await addSiteDevice(base.organization.id, 'LinkAOther');
    const periph = await peripheralPolicy({ orgId: base.organization.id }, 'Linked storage');
    const cp = await configPolicy({ orgId: base.organization.id }, periph.id, { level: 'site', targetId: base.site.id });

    expect(await idsFor(base.device.id)).toEqual([periph.id]);
    // Same org, org-wide standalone target — but the link narrows it to the assigned site.
    expect(await idsFor(other.device.id)).toEqual([]);

    const database = getTestDb();
    await database.update(configurationPolicies).set({ status: 'inactive' }).where(eq(configurationPolicies.id, cp.id));
    expect(await idsFor(other.device.id)).toEqual([periph.id]);

    await database.update(configurationPolicies).set({ status: 'active' }).where(eq(configurationPolicies.id, cp.id));
    expect(await idsFor(other.device.id)).toEqual([]);

    await database.delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, cp.id));
    expect(await idsFor(other.device.id)).toEqual([periph.id]);
  });

  runDb('the closest-level link wins; the broader linked policy does not also apply', async () => {
    const partner = await seedPartner('LinkB');
    const base = await seedOrganization(partner.id, 'LinkB');
    const other = await addSiteDevice(base.organization.id, 'LinkBOther');
    const broad = await peripheralPolicy({ orgId: base.organization.id }, 'Org-level link');
    const narrow = await peripheralPolicy({ orgId: base.organization.id }, 'Site-level link');
    await configPolicy({ orgId: base.organization.id }, broad.id, { level: 'organization', targetId: base.organization.id });
    await configPolicy({ orgId: base.organization.id }, narrow.id, { level: 'site', targetId: base.site.id });

    expect(await idsFor(base.device.id)).toEqual([narrow.id]);
    expect(await idsFor(other.device.id)).toEqual([broad.id]);
  });

  runDb("a partner-wide config policy governs a partner-owned peripheral policy; another org's link does not capture it", async () => {
    const partner = await seedPartner('LinkC');
    const first = await seedOrganization(partner.id, 'LinkCFirst');
    const second = await seedOrganization(partner.id, 'LinkCSecond');
    const periph = await peripheralPolicy({ partnerId: partner.id }, 'Partner template');

    // Linked only from the SECOND org's config policy: the first org's device
    // keeps the policy's standalone targeting.
    await configPolicy({ orgId: second.organization.id }, periph.id, { level: 'organization', targetId: second.organization.id });
    expect(await idsFor(first.device.id)).toEqual([periph.id]);

    // A partner-wide config policy assigned to the first org's site governs it.
    const extra = await addSiteDevice(first.organization.id, 'LinkCExtra');
    await configPolicy({ partnerId: partner.id }, periph.id, { level: 'site', targetId: first.site.id });
    expect(await idsFor(first.device.id)).toEqual([periph.id]);
    expect(await idsFor(extra.device.id)).toEqual([]);
  });
});
