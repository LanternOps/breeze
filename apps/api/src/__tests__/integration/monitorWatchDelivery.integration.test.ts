/**
 * A partner-wide `service` monitor reaches a device's heartbeat
 * `monitoring_settings` under the AGENT'S OWN DB context (#5287 W04, #5291).
 *
 * W05d sources service/process watches only from the device's effective
 * MONITOR set; the monitors link supplies the check interval. The
 * monitor-definition read runs in the caller's own context, so a
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
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configPolicyMonitoringSettings,
  configPolicyMonitoringWatches,
  configurationPolicies,
  devices,
  monitorDefinitions,
} from '../../db/schema';
import { buildMonitoringConfigUpdate } from '../../routes/agents/helpers';
import { createMonitorDefinition, getMonitorDefinition } from '../../services/monitors/monitorService';
import { getRedis } from '../../services/redis';
import { updateFeatureLink } from '../../services/configurationPolicy';
import { monitorsLinkSettings, readMonitorsLink } from '../../services/monitors/monitorAttachments';
import { replayMigration } from './replayMigration';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

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
    // Device-level assignments reference the device and the policy owner; drop them first.
    for (const id of createdPolicies) {
      await db.delete(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, id));
    }
    for (const id of createdDevices) await db.delete(devices).where(eq(devices.id, id));
    for (const id of [...createdPolicies].reverse()) {
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
async function seedPartnerWideServiceMonitor(
  partnerId: string,
  serviceName: string,
  checkIntervalSeconds?: number,
) {
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

    if (checkIntervalSeconds !== undefined) {
      const [settings] = await db.insert(configPolicyMonitoringSettings).values({
        featureLinkId: link!.id,
        checkIntervalSeconds,
      }).returning({ id: configPolicyMonitoringSettings.id });
      // Re-keyed settings retain their historical watches for conversion history.
      await db.insert(configPolicyMonitoringWatches).values({
        settingsId: settings!.id,
        watchType: 'service',
        name: 'RetiredHistoricalService',
        enabled: true,
        retiredAt: new Date(),
        retiredReason: 'unconvertible:equivalence_delta',
      });
    }

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

    await seedPartnerWideServiceMonitor(partner.id, 'PartnerWideSpooler', 90);

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
    // The monitors link supplies the interval; its historical watch stays off the wire.
    expect(result!.check_interval_seconds).toBe(90);
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

    // Invisible → "nothing applies" → the explicit #2949 empty clear.
    expect(result).toEqual({ check_interval_seconds: 60, watches: [] });
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

    // Invisible → "nothing applies" → the explicit #2949 empty clear.
    expect(result).toEqual({ check_interval_seconds: 60, watches: [] });
  });
});

describe('restart response watch delivery (#6343)', () => {
  it('round-trips a restart response through create and read into the agent watch', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id);
    await purgeCache(device.id);

    const auth = {
      principal: { kind: 'user_session' },
      user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: false },
      token: null,
      partnerId: partner.id,
      orgId: org.id,
      scope: 'organization',
      accessibleOrgIds: [org.id],
      partnerOrgAccess: null,
      orgCondition: (column: Parameters<typeof eq>[0]) => eq(column, org.id),
      canAccessOrg: (orgId: string) => orgId === org.id,
    } as Parameters<typeof createMonitorDefinition>[1];
    const response = {
      type: 'execute_command',
      kind: 'restart_service',
      command: 'Restart-Service Spooler',
      shell: 'powershell',
      whenOffline: 'queue',
      maxAttempts: 7,
      cooldownSeconds: 120,
    } as const;

    const created = await withDbAccessContext(SYSTEM_CTX, () =>
      createMonitorDefinition({
        ownerScope: 'organization',
        name: `Restart Spooler ${randomUUID().slice(0, 8)}`,
        kind: 'service',
        enabled: true,
        condition: { serviceName: 'Spooler', consecutiveFailures: 4 },
        severity: 'high',
        cooldownMinutes: 5,
        autoResolve: false,
        responses: [response],
        deliveryMode: 'inherit',
        deliveryChannelIds: [],
        recurrenceActions: [],
        pauseResponsesOnEscalation: true,
      }, auth),
    );
    createdMonitors.push(created.id);

    const stored = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      getMonitorDefinition(created.id, auth),
    );
    expect(stored?.responses).toEqual([response]);

    await withDbAccessContext(SYSTEM_CTX, async () => {
      const [policy] = await db.insert(configurationPolicies).values({
        orgId: org.id,
        name: `restart-policy-${randomUUID().slice(0, 8)}`,
        status: 'active',
      }).returning({ id: configurationPolicies.id });
      createdPolicies.push(policy!.id);
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id,
        featureType: 'monitors',
      }).returning({ id: configPolicyFeatureLinks.id });
      await db.insert(configPolicyMonitors).values({
        featureLinkId: link!.id,
        monitorId: stored!.id,
        enabled: true,
      });
      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy!.id,
        level: 'organization',
        targetId: org.id,
        priority: 0,
      });
    });

    const result = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      buildMonitoringConfigUpdate(device.id),
    );
    expect(result?.watches).toEqual([{
      watch_type: 'service',
      name: 'Spooler',
      alert_on_stop: true,
      alert_after_consecutive_failures: 4,
      auto_restart: true,
      max_restart_attempts: 7,
      restart_cooldown_seconds: 120,
    }]);
  });
});

/** Separate attachment inheritance from the policy's explicit interval. */
describe('monitors interval provenance reaches the agent', () => {
  async function fixture() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id);
    await purgeCache(device.id);
    return { partner, org, device };
  }

  async function policy(orgId: string, opts: {
    interval?: number;
    parentPolicyId?: string;
    status?: 'active' | 'inactive';
    legacy?: boolean;
    assignment?: { level: 'device' | 'organization'; targetId: string };
  } = {}) {
    return withDbAccessContext(SYSTEM_CTX, async () => {
      const [row] = await db.insert(configurationPolicies).values({
        orgId, name: `interval-${randomUUID()}`, status: opts.status ?? 'active',
        parentPolicyId: opts.parentPolicyId,
      }).returning();
      createdPolicies.push(row!.id);
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: row!.id, featureType: opts.legacy ? 'monitoring' : 'monitors',
        inlineSettings: opts.legacy ? { watches: [] } : { items: [], inheritance: 'cumulative' },
      }).returning();
      if (opts.interval !== undefined) {
        await db.insert(configPolicyMonitoringSettings).values({
          featureLinkId: link!.id, checkIntervalSeconds: opts.interval,
        });
      }
      if (opts.assignment) {
        await db.insert(configPolicyAssignments).values({
          configPolicyId: row!.id, ...opts.assignment, priority: 0,
        });
      }
      return { policyId: row!.id, linkId: link!.id };
    });
  }

  it('shared attachment settings preserve an existing 30-second interval and its JSON mirror', async () => {
    const { partner, org, device } = await fixture();
    const target = await policy(org.id, { interval: 30, assignment: { level: 'device', targetId: device.id } });
    await withDbAccessContext(orgContext(org.id, partner.id), async () => {
      const [monitor] = await db.insert(monitorDefinitions).values({
        orgId: org.id, name: `attach-${randomUUID()}`, kind: 'service',
        condition: { serviceName: 'AttachKeepsThirty' }, severity: 'high',
      }).returning();
      createdMonitors.push(monitor!.id);
      const { linkId, items, inheritance } = await readMonitorsLink(target.policyId);
      const saved = await updateFeatureLink(linkId!, {
        inlineSettings: monitorsLinkSettings([...items, {
          monitorId: monitor!.id, enabled: true, overrides: null, sortOrder: items.length,
        }], inheritance),
      }, target.policyId);
      expect(saved!.inlineSettings).toMatchObject({ checkIntervalSeconds: 30 });
      const [settings] = await db.select().from(configPolicyMonitoringSettings)
        .where(eq(configPolicyMonitoringSettings.featureLinkId, linkId!));
      expect(settings!.checkIntervalSeconds).toBe(30);
      const [link] = await db.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, linkId!));
      expect(link!.inlineSettings).toMatchObject({ checkIntervalSeconds: 30 });
      const delivered = await buildMonitoringConfigUpdate(device.id);
      expect(delivered!.check_interval_seconds).toBe(30);
      expect(delivered!.watches).toEqual([expect.objectContaining({ name: 'AttachKeepsThirty' })]);
    });
  });

  it('an own attachment link without settings inherits 30 from its inactive, unassigned parent', async () => {
    const { partner, org, device } = await fixture();
    const parent = await policy(org.id, { interval: 30, status: 'inactive' });
    const child = await policy(org.id, {
      parentPolicyId: parent.policyId, assignment: { level: 'device', targetId: device.id },
    });
    await withDbAccessContext(orgContext(org.id, partner.id), async () => {
      expect(await db.select().from(configPolicyMonitoringSettings)
        .where(eq(configPolicyMonitoringSettings.featureLinkId, child.linkId))).toEqual([]);
      expect(await buildMonitoringConfigUpdate(device.id)).toEqual({ check_interval_seconds: 30, watches: [] });
    });
  });

  it('an interval-less device policy does not beat an explicit organization interval', async () => {
    const { partner, org, device } = await fixture();
    await policy(org.id, { interval: 30, assignment: { level: 'organization', targetId: org.id } });
    await policy(org.id, { assignment: { level: 'device', targetId: device.id } });
    const delivered = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      buildMonitoringConfigUpdate(device.id));
    expect(delivered).toEqual({ check_interval_seconds: 30, watches: [] });
  });

  it('delivers the migration-re-keyed interval under the agent context', async () => {
    const { partner, org, device } = await fixture();
    const target = await policy(org.id, {
      interval: 30, legacy: true, assignment: { level: 'device', targetId: device.id },
    });
    await replayMigration('2026-10-31-110000-legacy-alerting-retirement-sweep.sql');
    await withDbAccessContext(orgContext(org.id, partner.id), async () => {
      const rows = await db.select({ linkId: configPolicyFeatureLinks.id, interval: configPolicyMonitoringSettings.checkIntervalSeconds })
        .from(configPolicyFeatureLinks)
        .innerJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyFeatureLinks.id))
        .where(and(eq(configPolicyFeatureLinks.configPolicyId, target.policyId), eq(configPolicyFeatureLinks.featureType, 'monitors')));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.linkId).not.toBe(target.linkId);
      expect(rows[0]!.interval).toBe(30);
      expect(await buildMonitoringConfigUpdate(device.id)).toEqual({ check_interval_seconds: 30, watches: [] });
    });
  });
});
