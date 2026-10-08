/**
 * #8053 W1a-1 — every policy resolver returns the SAME answer with the
 * heartbeat's passed hierarchy as with its own reads, against real PostgreSQL
 * with real policies at the device_group, organization and partner levels
 * (org-owned and partner-wide). Resolvers run in SYSTEM scope with the
 * hierarchy loaded in SYSTEM scope, which is exactly the heartbeat's shape.
 *
 * Two discriminating checks make the parity assertion mean something: a
 * hierarchy with the WRONG groups or NO org must change the answer for a
 * resolver whose winning policy depends on it, and a hierarchy for ANOTHER
 * device must be refused. Both fail before the resolver honours `opts`, because
 * JavaScript silently ignores an extra argument.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  automationPolicies,
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
} from '../../db/schema';
import {
  DeviceHierarchyMismatchError,
  loadDeviceHierarchy,
  type DeviceHierarchy,
  type DeviceHierarchyOpts,
} from '../../services/deviceHierarchy';
import { resolveDeviceHelperSettings } from '../../services/helperSettings';
import { resolvePatchConfigPolicyForDevice } from '../../services/featureConfigResolver';
import { resolveMonitorsForDevice } from '../../services/monitors/monitorResolver';
import { resolveEffectiveWarrantyInlineSettings } from '../../services/warrantyPolicyResolution';
import { resolveDeviceTimeSyncSettings } from '../../services/timeSync/settings';
import { buildResolvedTimeSyncConfigUpdate } from '../../services/timeSync/configUpdate';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestRedis } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

type Level = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

interface Fixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  groupIds: string[];
}

let f: Fixture;

async function seedPolicy(input: {
  owner: { orgId: string | null; partnerId: string | null };
  featureType: string;
  inlineSettings?: Record<string, unknown>;
  eventLog?: { maxEventsPerCycle: number };
  level: Level;
  targetId: string;
  roleFilter?: string[];
}): Promise<string> {
  return sys(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: input.owner.orgId, partnerId: input.owner.partnerId,
      name: `parity ${input.featureType} ${randomUUID()}`, status: 'active',
    }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: input.featureType as never,
      ...(input.inlineSettings ? { inlineSettings: input.inlineSettings } : {}),
    }).returning();
    if (input.eventLog) {
      await db.insert(configPolicyEventLogSettings).values({
        featureLinkId: link!.id, retentionDays: 30, maxEventsPerCycle: input.eventLog.maxEventsPerCycle,
      });
    }
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: input.level, targetId: input.targetId, priority: 0,
      ...(input.roleFilter ? { roleFilter: input.roleFilter } : {}),
    });
    return policy!.id;
  });
}

async function seedFixture(): Promise<Fixture> {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const fixture = await sys(async () => {
    const unique = randomUUID().slice(0, 8);
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `par-agent-${unique}`, hostname: `par-${unique}`,
      osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '0.0.0-test',
      status: 'online', deviceRole: 'workstation',
    }).returning();
    const groupIds: string[] = [];
    for (const name of ['g1', 'g2']) {
      const [group] = await db.insert(deviceGroups).values({ orgId: org.id, name: `parity ${name} ${unique}` }).returning();
      await db.insert(deviceGroupMemberships).values({ deviceId: device!.id, groupId: group!.id, orgId: org.id });
      groupIds.push(group!.id);
    }
    return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device!.id, groupIds };
  });

  // helper: org-owned, assigned to group g2 (wins only through groupIds).
  await seedPolicy({ owner: { orgId: org.id, partnerId: null }, featureType: 'helper',
    inlineSettings: { enabled: true, showTrayIcon: false }, level: 'device_group', targetId: fixture.groupIds[1]! });
  // warranty: org-owned, assigned to group g1.
  await seedPolicy({ owner: { orgId: org.id, partnerId: null }, featureType: 'warranty',
    inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 }, level: 'device_group', targetId: fixture.groupIds[0]! });
  // event_log: PARTNER-WIDE, assigned at partner level, role-filtered to this device's role.
  await seedPolicy({ owner: { orgId: null, partnerId: partner.id }, featureType: 'event_log',
    eventLog: { maxEventsPerCycle: 321 }, level: 'partner', targetId: partner.id, roleFilter: ['workstation'] });
  // pam: PARTNER-WIDE, assigned at partner level.
  await seedPolicy({ owner: { orgId: null, partnerId: partner.id }, featureType: 'pam',
    inlineSettings: { uacInterceptionEnabled: true }, level: 'partner', targetId: partner.id });
  // policy probe: a partner-wide automation policy with one registry probe.
  await sys(async () => {
    await db.insert(automationPolicies).values({
      orgId: null, partnerId: partner.id, name: `parity probe ${randomUUID()}`, enabled: true, targets: {},
      rules: [{ type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\BreezeParity', registryValueName: 'Value' }],
    });
  });
  return fixture;
}

async function dropDeviceRedisCaches(deviceId: string): Promise<void> {
  const redis = getTestRedis();
  const keys = await redis.keys(`*${deviceId}*`);
  if (keys.length > 0) await redis.del(...keys);
}

async function loadHierarchy(): Promise<DeviceHierarchy> {
  const hierarchy = await sys(() => loadDeviceHierarchy(f.deviceId));
  expect(hierarchy).not.toBeNull();
  return hierarchy!;
}

function foreignHierarchy(h: DeviceHierarchy): DeviceHierarchy {
  return { ...h, deviceId: randomUUID() };
}

type Resolver = (deviceId: string, opts?: DeviceHierarchyOpts) => Promise<unknown>;

async function expectParity(name: string, resolve: Resolver): Promise<void> {
  await dropDeviceRedisCaches(f.deviceId);
  const own = await sys(() => resolve(f.deviceId));
  const hierarchy = await loadHierarchy();
  await dropDeviceRedisCaches(f.deviceId);
  const passed = await sys(() => resolve(f.deviceId, { hierarchy }));
  expect(passed, `${name}: passed hierarchy must not change the answer`).toEqual(own);
}

async function expectForeignRefused(name: string, resolve: Resolver): Promise<void> {
  const hierarchy = await loadHierarchy();
  await dropDeviceRedisCaches(f.deviceId);
  await expect(sys(() => resolve(f.deviceId, { hierarchy: foreignHierarchy(hierarchy) })), name)
    .rejects.toBeInstanceOf(DeviceHierarchyMismatchError);
}

const SERVICE_RESOLVERS: Array<[string, Resolver]> = [
  ['resolveDeviceHelperSettings', (id, o) => resolveDeviceHelperSettings(id, o)],
  ['resolvePatchConfigPolicyForDevice', (id, o) => resolvePatchConfigPolicyForDevice(id, o)],
  ['resolveMonitorsForDevice', (id, o) => resolveMonitorsForDevice(id, db, o)],
  ['resolveEffectiveWarrantyInlineSettings', (id, o) => resolveEffectiveWarrantyInlineSettings(id, o)],
  ['resolveDeviceTimeSyncSettings', (id, o) => resolveDeviceTimeSyncSettings(id, o)],
  ['buildResolvedTimeSyncConfigUpdate', (id, o) => buildResolvedTimeSyncConfigUpdate(id, o)],
];

describe('policy resolvers: passed hierarchy parity (#8053 W1a-1) — real PostgreSQL', () => {
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    f = await seedFixture();
  });

  for (const [name, resolve] of SERVICE_RESOLVERS) {
    runDb(`${name}: same answer with the passed hierarchy`, () => expectParity(name, resolve));
    runDb(`${name}: refuses another device's hierarchy`, () => expectForeignRefused(name, resolve));
  }

  runDb('negative control: wrong groups change the helper and warranty answers (the hierarchy is really used)', async () => {
    const hierarchy = await loadHierarchy();
    const noGroups: DeviceHierarchy = { ...hierarchy, groupIds: [] };
    const helperOwn = await sys(() => resolveDeviceHelperSettings(f.deviceId));
    const helperNoGroups = await sys(() => resolveDeviceHelperSettings(f.deviceId, { hierarchy: noGroups }));
    expect(helperOwn).toMatchObject({ enabled: true, showTrayIcon: false });
    expect(helperNoGroups).toBeNull();

    const warrantyOwn = await sys(() => resolveEffectiveWarrantyInlineSettings(f.deviceId));
    const warrantyNoGroups = await sys(() => resolveEffectiveWarrantyInlineSettings(f.deviceId, { hierarchy: noGroups }));
    expect(warrantyOwn).toMatchObject({ enabled: true });
    expect(warrantyNoGroups).toBeUndefined();
  });
});
