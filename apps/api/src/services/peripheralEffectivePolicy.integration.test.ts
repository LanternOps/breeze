import '../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../__tests__/integration/setup';
import {
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
