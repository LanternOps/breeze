/**
 * A partner-wide `service` monitor reaches a device's heartbeat
 * `monitoring_settings` under the AGENT'S OWN DB context (#5287 W04, #5291).
 *
 * W04 made `buildMonitoringConfigUpdate` source service/process watches from
 * the device's effective MONITOR set first and the config-policy Monitoring tab
 * second. The monitor-definition read runs in the caller's own context, so a
 * PARTNER-WIDE definition is legible there only because of
 * `monitor_definitions_partner_wide_select` (W02) plus the
 * `breeze.current_partner_id` GUC that `middleware/agentAuth` sets.
 *
 * That combination fails SILENTLY when it breaks: the read returns zero rows,
 * not an error, and the agent simply stops being told to watch anything. No
 * unit test can catch it — they all mock the db and never exercise RLS. Hence
 * this suite, and specifically the `partnerWideBlindContext` case, which
 * requires the partner-wide monitor to be INVISIBLE without the GUC. Together
 * the two halves pin that the RLS branch (not a system-context escape) is what
 * is doing the work: under an escape the GUC would be irrelevant and the
 * monitor would resolve either way.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configurationPolicies,
  devices,
  monitorDefinitions,
} from '../../db/schema';
import { buildMonitoringConfigUpdate } from '../../routes/agents/helpers';
import { getRedis } from '../../services/redis';
import { createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

/** The realistic agent-facing shape (`agentAuthMiddleware` since #4673 W02). */
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

/** The SAME context minus the GUC — what an agent context looked like before W02. */
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
const createdMonitors: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdDevices) await db.delete(devices).where(eq(devices.id, id));
    for (const id of createdPolicies) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
    for (const id of createdMonitors) {
      await db.delete(monitorDefinitions).where(eq(monitorDefinitions.id, id));
    }
  });
  createdDevices.length = 0;
  createdPolicies.length = 0;
  createdMonitors.length = 0;
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

/**
 * A partner-wide `service` monitor, attached through a PARTNER-level policy.
 * `serviceName` is the field the assertions key on, so a passing test proves
 * THIS definition resolved rather than some default.
 */
async function seedPartnerWideServiceMonitor(partnerId: string, serviceName: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [monitor] = await db
      .insert(monitorDefinitions)
      .values({
        orgId: null,
        partnerId,
        name: `watch-${serviceName}`,
        kind: 'service',
        condition: { serviceName, consecutiveFailures: 4 },
        severity: 'high',
      })
      .returning({ id: monitorDefinitions.id });
    createdMonitors.push(monitor!.id);

    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: null,
        partnerId,
        name: `policy-${randomUUID().slice(0, 8)}`,
        status: 'active',
      })
      .returning({ id: configurationPolicies.id });
    createdPolicies.push(policy!.id);

    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'monitors' })
      .returning({ id: configPolicyFeatureLinks.id });

    await db.insert(configPolicyMonitors).values({
      featureLinkId: link!.id,
      monitorId: monitor!.id,
      enabled: true,
    });

    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: 'partner',
      targetId: partnerId,
      priority: 0,
    });

    return monitor!.id;
  });
}

/**
 * `buildMonitoringConfigUpdate` caches on `monitoring:settings:device:<id>` for
 * 120s. Every test seeds a FRESH device (fresh uuid → fresh key), which alone
 * rules out a stale hit; this purge makes the point explicit rather than
 * implicit, so a passing assertion is never a cached artifact.
 */
async function purgeCache(deviceId: string) {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`monitoring:settings:device:${deviceId}`);
}

describe('partner-wide monitor watch delivery (#5291 W04)', () => {
  it('delivers a partner-wide service monitor to the agent under its OWN context', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);
    await purgeCache(device.id);

    await seedPartnerWideServiceMonitor(partner.id, 'PartnerWideSpooler');

    const result = await withDbAccessContext(orgContext(org!.id, partner.id), () =>
      buildMonitoringConfigUpdate(device.id),
    );

    expect(result).not.toBeNull();
    expect(result!.watches).toHaveLength(1);
    expect(result!.watches[0]).toEqual({
      watch_type: 'service',
      name: 'PartnerWideSpooler',
      alert_on_stop: true,
      // From the definition's own condition — proves THIS monitor resolved
      // rather than a default watch appearing from somewhere else.
      alert_after_consecutive_failures: 4,
      auto_restart: false,
      max_restart_attempts: 3,
      restart_cooldown_seconds: 300,
    });
    // No monitoring-tab policy resolved, so the monitor-only interval applies.
    expect(result!.check_interval_seconds).toBe(60);
  });

  it('is INVISIBLE without breeze.current_partner_id — the SELECT branch is load-bearing', async () => {
    // If a system-context escape were reintroduced here, the GUC would be
    // irrelevant and this would resolve anyway. It must not.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org!.id });
    const device = await seedDevice(org!.id, site!.id);
    await purgeCache(device.id);

    await seedPartnerWideServiceMonitor(partner.id, 'BlindSpooler');

    const result = await withDbAccessContext(partnerWideBlindContext(org!.id), () =>
      buildMonitoringConfigUpdate(device.id),
    );

    expect(result).toBeNull();
  });

  it('does not leak a partner-wide monitor to an org under a DIFFERENT partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const siteB = await createSite({ orgId: orgB!.id });
    const deviceB = await seedDevice(orgB!.id, siteB!.id);
    await purgeCache(deviceB.id);

    await seedPartnerWideServiceMonitor(partnerA.id, 'ForeignSpooler');

    const result = await withDbAccessContext(orgContext(orgB!.id, partnerB.id), () =>
      buildMonitoringConfigUpdate(deviceB.id),
    );

    expect(result).toBeNull();
  });
});
