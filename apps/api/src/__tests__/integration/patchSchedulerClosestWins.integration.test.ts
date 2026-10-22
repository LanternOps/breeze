/**
 * Overlapping patch policies: closest level wins in the scheduler and the ring
 * count, exactly as it does in effective-config resolution (#9632).
 *
 * A device reached by two active config policies that both carry a patch link
 * (an org-wide "Broad" policy and a device-group "Pilot" override) used to get
 * one scheduled patch job PER policy. Each job applied its own ring and its own
 * `rebootPolicy`, so the Broad policy's "If required" reboot could restart a
 * pilot machine outside the window the Pilot override set. The device's
 * Configuration tab (resolvePatchConfigPolicyForDevice) showed only Pilot.
 * The update-ring Devices count had the same gap: pilot devices were counted
 * under Broad's ring as well.
 *
 * The scheduler and the ring count now keep a device for a policy only when
 * no OTHER policy wins the device's patch hierarchy. This suite proves it
 * against real Postgres:
 *   - org "Broad" + device-group "Pilot": the group device gets exactly one
 *     job, from Pilot; Broad's job holds only the other device;
 *   - partner-wide policy at partner level + org policy: the org policy wins
 *     its org's devices, the partner policy keeps the sibling org's;
 *   - the ring Devices count / device list exclude devices another policy won;
 *   - the batched winner matches resolvePatchConfigPolicyForDevice per device.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyPatchSettings,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  patchJobs,
  patchPolicies,
} from '../../db/schema';
import { __testOnly } from '../../jobs/patchSchedulerWorker';
import { resolveRingDeviceCounts, resolveRingDeviceIds } from '../../routes/updateRingsHelpers';
import {
  resolvePatchConfigPolicyForDevice,
  resolvePatchPolicyWinnersForDevices,
} from '../../services/featureConfigResolver';
import { createOrganization, createPartner, createSite } from './db-utils';

const { scanAndCreateJobs } = __testOnly;

const runDb = it.runIf(!!process.env.DATABASE_URL);

// A fixed future instant whose UTC HH:MM matches every seeded daily schedule,
// so every policy in a test is due in the same tick. Only Date is faked.
const SCHEDULE_TIME = '04:41';
const NOW = new Date('2031-06-17T04:41:20.000Z');

type Role = 'workstation' | 'server';

/** One device per transaction (see updateRingPartnerDeviceCount's seedDevice note). */
async function seedDevice(orgId: string, siteId: string, deviceRole: Role = 'workstation'): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [d] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `${deviceRole}-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole,
        deviceRoleSource: 'manual',
      })
      .returning({ id: devices.id });
    if (!d) throw new Error('failed to seed device');
    return d.id;
  });
}

async function seedGroup(orgId: string, deviceIds: string[]): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [group] = await db
      .insert(deviceGroups)
      .values({ orgId, name: `pilot-${randomUUID().slice(0, 8)}`, type: 'static' })
      .returning({ id: deviceGroups.id });
    if (deviceIds.length > 0) {
      await db.insert(deviceGroupMemberships).values(deviceIds.map((deviceId) => ({ deviceId, groupId: group!.id, orgId })));
    }
    return group!.id;
  });
}

interface PolicySeed {
  partnerId: string;
  /** null => partner-wide (library) policy */
  orgId: string | null;
  rebootPolicy: 'never' | 'if_required' | 'always';
  /** An existing ring to link to; a fresh one is created otherwise. */
  ringId?: string;
  assignment: {
    level: 'partner' | 'organization' | 'site' | 'device_group' | 'device';
    targetId: string;
    priority?: number;
    roleFilter?: string[] | null;
  };
}

/** Active config policy + patch link to a ring + daily schedule + one assignment. */
async function seedScheduledPatchPolicy(seed: PolicySeed): Promise<{ policyId: string; ringId: string }> {
  return withSystemDbAccessContext(async () => {
    let ringId = seed.ringId;
    if (!ringId) {
      const [ring] = await db
        .insert(patchPolicies)
        .values({ partnerId: seed.partnerId, kind: 'ring', name: `ring-${randomUUID().slice(0, 8)}` })
        .returning({ id: patchPolicies.id });
      ringId = ring!.id;
    }
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: seed.orgId,
        partnerId: seed.orgId ? null : seed.partnerId,
        name: `Patch policy ${randomUUID().slice(0, 6)}`,
        status: 'active',
      })
      .returning({ id: configurationPolicies.id });
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'patch', featurePolicyId: ringId, inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyPatchSettings).values({
      featureLinkId: link!.id,
      sources: ['os'],
      scheduleFrequency: 'daily',
      scheduleTime: SCHEDULE_TIME,
      rebootPolicy: seed.rebootPolicy,
    });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: seed.assignment.level,
      targetId: seed.assignment.targetId,
      priority: seed.assignment.priority ?? 0,
      roleFilter: seed.assignment.roleFilter ?? null,
    });
    return { policyId: policy!.id, ringId };
  });
}

async function jobsForPolicy(policyId: string) {
  return withSystemDbAccessContext(() =>
    db
      .select({ orgId: patchJobs.orgId, ringId: patchJobs.ringId, targets: patchJobs.targets })
      .from(patchJobs)
      .where(eq(patchJobs.configPolicyId, policyId))
  );
}

function targetIds(job: { targets: unknown }): string[] {
  return [...((job.targets as { deviceIds?: string[] }).deviceIds ?? [])].sort();
}

function rebootPolicyOf(job: { targets: unknown }): unknown {
  return (job.targets as { deployment?: { rebootPolicy?: unknown } }).deployment?.rebootPolicy;
}

function partnerCtx(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

describe('scheduler: overlapping patch policies — closest level wins (#9632)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  runDb('org "Broad" (if_required) + device-group "Pilot" (never): the pilot device gets ONE job, from Pilot', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const pilotDevice = await seedDevice(org.id, site.id);
    const otherDevice = await seedDevice(org.id, site.id);
    const groupId = await seedGroup(org.id, [pilotDevice]);

    const broad = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'if_required',
      assignment: { level: 'organization', targetId: org.id },
    });
    const pilot = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'never',
      assignment: { level: 'device_group', targetId: groupId },
    });

    await scanAndCreateJobs();

    const broadJobs = await jobsForPolicy(broad.policyId);
    expect(broadJobs).toHaveLength(1);
    expect(targetIds(broadJobs[0]!)).toEqual([otherDevice]);
    expect(broadJobs[0]!.ringId).toBe(broad.ringId);

    const pilotJobs = await jobsForPolicy(pilot.policyId);
    expect(pilotJobs).toHaveLength(1);
    expect(targetIds(pilotJobs[0]!)).toEqual([pilotDevice]);
    expect(pilotJobs[0]!.ringId).toBe(pilot.ringId);
    expect(rebootPolicyOf(pilotJobs[0]!)).toBe('never');

    // The effective-config resolver agrees on the winner for both devices.
    const [pilotWinner, otherWinner] = await withSystemDbAccessContext(() =>
      Promise.all([resolvePatchConfigPolicyForDevice(pilotDevice), resolvePatchConfigPolicyForDevice(otherDevice)])
    );
    expect(pilotWinner?.configPolicyId).toBe(pilot.policyId);
    expect(otherWinner?.configPolicyId).toBe(broad.policyId);
  });

  runDb('partner-wide policy at PARTNER level + org policy: the org policy wins its org, the partner policy keeps the sibling org', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const deviceA = await seedDevice(orgA.id, siteA.id);
    const deviceB = await seedDevice(orgB.id, siteB.id);

    const partnerWide = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: null,
      rebootPolicy: 'always',
      assignment: { level: 'partner', targetId: partner.id },
    });
    const orgPolicy = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: orgA.id,
      rebootPolicy: 'never',
      assignment: { level: 'organization', targetId: orgA.id },
    });

    await scanAndCreateJobs();

    const partnerJobs = await jobsForPolicy(partnerWide.policyId);
    expect(partnerJobs.map((j) => j.orgId)).toEqual([orgB.id]);
    expect(targetIds(partnerJobs[0]!)).toEqual([deviceB]);
    expect(partnerJobs.flatMap(targetIds)).not.toContain(deviceA);

    const orgJobs = await jobsForPolicy(orgPolicy.policyId);
    expect(orgJobs).toHaveLength(1);
    expect(targetIds(orgJobs[0]!)).toEqual([deviceA]);
    expect(rebootPolicyOf(orgJobs[0]!)).toBe('never');
  });

  runDb('same level: the lower assignment priority wins; the losing policy schedules nothing for the device', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id);

    const loser = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'always',
      assignment: { level: 'site', targetId: site.id, priority: 50 },
    });
    const winner = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'never',
      assignment: { level: 'site', targetId: site.id, priority: 10 },
    });

    await scanAndCreateJobs();

    expect(await jobsForPolicy(loser.policyId)).toEqual([]);
    const jobs = await jobsForPolicy(winner.policyId);
    expect(jobs).toHaveLength(1);
    expect(targetIds(jobs[0]!)).toEqual([device]);
  });

  runDb('a closer policy that does not match the device (role filter) leaves it with the broader policy', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const workstation = await seedDevice(org.id, site.id, 'workstation');
    const server = await seedDevice(org.id, site.id, 'server');

    const broad = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'if_required',
      assignment: { level: 'organization', targetId: org.id },
    });
    const serversOnly = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'never',
      assignment: { level: 'site', targetId: site.id, roleFilter: ['server'] },
    });

    await scanAndCreateJobs();

    const broadJobs = await jobsForPolicy(broad.policyId);
    expect(broadJobs).toHaveLength(1);
    expect(targetIds(broadJobs[0]!)).toEqual([workstation]);
    const serverJobs = await jobsForPolicy(serversOnly.policyId);
    expect(serverJobs).toHaveLength(1);
    expect(targetIds(serverJobs[0]!)).toEqual([server]);
  });
});

describe('update ring Devices count: devices another policy won are not counted (#9632)', () => {
  runDb('Broad ring excludes the pilot device; Pilot ring counts it once', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const pilotDevice = await seedDevice(org.id, site.id);
    const otherDevice = await seedDevice(org.id, site.id);
    const groupId = await seedGroup(org.id, [pilotDevice]);

    const broad = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'if_required',
      assignment: { level: 'organization', targetId: org.id },
    });
    const pilot = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'never',
      assignment: { level: 'device_group', targetId: groupId },
    });

    const counts = await withSystemDbAccessContext(() => resolveRingDeviceCounts([broad.ringId, pilot.ringId]));
    expect(counts.get(broad.ringId)).toBe(1);
    expect(counts.get(pilot.ringId)).toBe(1);
    expect(await withSystemDbAccessContext(() => resolveRingDeviceIds(broad.ringId))).toEqual([otherDevice]);
    expect(await withSystemDbAccessContext(() => resolveRingDeviceIds(pilot.ringId))).toEqual([pilotDevice]);

    // Same answer under the partner-scope RLS context the ring routes run in.
    const scoped = await withDbAccessContext(partnerCtx(partner.id, [org.id]), () =>
      resolveRingDeviceCounts([broad.ringId, pilot.ringId])
    );
    expect(scoped.get(broad.ringId)).toBe(1);
    expect(scoped.get(pilot.ringId)).toBe(1);
  });

  runDb('two policies on the SAME ring: a device won by either still counts under that ring once', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const pilotDevice = await seedDevice(org.id, site.id);
    const otherDevice = await seedDevice(org.id, site.id);
    const groupId = await seedGroup(org.id, [pilotDevice]);

    const broad = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'if_required',
      assignment: { level: 'organization', targetId: org.id },
    });
    await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      rebootPolicy: 'never',
      ringId: broad.ringId,
      assignment: { level: 'device_group', targetId: groupId },
    });

    const ids = await withSystemDbAccessContext(() => resolveRingDeviceIds(broad.ringId));
    expect([...ids].sort()).toEqual([pilotDevice, otherDevice].sort());
  });
});

describe('resolvePatchPolicyWinnersForDevices matches the per-device resolver (#9632)', () => {
  runDb('device, group, site, org, partner levels, priorities and a role filter', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA1 = await createSite({ orgId: orgA.id });
    const siteA2 = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });

    const d1 = await seedDevice(orgA.id, siteA1.id, 'workstation'); // device-level
    const d2 = await seedDevice(orgA.id, siteA1.id, 'workstation'); // group
    const d3 = await seedDevice(orgA.id, siteA1.id, 'server'); // site (server filter)
    const d4 = await seedDevice(orgA.id, siteA1.id, 'workstation'); // site filter misses → org
    const d5 = await seedDevice(orgA.id, siteA2.id, 'workstation'); // org
    const d6 = await seedDevice(orgB.id, siteB.id, 'workstation'); // partner
    const groupId = await seedGroup(orgA.id, [d1, d2]);

    await seedScheduledPatchPolicy({ partnerId: partner.id, orgId: null, rebootPolicy: 'always', assignment: { level: 'partner', targetId: partner.id } });
    await seedScheduledPatchPolicy({ partnerId: partner.id, orgId: orgA.id, rebootPolicy: 'if_required', assignment: { level: 'organization', targetId: orgA.id, priority: 20 } });
    await seedScheduledPatchPolicy({ partnerId: partner.id, orgId: orgA.id, rebootPolicy: 'if_required', assignment: { level: 'organization', targetId: orgA.id, priority: 5 } });
    await seedScheduledPatchPolicy({ partnerId: partner.id, orgId: orgA.id, rebootPolicy: 'never', assignment: { level: 'site', targetId: siteA1.id, roleFilter: ['server'] } });
    await seedScheduledPatchPolicy({ partnerId: partner.id, orgId: orgA.id, rebootPolicy: 'never', assignment: { level: 'device_group', targetId: groupId } });
    await seedScheduledPatchPolicy({ partnerId: partner.id, orgId: orgA.id, rebootPolicy: 'never', assignment: { level: 'device', targetId: d1 } });

    const all = [d1, d2, d3, d4, d5, d6];
    const batched = await withSystemDbAccessContext(() => resolvePatchPolicyWinnersForDevices(all));
    const perDevice = await withSystemDbAccessContext(() => Promise.all(all.map((id) => resolvePatchConfigPolicyForDevice(id))));

    for (const [i, id] of all.entries()) {
      const expected = perDevice[i];
      expect(expected, `per-device winner for d${i + 1}`).not.toBeNull();
      expect(batched.get(id)?.configPolicyId, `d${i + 1}`).toBe(expected!.configPolicyId);
      expect(batched.get(id)?.featurePolicyId, `d${i + 1}`).toBe(expected!.featurePolicyId);
    }
    // Spot-check the levels so a resolver that is wrong the same way in both
    // paths still fails.
    const levelOf = (id: string) => batched.get(id)?.assignmentLevel;
    expect([levelOf(d1), levelOf(d2), levelOf(d3), levelOf(d4), levelOf(d5), levelOf(d6)]).toEqual([
      'device', 'device_group', 'site', 'organization', 'organization', 'partner',
    ]);

    const unknownDevice = randomUUID();
    const withUnknown = await withSystemDbAccessContext(() => resolvePatchPolicyWinnersForDevices([unknownDevice]));
    expect(withUnknown.get(unknownDevice)).toBeNull();
  });
});
