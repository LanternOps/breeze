/**
 * #6353 — a `network_check` monitor raises exactly ONE alert per org, on the
 * check's alert device, whether or not that device is online.
 *
 * Real Postgres, real compiler, real alert pipeline: a failing http check
 * attached to an org-level configuration policy in an org with two ONLINE
 * devices and one OFFLINE device that is the most recently seen (so the legacy
 * alert-device rule picks it). Before the fix the per-device sweep raised one
 * alert per online device and none on the offline one; after it, the
 * device-independent sweep raises exactly one, on the offline device, the
 * per-device sweep adds nothing, and auto-resolve clears it when the check
 * recovers.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configPolicyMaintenanceSettings,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  monitorDefinitions,
  monitorDeviceState,
  networkMonitorResults,
  networkMonitors,
} from '../../db/schema';
import { compileMonitorInTx } from '../../services/monitors/monitorCompiler';
import {
  evaluateNetworkCheckAlertsForOrg,
  selectNetworkCheckOrgIds,
} from '../../services/monitors/networkCheckAlertSweep';
import { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION } from '../../services/alertConditions/handlers/networkCheck';
import { checkAllAutoResolve, evaluateDeviceAlerts } from '../../services/alertService';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const system = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const createdOrgIds: string[] = [];
const createdPartnerIds: string[] = [];

afterEach(async () => {
  const orgIds = [...new Set(createdOrgIds)];
  const partnerIds = [...new Set(createdPartnerIds)];
  createdOrgIds.length = 0;
  createdPartnerIds.length = 0;
  await system(async () => {
    if (orgIds.length > 0) {
      await db.delete(alerts).where(inArray(alerts.orgId, orgIds));
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.orgId, orgIds));
      await db.delete(deviceGroupMemberships).where(inArray(deviceGroupMemberships.orgId, orgIds));
      await db.delete(deviceGroups).where(inArray(deviceGroups.orgId, orgIds));
      // monitor_definitions cascades into the managed alert_templates /
      // alert_rules / automations / network_monitors (+ results).
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.orgId, orgIds));
      await db.delete(devices).where(inArray(devices.orgId, orgIds));
    }
    if (partnerIds.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.partnerId, partnerIds));
    }
  });
});

let deviceSeq = 0;

async function seedDevice(
  orgId: string,
  siteId: string,
  opts: { status: 'online' | 'offline'; lastSeenAt: Date },
): Promise<string> {
  deviceSeq += 1;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-6353-${Date.now()}-${deviceSeq}`,
      hostname: `nc-host-${deviceSeq}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x64',
      agentVersion: '1.0.0',
      status: opts.status,
      lastSeenAt: opts.lastSeenAt,
    })
    .returning({ id: devices.id });
  return device!.id;
}

async function fixture(scope: 'organization' | 'device_group' = 'organization') {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  createdPartnerIds.push(partner.id);
  createdOrgIds.push(org.id);

  const now = Date.now();
  // Two online devices seen a while ago, one OFFLINE device seen most recently
  // — the legacy rule (most recently seen, offline eligible) picks the offline one.
  const onlineA = await seedDevice(org.id, site.id, { status: 'online', lastSeenAt: new Date(now - 60_000) });
  const onlineB = await seedDevice(org.id, site.id, { status: 'online', lastSeenAt: new Date(now - 30_000) });
  const offlineAlertDevice = await seedDevice(org.id, site.id, { status: 'offline', lastSeenAt: new Date(now - 1_000) });

  // The monitor definition, compiled the way the route does it: managed
  // template + rule (targetType 'monitor') + network_monitors row.
  const [def] = await system(() =>
    db
      .insert(monitorDefinitions)
      .values({
        orgId: org.id,
        partnerId: null,
        name: `Portal reachable ${randomUUID().slice(0, 8)}`,
        kind: 'network_check',
        condition: {
          checkType: 'http_check',
          target: 'https://portal.example.test/health',
          expectStatus: 200,
          pollingIntervalSeconds: 60,
          timeoutSeconds: 5,
          consecutiveFailures: 2,
        },
        severity: 'high',
        autoResolve: true,
        deliveryMode: 'none',
        createdBy: user.id,
      })
      .returning(),
  );
  await system(() => db.transaction((tx) => compileMonitorInTx(tx, def!)));

  const [managed] = await system(() =>
    db.select({ id: networkMonitors.id }).from(networkMonitors).where(eq(networkMonitors.managedByMonitorId, def!.id)),
  );
  expect(managed, 'compiler must have provisioned the managed network_monitors row').toBeDefined();

  // Attached through a configuration policy: at ORG level every device in the
  // org resolves the monitor — the exact shape that multiplied alerts; at
  // DEVICE_GROUP level only onlineA (the "Servers" group) does, so the org-wide
  // recency pick (the offline device) is outside the monitor's scope.
  await system(async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: org.id, name: `net-policy-${randomUUID().slice(0, 8)}`, status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'monitors' })
      .returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyMonitors).values({ featureLinkId: link!.id, monitorId: def!.id });

    let targetId = org.id;
    if (scope === 'device_group') {
      const [group] = await db
        .insert(deviceGroups)
        .values({ orgId: org.id, name: `Servers ${randomUUID().slice(0, 8)}`, type: 'static' })
        .returning({ id: deviceGroups.id });
      await db.insert(deviceGroupMemberships).values({ deviceId: onlineA, groupId: group!.id, orgId: org.id });
      targetId = group!.id;
    }
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: scope,
      targetId,
      priority: 0,
    });
  });

  return { orgId: org.id, defId: def!.id, managedId: managed!.id, onlineA, onlineB, offlineAlertDevice };
}

async function pushResults(f: Awaited<ReturnType<typeof fixture>>, status: 'online' | 'offline', n: number) {
  const base = Date.now();
  await system(() =>
    db.insert(networkMonitorResults).values(
      Array.from({ length: n }, (_, i) => ({
        monitorId: f.managedId,
        orgId: f.orgId,
        deviceId: f.onlineA,
        status,
        responseMs: status === 'online' ? 42 : 0,
        timestamp: new Date(base + i * 1000),
      })),
    ),
  );
}

async function activeAlerts(orgId: string) {
  return system(() =>
    db
      .select({ id: alerts.id, deviceId: alerts.deviceId, monitorId: alerts.monitorId, status: alerts.status })
      .from(alerts)
      .where(and(eq(alerts.orgId, orgId), inArray(alerts.status, ['active', 'acknowledged']))),
  );
}

describe('network_check — one alert per check, on the alert device, online or not (#6353)', () => {
  it('exports the capability W05e gates on', () => {
    expect(NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION).toBe(true);
  });

  it('alert device offline + failing http check attached via policy → exactly one active alert; recovery auto-resolves it', async () => {
    const f = await fixture();
    await pushResults(f, 'offline', 2);

    // The evaluate-all tick hands this org to the device-independent sweep.
    const orgIds = await system(() => selectNetworkCheckOrgIds());
    expect(orgIds).toContain(f.orgId);

    // The sweep itself (what the evaluate-network-checks job runs), plus the
    // per-device sweep for every ONLINE device exactly as evaluate-all would
    // fan it out. Run twice to prove idempotence (dedupe per rule+device).
    for (let pass = 0; pass < 2; pass++) {
      const outcome = await system(() => evaluateNetworkCheckAlertsForOrg(f.orgId));
      expect(outcome.checks).toBe(1);
      expect(outcome.devicesEvaluated).toBe(1);
      expect(outcome.checksWithoutDevice).toBe(0);
      await system(() => evaluateDeviceAlerts(f.onlineA));
      await system(() => evaluateDeviceAlerts(f.onlineB));
    }

    const open = await activeAlerts(f.orgId);
    expect(open, JSON.stringify(open)).toHaveLength(1);
    expect(open[0]!.deviceId).toBe(f.offlineAlertDevice);
    expect(open[0]!.monitorId).toBe(f.defId);

    // Exactly one open episode too, on the same device.
    const states = await system(() =>
      db
        .select({ deviceId: monitorDeviceState.deviceId, episodeId: monitorDeviceState.currentEpisodeId })
        .from(monitorDeviceState)
        .where(eq(monitorDeviceState.monitorId, f.defId)),
    );
    expect(states.filter((s) => s.episodeId !== null).map((s) => s.deviceId)).toEqual([f.offlineAlertDevice]);

    // Recovery: newer online results in front of the failures → auto-resolve
    // re-evaluates the trigger condition for the alert's (still offline)
    // device and clears it.
    await pushResults(f, 'online', 2);
    const resolved = await system(() => checkAllAutoResolve(f.orgId));
    expect(resolved).toBe(1);
    expect(await activeAlerts(f.orgId)).toHaveLength(0);

    // And a healthy check stays quiet on the next tick.
    const quiet = await system(() => evaluateNetworkCheckAlertsForOrg(f.orgId));
    expect(quiet.alertIds).toEqual([]);
    expect(await activeAlerts(f.orgId)).toHaveLength(0);
  });

  it('suppresses monitor alerts during policy maintenance, resumes outside, and still auto-resolves open alerts', async () => {
    const f = await fixture();
    await pushResults(f, 'offline', 2);
    const maintenanceId = await system(async () => {
      const [policy] = await db.insert(configurationPolicies).values({
        orgId: f.orgId, name: 'Maintenance', status: 'active',
      }).returning();
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id, featureType: 'maintenance',
      }).returning();
      const [settings] = await db.insert(configPolicyMaintenanceSettings).values({
        featureLinkId: link!.id, recurrence: 'once', durationHours: 2,
        windowStart: new Date(Date.now() - 60_000).toISOString(),
        timezone: 'UTC', suppressAlerts: true,
      }).returning();
      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy!.id, level: 'organization', targetId: f.orgId, priority: 0,
      });
      return settings!.id;
    });

    expect((await system(() => evaluateNetworkCheckAlertsForOrg(f.orgId))).alertIds).toEqual([]);
    expect(await activeAlerts(f.orgId)).toHaveLength(0);

    await system(() => db.update(configPolicyMaintenanceSettings).set({
      windowStart: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    }).where(eq(configPolicyMaintenanceSettings.id, maintenanceId)));
    expect((await system(() => evaluateNetworkCheckAlertsForOrg(f.orgId))).alertIds).toHaveLength(1);
    expect(await activeAlerts(f.orgId)).toHaveLength(1);

    await system(() => db.update(configPolicyMaintenanceSettings).set({
      windowStart: new Date(Date.now() - 60_000).toISOString(),
    }).where(eq(configPolicyMaintenanceSettings.id, maintenanceId)));
    await pushResults(f, 'online', 2);
    expect(await system(() => checkAllAutoResolve(f.orgId))).toBe(1);
    expect(await activeAlerts(f.orgId)).toHaveLength(0);
  });

  it('a device-group-scoped attachment alerts on the most recent device IN the group, not the org-wide recency pick', async () => {
    const f = await fixture('device_group');
    await pushResults(f, 'offline', 2);

    const outcome = await system(() => evaluateNetworkCheckAlertsForOrg(f.orgId));
    expect(outcome.checks).toBe(1);
    expect(outcome.checksWithoutDevice).toBe(0);
    expect(outcome.alertIds).toHaveLength(1);

    const open = await activeAlerts(f.orgId);
    expect(open).toHaveLength(1);
    // The legacy rule alone would have picked the offline device (most
    // recently seen) — which the group policy never reaches, so nothing would
    // have been evaluated. The monitor-aware pick lands on the group member.
    expect(open[0]!.deviceId).toBe(f.onlineA);
  });

  it('N online devices + one failing check → the per-device sweep alone raises NOTHING (the verdict is not per device)', async () => {
    const f = await fixture();
    await pushResults(f, 'offline', 2);

    await system(() => evaluateDeviceAlerts(f.onlineA));
    await system(() => evaluateDeviceAlerts(f.onlineB));
    // Even the alert device, swept per-device, defers to the network_check sweep.
    await system(() => evaluateDeviceAlerts(f.offlineAlertDevice));

    expect(await activeAlerts(f.orgId)).toHaveLength(0);

    const outcome = await system(() => evaluateNetworkCheckAlertsForOrg(f.orgId));
    expect(outcome.alertIds).toHaveLength(1);
    const open = await activeAlerts(f.orgId);
    expect(open).toHaveLength(1);
    expect(open[0]!.deviceId).toBe(f.offlineAlertDevice);
  });
});
