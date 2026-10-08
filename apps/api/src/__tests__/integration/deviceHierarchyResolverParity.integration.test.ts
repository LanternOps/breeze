/**
 * #8053 W1a-1 — every service-layer policy resolver returns the SAME answer
 * with the heartbeat's passed hierarchy as with its own reads, against real
 * PostgreSQL. Each resolver resolves to a NON-default answer for the fixture
 * device, so parity cannot pass on two empty/default results: helper and
 * warranty win through a device_group assignment, patch / monitors / time_sync
 * through a PARTNER-level, partner-wide assignment (the partner id must flow
 * through the hierarchy). Resolvers run in SYSTEM scope with the hierarchy
 * loaded in SYSTEM scope, which is exactly the heartbeat's shape.
 *
 * Discriminating checks: wrong groups / no org change the answer; a hierarchy
 * for ANOTHER device is refused; devices parked in `unassigned_pool` /
 * `quick_support` orgs keep the partner-drop rules on the passed path. All
 * fail before the resolver honours `opts`, because JavaScript silently ignores
 * an extra argument. (event_log / pam policies seeded below are consumed by
 * the route builders later extended into this suite.)
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  automationPolicies,
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configPolicyPatchSettings,
  configPolicyTimeSyncSettings,
  configPolicyWorkloadInventorySettings,
  configurationPolicies,
  monitorDefinitions,
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
import { resolveDeviceWorkloadInventorySettings } from '../../services/workloads/settings';
import { buildResolvedWorkloadInventoryConfigUpdate } from '../../services/workloads/configUpdate';
import {
  buildEventLogConfigUpdate,
  buildHardwareMonitoringConfigUpdate,
  buildMonitoringConfigUpdate,
  buildOnedriveHelperConfigUpdate,
  buildPamConfigUpdate,
  buildPatchSourceConfigUpdate,
  buildPolicyProbeConfigUpdate,
  buildTimeSyncConfigUpdate,
  buildWarrantyConfigUpdate,
  buildWorkloadInventoryConfigUpdate,
} from '../../routes/agents/helpers';
import { buildHelperConfigUpdate } from '../../services/helperSettings';
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

async function seedDevice(orgId: string, siteId: string, label: string): Promise<string> {
  return sys(async () => {
    const unique = randomUUID().slice(0, 8);
    // An unassigned_pool org admits devices only through enrollment; declare
    // that transaction-locally (the guard trigger's own documented hook).
    await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    const [device] = await db.insert(devices).values({
      orgId, siteId, agentId: `par-${label}-${unique}`, hostname: `par-${label}-${unique}`,
      osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '0.0.0-test',
      status: 'online', deviceRole: 'workstation',
    }).returning();
    return device!.id;
  });
}

/** Partner-wide, partner-level policies for patch, time_sync and monitors. */
async function seedPartnerWidePolicies(partnerId: string): Promise<void> {
  await sys(async () => {
    const owner = { orgId: null, partnerId };
    const mk = async (featureType: string) => {
      const [policy] = await db.insert(configurationPolicies).values({
        ...owner, name: `parity ${featureType} ${randomUUID()}`, status: 'active',
      }).returning();
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id, featureType: featureType as never,
      }).returning();
      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy!.id, level: 'partner', targetId: partnerId, priority: 0,
      });
      return link!.id;
    };
    const patchLink = await mk('patch');
    await db.insert(configPolicyPatchSettings).values({
      featureLinkId: patchLink, autoApprove: true, rebootPolicy: 'never', scheduleFrequency: 'daily',
    });
    const timeLink = await mk('time_sync');
    await db.insert(configPolicyTimeSyncSettings).values({
      featureLinkId: timeLink, enforceNtp: true, ntpServers: ['time.parity.example'], pollIntervalMinutes: 30,
    });
    const monitorLink = await mk('monitors');
    const [monitor] = await db.insert(monitorDefinitions).values({
      orgId: null, partnerId, name: `parity-monitor-${randomUUID()}`, kind: 'service',
      condition: { serviceName: 'ParityService', consecutiveFailures: 2 }, severity: 'high',
    }).returning({ id: monitorDefinitions.id });
    await db.insert(configPolicyMonitors).values({ featureLinkId: monitorLink, monitorId: monitor!.id, enabled: true });
  });
}

