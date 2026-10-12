/**
 * Scheduled patch jobs honour the assignment's role / OS filter (#8442).
 *
 * A config-policy assignment can carry `role_filter` / `os_filter`. The
 * per-device effective-policy resolver has always applied them
 * (`buildRoleOsFilterConditions`), but the patch scheduler expanded each
 * assignment to EVERY device under its target, so a "Default Workstation
 * Policy" assigned at org level with `role_filter = {workstation}` scheduled
 * patch jobs — and installed patches — on that org's servers. The update-ring
 * device count and compliance scope had the same gap ("Pilot ring: 2 devices").
 *
 * Both now expand assignments through one shared, filter-aware resolver
 * (services/configPolicyAssignmentDevices.ts). This suite proves it against
 * real Postgres:
 *   - scanAndCreateJobs: a Workstation-filtered SITE assignment on a site with a
 *     server and a workstation creates a job targeting only the workstation;
 *   - scanAndCreateJobs: a partner-wide policy's Workstation-filtered PARTNER
 *     assignment fans out one job per device org, each holding only that org's
 *     workstation;
 *   - an OS filter excludes a device of another OS;
 *   - the update-ring count / device list apply the same filter.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
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
import { createOrganization, createPartner, createSite } from './db-utils';

const { scanAndCreateJobs } = __testOnly;

const runDb = it.runIf(!!process.env.DATABASE_URL);

// A fixed future instant whose UTC HH:MM matches the seeded daily schedule, so
// scanAndCreateJobs sees the occurrence as due. Only Date is faked: pg sockets
// and timers keep running on real time.
const SCHEDULE_TIME = '03:17';
const NOW = new Date('2031-05-14T03:17:20.000Z');

type Role = 'workstation' | 'server';
type Os = 'windows' | 'linux' | 'macos';

/** One device per transaction — see updateRingPartnerDeviceCount's seedDevice note. */
async function seedDevice(
  orgId: string,
  siteId: string,
  deviceRole: Role,
  osType: Os = 'windows',
  opts: { parked?: boolean } = {},
): Promise<string> {
  return withSystemDbAccessContext(async () => {
    // A device lands in a holding (unassigned_pool) org only through enrollment admission.
    if (opts.parked) await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    const [d] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `${deviceRole}-${randomUUID().slice(0, 8)}`,
        osType,
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

interface PolicySeed {
  partnerId: string;
  /** null => partner-wide (library) policy */
  orgId: string | null;
  assignment: {
    level: 'partner' | 'organization' | 'site' | 'device_group' | 'device';
    targetId: string;
    roleFilter?: string[] | null;
    osFilter?: string[] | null;
  };
}

/** Active config policy + patch link to a fresh ring + daily schedule + one assignment. */
async function seedScheduledPatchPolicy(seed: PolicySeed): Promise<{ policyId: string; ringId: string }> {
  return withSystemDbAccessContext(async () => {
    const [ring] = await db
      .insert(patchPolicies)
      .values({ partnerId: seed.partnerId, kind: 'ring', name: `ring-${randomUUID().slice(0, 8)}` })
      .returning({ id: patchPolicies.id });
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: seed.orgId,
        partnerId: seed.orgId ? null : seed.partnerId,
        name: `Default Workstation Policy ${randomUUID().slice(0, 6)}`,
        status: 'active',
      })
      .returning({ id: configurationPolicies.id });
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'patch', featurePolicyId: ring!.id, inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyPatchSettings).values({
      featureLinkId: link!.id,
      sources: ['os'],
      scheduleFrequency: 'daily',
      scheduleTime: SCHEDULE_TIME,
    });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: seed.assignment.level,
      targetId: seed.assignment.targetId,
      priority: 0,
      roleFilter: seed.assignment.roleFilter ?? null,
      osFilter: seed.assignment.osFilter ?? null,
    });
    return { policyId: policy!.id, ringId: ring!.id };
  });
}

async function jobsForPolicy(policyId: string) {
  return withSystemDbAccessContext(() =>
    db
      .select({ orgId: patchJobs.orgId, targets: patchJobs.targets, devicesTotal: patchJobs.devicesTotal })
      .from(patchJobs)
      .where(and(eq(patchJobs.configPolicyId, policyId)))
  );
}

function targetIds(job: { targets: unknown }): string[] {
  return [...((job.targets as { deviceIds?: string[] }).deviceIds ?? [])].sort();
}

describe('scheduled patch jobs honour the assignment role/OS filter (#8442)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  runDb('a Workstation-filtered SITE assignment targets only the workstation, never the server on the same site', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const workstation = await seedDevice(org.id, site.id, 'workstation');
    const server = await seedDevice(org.id, site.id, 'server');

    const { policyId } = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      assignment: { level: 'site', targetId: site.id, roleFilter: ['workstation'] },
    });

    await scanAndCreateJobs();

    const jobs = await jobsForPolicy(policyId);
    expect(jobs).toHaveLength(1);
    expect(targetIds(jobs[0]!)).toEqual([workstation]);
    expect(targetIds(jobs[0]!)).not.toContain(server);
    expect(jobs[0]!.devicesTotal).toBe(1);
  });

  runDb('a partner-wide policy with a Workstation-filtered PARTNER assignment fans out one job per device org, workstations only', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const wsA = await seedDevice(orgA.id, siteA.id, 'workstation');
    await seedDevice(orgA.id, siteA.id, 'server');
    const wsB = await seedDevice(orgB.id, siteB.id, 'workstation');
    await seedDevice(orgB.id, siteB.id, 'server');

    const { policyId } = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: null,
      assignment: { level: 'partner', targetId: partner.id, roleFilter: ['workstation'] },
    });

    await scanAndCreateJobs();

    const jobs = await jobsForPolicy(policyId);
    const byOrg = new Map(jobs.map((j) => [j.orgId, targetIds(j)]));
    expect(jobs).toHaveLength(2);
    expect(byOrg.get(orgA.id)).toEqual([wsA]);
    expect(byOrg.get(orgB.id)).toEqual([wsB]);
  });

  runDb('an OS filter excludes a device of another OS; an unfiltered assignment still targets every role', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const linuxServer = await seedDevice(org.id, site.id, 'server', 'linux');
    const winServer = await seedDevice(org.id, site.id, 'server', 'windows');
    const winWorkstation = await seedDevice(org.id, site.id, 'workstation', 'windows');

    const filtered = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      assignment: { level: 'organization', targetId: org.id, osFilter: ['linux'] },
    });
    const unfiltered = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      assignment: { level: 'organization', targetId: org.id },
    });

    await scanAndCreateJobs();

    const filteredJobs = await jobsForPolicy(filtered.policyId);
    expect(filteredJobs).toHaveLength(1);
    expect(targetIds(filteredJobs[0]!)).toEqual([linuxServer]);

    const unfilteredJobs = await jobsForPolicy(unfiltered.policyId);
    expect(unfilteredJobs).toHaveLength(1);
    expect(targetIds(unfilteredJobs[0]!)).toEqual([linuxServer, winServer, winWorkstation].sort());
  });
});

describe('role filter combined with other assignments / levels (#8442)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  runDb('a filtered org assignment plus an unfiltered site assignment: the union keeps the site server, each device once', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: org.id });
    const siteB = await createSite({ orgId: org.id });
    const wsA = await seedDevice(org.id, siteA.id, 'workstation');
    const serverA = await seedDevice(org.id, siteA.id, 'server');
    const wsB = await seedDevice(org.id, siteB.id, 'workstation');
    await seedDevice(org.id, siteB.id, 'server'); // only reachable through the filtered org assignment

    const { policyId, ringId } = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      assignment: { level: 'organization', targetId: org.id, roleFilter: ['workstation'] },
    });
    await withSystemDbAccessContext(() =>
      db.insert(configPolicyAssignments).values({ configPolicyId: policyId, level: 'site', targetId: siteA.id, priority: 1 })
    );

    const expected = [wsA, serverA, wsB].sort();

    await scanAndCreateJobs();
    const jobs = await jobsForPolicy(policyId);
    expect(jobs).toHaveLength(1);
    expect(targetIds(jobs[0]!)).toEqual(expected);

    const counts = await withSystemDbAccessContext(() => resolveRingDeviceCounts([ringId]));
    expect(counts.get(ringId)).toBe(3);
  });

  runDb('a Workstation-filtered DEVICE_GROUP assignment targets only the group\'s workstation', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const ws = await seedDevice(org.id, site.id, 'workstation');
    const server = await seedDevice(org.id, site.id, 'server');

    const groupId = await withSystemDbAccessContext(async () => {
      const [group] = await db
        .insert(deviceGroups)
        .values({ orgId: org.id, name: `grp-${randomUUID().slice(0, 8)}`, type: 'static' })
        .returning({ id: deviceGroups.id });
      await db.insert(deviceGroupMemberships).values([
        { deviceId: ws, groupId: group!.id, orgId: org.id },
        { deviceId: server, groupId: group!.id, orgId: org.id },
      ]);
      return group!.id;
    });

    const { policyId, ringId } = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      assignment: { level: 'device_group', targetId: groupId, roleFilter: ['workstation'] },
    });

    await scanAndCreateJobs();
    const jobs = await jobsForPolicy(policyId);
    expect(jobs).toHaveLength(1);
    expect(targetIds(jobs[0]!)).toEqual([ws]);

    const ids = await withSystemDbAccessContext(() => resolveRingDeviceIds(ringId));
    expect(ids).toEqual([ws]);
  });
});