async function seedFixture(): Promise<Fixture> {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const deviceId = await seedDevice(org.id, site.id, 'agent');
  const fixture = await sys(async () => {
    const unique = randomUUID().slice(0, 8);
    const device = { id: deviceId };
    const groupIds: string[] = [];
    for (const name of ['g1', 'g2']) {
      const [group] = await db.insert(deviceGroups).values({ orgId: org.id, name: `parity ${name} ${unique}` }).returning();
      await db.insert(deviceGroupMemberships).values({ deviceId: device.id, groupId: group!.id, orgId: org.id });
      groupIds.push(group!.id);
    }
    return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device.id, groupIds };
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
  await seedPartnerWidePolicies(partner.id);
  // workload_inventory (#8190): org-owned, assigned to group g2, so it wins
  // only through the hierarchy's groupIds.
  await sys(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: org.id, partnerId: null, name: `parity workload_inventory ${randomUUID()}`, status: 'active',
    }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'workload_inventory' as never,
    }).returning();
    await db.insert(configPolicyWorkloadInventorySettings).values({
      featureLinkId: link!.id, enabled: true, podmanEnabled: false, intervalMinutes: 30,
    });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: 'device_group', targetId: fixture.groupIds[1]!, priority: 0,
    });
  });
  return fixture;
}

async function dropDeviceRedisCaches(deviceId: string): Promise<void> {
  const redis = getTestRedis();
  const keys = await redis.keys(`*${deviceId}*`);
  if (keys.length > 0) await redis.del(...keys);
}

async function loadHierarchy(deviceId: string = f.deviceId): Promise<DeviceHierarchy> {
  const hierarchy = await sys(() => loadDeviceHierarchy(deviceId));
  expect(hierarchy).not.toBeNull();
  return hierarchy!;
}

function foreignHierarchy(h: DeviceHierarchy): DeviceHierarchy {
  return { ...h, deviceId: randomUUID() };
}

type Resolver = (deviceId: string, opts?: DeviceHierarchyOpts) => Promise<unknown>;

/** The own-read answer must be a real policy answer, never null / empty / default. */
const NON_TRIVIAL: Record<string, (own: any) => void> = {
  resolveDeviceHelperSettings: (o) => expect(o).toMatchObject({ enabled: true, showTrayIcon: false }),
  resolvePatchConfigPolicyForDevice: (o) =>
    expect(o).toMatchObject({ assignmentLevel: 'partner', settings: { autoApprove: true, rebootPolicy: 'never' } }),
  resolveMonitorsForDevice: (o) => {
    expect(o.kind).toBe('resolved');
    expect(o.monitors.length).toBeGreaterThan(0);
  },
  resolveEffectiveWarrantyInlineSettings: (o) => expect(o).toMatchObject({ enabled: true, warnDays: 90 }),
  resolveDeviceTimeSyncSettings: (o) => {
    expect(o.policy).not.toBeNull();
    expect(o.settings).toMatchObject({ enforceNtp: true, ntpServers: ['time.parity.example'], pollIntervalMinutes: 30 });
  },
  buildResolvedTimeSyncConfigUpdate: (o) => expect(o).toMatchObject({ enforce_ntp: true, poll_interval_minutes: 30 }),
  buildEventLogConfigUpdate: (o) => expect(o).toMatchObject({ max_events_per_cycle: 321 }),
  buildPamConfigUpdate: (o) => expect(o).toEqual({ uacInterceptionEnabled: true }),
  buildPatchSourceConfigUpdate: (o) => expect(o).toEqual({ exclusiveWindowsUpdate: expect.any(Boolean) }),
  buildWarrantyConfigUpdate: (o) => expect(o).toEqual({ hpCmslEnabled: expect.any(Boolean) }),
  buildTimeSyncConfigUpdate: (o) => expect(o).toMatchObject({ enforce_ntp: true, poll_interval_minutes: 30 }),
  resolveDeviceWorkloadInventorySettings: (o) =>
    expect(o.settings).toMatchObject({ enabled: true, podmanEnabled: false, intervalMinutes: 30 }),
  buildResolvedWorkloadInventoryConfigUpdate: (o) =>
    expect(o).toMatchObject({ enabled: true, podman_enabled: false, interval_minutes: 30 }),
  buildWorkloadInventoryConfigUpdate: (o) =>
    expect(o).toMatchObject({ enabled: true, podman_enabled: false, interval_minutes: 30 }),
  buildMonitoringConfigUpdate: (o) => expect(o).not.toBeNull(),
  buildHelperConfigUpdate: (o) => expect(o).toBeTruthy(),
  // No hardware_monitoring / onedrive policy is seeded: these two answer the
  // default / null for the fixture, so their parity is structural only (the
  // foreign-hierarchy refusal test is the discriminating check for them).
  buildHardwareMonitoringConfigUpdate: () => {},
  buildOnedriveHelperConfigUpdate: () => {},
};