describe('update-ring device count / list honour the assignment role filter (#8442)', () => {
  runDb('a Workstation-filtered org assignment counts only the workstation ("Pilot ring: 2 devices")', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const workstation = await seedDevice(org.id, site.id, 'workstation');
    await seedDevice(org.id, site.id, 'server');

    const { ringId } = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: org.id,
      assignment: { level: 'organization', targetId: org.id, roleFilter: ['workstation'] },
    });

    const counts = await withSystemDbAccessContext(() => resolveRingDeviceCounts([ringId]));
    expect(counts.get(ringId)).toBe(1);
    const ids = await withSystemDbAccessContext(() => resolveRingDeviceIds(ringId));
    expect(ids).toEqual([workstation]);
  });

  runDb('a Workstation-filtered partner assignment on a partner-wide policy counts workstations across every org', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const wsA = await seedDevice(orgA.id, siteA.id, 'workstation');
    await seedDevice(orgA.id, siteA.id, 'server');
    const wsB = await seedDevice(orgB.id, siteB.id, 'workstation');
    await seedDevice(orgB.id, siteB.id, 'server');

    const { ringId } = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: null,
      assignment: { level: 'partner', targetId: partner.id, roleFilter: ['workstation'] },
    });

    const counts = await withSystemDbAccessContext(() => resolveRingDeviceCounts([ringId]));
    expect(counts.get(ringId)).toBe(2);
    const ids = await withSystemDbAccessContext(() => resolveRingDeviceIds(ringId));
    expect([...ids].sort()).toEqual([wsA, wsB].sort());
  });
});

/**
 * The shared resolver keeps the parked-device exclusion both callers had on
 * main (parkedFanout.contract.test.ts pins the guard sites). A device parked
 * in its partner's holding org (`type = 'unassigned_pool'`) is not managed:
 * a partner-wide fan-out must not schedule or count it, and the update-ring
 * clamp leaves it out of every subset level. devices_site_org_fk means a
 * parked device can only sit in a site of the holding org itself, so the
 * subset case targets that site.
 */
describe('parked devices stay out of patch targeting (#8442)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  runDb('a partner-level assignment neither schedules nor counts a device parked in the holding org', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const holding = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
    const site = await createSite({ orgId: org.id });
    const holdingSite = await createSite({ orgId: holding.id });
    const managed = await seedDevice(org.id, site.id, 'workstation');
    const parked = await seedDevice(holding.id, holdingSite.id, 'workstation', 'windows', { parked: true });

    const { policyId, ringId } = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: null,
      assignment: { level: 'partner', targetId: partner.id },
    });

    await scanAndCreateJobs();
    const jobs = await jobsForPolicy(policyId);
    expect(jobs.map((j) => j.orgId)).toEqual([org.id]);
    expect(targetIds(jobs[0]!)).toEqual([managed]);
    expect(jobs.flatMap(targetIds)).not.toContain(parked);

    const ids = await withSystemDbAccessContext(() => resolveRingDeviceIds(ringId));
    expect(ids).toEqual([managed]);
    const counts = await withSystemDbAccessContext(() => resolveRingDeviceCounts([ringId]));
    expect(counts.get(ringId)).toBe(1);
  });

  runDb('the update-ring partner clamp leaves a parked device out of a site-level assignment on the holding site', async () => {
    const partner = await createPartner();
    const holding = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
    const holdingSite = await createSite({ orgId: holding.id });
    const parked = await seedDevice(holding.id, holdingSite.id, 'workstation', 'windows', { parked: true });

    const { ringId } = await seedScheduledPatchPolicy({
      partnerId: partner.id,
      orgId: null,
      assignment: { level: 'site', targetId: holdingSite.id },
    });

    const ids = await withSystemDbAccessContext(() => resolveRingDeviceIds(ringId));
    expect(ids).not.toContain(parked);
    expect(ids).toEqual([]);
    const counts = await withSystemDbAccessContext(() => resolveRingDeviceCounts([ringId]));
    expect(counts.get(ringId) ?? 0).toBe(0);
  });
});