async function expectParity(name: string, resolve: Resolver): Promise<void> {
  await dropDeviceRedisCaches(f.deviceId);
  const own = await sys(() => resolve(f.deviceId));
  NON_TRIVIAL[name]!(own);
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
  ['resolveDeviceWorkloadInventorySettings', (id, o) => resolveDeviceWorkloadInventorySettings(id, o)],
  ['buildResolvedWorkloadInventoryConfigUpdate', (id, o) => buildResolvedWorkloadInventoryConfigUpdate(id, o)],
];

const ROUTE_BUILDERS: Array<[string, Resolver]> = [
  ['buildEventLogConfigUpdate', (id, o) => buildEventLogConfigUpdate(id, o)],
  ['buildHardwareMonitoringConfigUpdate', (id, o) => buildHardwareMonitoringConfigUpdate(id, o)],
  ['buildMonitoringConfigUpdate', (id, o) => buildMonitoringConfigUpdate(id, o)],
  ['buildPamConfigUpdate', (id, o) => buildPamConfigUpdate(id, o)],
  ['buildPatchSourceConfigUpdate', (id, o) => buildPatchSourceConfigUpdate(id, o)],
  ['buildWarrantyConfigUpdate', (id, o) => buildWarrantyConfigUpdate(id, o)],
  ['buildTimeSyncConfigUpdate', (id, o) => buildTimeSyncConfigUpdate(id, o)],
  ['buildWorkloadInventoryConfigUpdate', (id, o) => buildWorkloadInventoryConfigUpdate(id, o)],
  ['buildOnedriveHelperConfigUpdate', (id, o) => buildOnedriveHelperConfigUpdate(id, o)],
  ['buildHelperConfigUpdate', (id, o) => buildHelperConfigUpdate(id, f.orgId, o)],
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

  for (const [name, resolve] of ROUTE_BUILDERS) {
    runDb(`${name}: same answer with the passed hierarchy`, () => expectParity(name, resolve));
    runDb(`${name}: refuses another device's hierarchy`, () => expectForeignRefused(name, resolve));
  }

  runDb('negative control: a hierarchy with no org drops the partner-wide event_log and pam policies', async () => {
    const hierarchy = await loadHierarchy();
    const noOrg: DeviceHierarchy = { ...hierarchy, org: null };
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildEventLogConfigUpdate(f.deviceId))).toMatchObject({ max_events_per_cycle: 321 });
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildEventLogConfigUpdate(f.deviceId, { hierarchy: noOrg }))).toMatchObject({ max_events_per_cycle: 100 });
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildPamConfigUpdate(f.deviceId))).toEqual({ uacInterceptionEnabled: true });
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildPamConfigUpdate(f.deviceId, { hierarchy: noOrg }))).toEqual({ uacInterceptionEnabled: false });
  });

  runDb('negative control: the role in the hierarchy decides a role-filtered policy', async () => {
    const hierarchy = await loadHierarchy();
    await dropDeviceRedisCaches(f.deviceId);
    expect(await sys(() => buildEventLogConfigUpdate(f.deviceId, { hierarchy: { ...hierarchy, deviceRole: 'printer' } })))
      .toMatchObject({ max_events_per_cycle: 100 });
  });

  runDb('policy probe: the passed partner id gives the same probe list as the org read', async () => {
    const own = await sys(() => buildPolicyProbeConfigUpdate(f.orgId));
    const passed = await sys(() => buildPolicyProbeConfigUpdate(f.orgId, { partnerId: f.partnerId }));
    expect(own?.policy_registry_state_probes).toEqual([{ registry_path: 'HKLM\\SOFTWARE\\BreezeParity', value_name: 'Value' }]);
    expect(passed).toEqual(own);
    // Discriminates: with partnerId null the partner-wide probe disappears.
    const orgOnly = await sys(() => buildPolicyProbeConfigUpdate(f.orgId, { partnerId: null }));
    expect(orgOnly?.policy_registry_state_probes).toEqual([]);
  });

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

    // workload_inventory (#8190): its group-assigned policy is lost too, so
    // the resolver falls back to the defaults (enabled: false).
    const workloadNoGroups = await sys(() => resolveDeviceWorkloadInventorySettings(f.deviceId, { hierarchy: noGroups }));
    expect(workloadNoGroups.settings).toMatchObject({ enabled: false, intervalMinutes: 60 });
  });

  runDb('org: null in a passed hierarchy: monitors device_missing, partner patch policy no longer wins', async () => {
    const hierarchy = await loadHierarchy();
    const noOrg: DeviceHierarchy = { ...hierarchy, org: null };
    expect(await sys(() => resolveMonitorsForDevice(f.deviceId, db))).toMatchObject({ kind: 'resolved' });
    expect(await sys(() => resolveMonitorsForDevice(f.deviceId, db, { hierarchy: noOrg }))).toEqual({ kind: 'device_missing' });
    expect(await sys(() => resolvePatchConfigPolicyForDevice(f.deviceId))).toMatchObject({ assignmentLevel: 'partner' });
    expect(await sys(() => resolvePatchConfigPolicyForDevice(f.deviceId, { hierarchy: noOrg }))).toBeNull();
  });

  for (const orgType of ['unassigned_pool', 'quick_support'] as const) {
    runDb(`${orgType} org: partner-level assignment drop rules hold on the passed path`, async () => {
      const parkedOrg = (await createOrganization({ partnerId: f.partnerId, type: orgType }))!;
      const parkedSite = (await createSite({ orgId: parkedOrg.id }))!;
      const deviceId = await seedDevice(parkedOrg.id, parkedSite.id, orgType);
      const hierarchy = await loadHierarchy(deviceId);
      expect(hierarchy.org?.type).toBe(orgType);

      const run = async (name: string, resolve: Resolver) => {
        const own = await sys(() => resolve(deviceId));
        const passed = await sys(() => resolve(deviceId, { hierarchy }));
        expect(passed, `${name} (${orgType})`).toEqual(own);
        return own;
      };
      // Monitors drop the partner target for BOTH types (the customer-org
      // fixture device above resolves a monitor from the same policy).
      expect(await run('resolveMonitorsForDevice', (id, o) => resolveMonitorsForDevice(id, db, o)))
        .toEqual({ kind: 'resolved', monitors: [] });
      // Patch drops the partner only for unassigned_pool.
      const patch = await run('resolvePatchConfigPolicyForDevice', (id, o) => resolvePatchConfigPolicyForDevice(id, o));
      if (orgType === 'unassigned_pool') expect(patch).toBeNull();
      else expect(patch).toMatchObject({ assignmentLevel: 'partner' });
      await run('resolveDeviceTimeSyncSettings', (id, o) => resolveDeviceTimeSyncSettings(id, o));
    });
  }
});
