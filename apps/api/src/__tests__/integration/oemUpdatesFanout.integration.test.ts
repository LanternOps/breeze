/**
 * Scheduled vendor updates against real Postgres and RLS (#11065 W07): a
 * partner-wide link fans out by the device org's partner, status rows take the
 * device's org, and the selection query's exclusions hold on real rows. Parked
 * devices are refused by the resolver and the seam too, so the parked cases here
 * prove the outcome, not this query's own predicate (the unit test pins that).
 *
 * Gates are closed in code until the lab wave, so the lab override opens them for
 * the seeded devices. The arming gate is a write-path rule, so the settings go in
 * directly, as the resolver integration test's do.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  deviceHardware,
  deviceOemUpdateStatus,
  devices,
} from '../../db/schema';
import { runOemUpdatesTick } from '../../jobs/oemUpdatesWorker';
import { commandResultHandlers } from '../../services/commandResultHandlers';
import { selectDueDevices } from '../../services/oemUpdates/candidates';
import {
  cancelPendingOemUpdateRelease,
  dispatchOemUpdateRun,
  oemReleaseCommandFilter,
} from '../../services/oemUpdates/dispatch';
import { resetOemRebootSightingsForTests, runOemRebootSweep } from '../../services/oemUpdates/rebootSweep';
import { runOemReleaseSweep } from '../../services/oemUpdates/releaseSweep';
import { applyOemUpdateRelease, applyOemUpdateResult } from '../../services/oemUpdates/results';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const WEEKS = ['first', 'second', 'third', 'fourth', 'last'] as const;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * A UTC schedule whose window opened two hours ago, so the real clock is inside
 * it and past every device's offset: the seam reads Date.now(), and a real clock
 * keeps the test honest about it. Day 29 and later is always the last week.
 */
function scheduleOpenNow(now = new Date()) {
  const opened = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  return {
    weekOfMonth: WEEKS[Math.floor((opened.getUTCDate() - 1) / 7)]!,
    dayOfWeek: DAYS[opened.getUTCDay()]!,
    windowStart: `${String(opened.getUTCHours()).padStart(2, '0')}:${String(opened.getUTCMinutes()).padStart(2, '0')}`,
    windowHours: 8,
  };
}

function armedSettings(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    enabled: true,
    schedule: scheduleOpenNow(),
    catchUpNights: 0,
    reboot: 'overnight',
    vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: ['SKIP-ME'] } },
    ...over,
  };
}

const labDevices: string[] = [];

async function seedDevice(orgId: string, siteId: string, over: Partial<typeof devices.$inferInsert> = {}) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `oem-fanout-${randomUUID()}`,
    hostname: `fanout-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '0.127.0',
    status: 'online',
    ...over,
  }).returning({ id: devices.id });
  await getTestDb().insert(deviceHardware).values({
    deviceId: device!.id,
    orgId,
    manufacturer: 'Dell Inc.',
    model: 'Latitude 7420',
    biosVersion: '1.20.0',
  });
  labDevices.push(device!.id);
  vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', labDevices.join(','));
  return device!.id;
}

/** A device lands in a holding org only through enrollment admission. */
async function seedParkedDevice(orgId: string, siteId: string) {
  const id = await withSystemDbAccessContext(async () => {
    await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    const [device] = await db.insert(devices).values({
      orgId,
      siteId,
      agentId: `oem-parked-${randomUUID()}`,
      hostname: `parked-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '0.127.0',
      status: 'online',
    }).returning({ id: devices.id });
    await db.insert(deviceHardware).values({ deviceId: device!.id, orgId, manufacturer: 'Dell Inc.', model: 'Latitude 7420' });
    return device!.id;
  });
  labDevices.push(id);
  vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', labDevices.join(','));
  return id;
}

async function seedPartnerWidePolicy(partnerId: string, settings = armedSettings()) {
  const [policy] = await getTestDb().insert(configurationPolicies).values({
    orgId: null,
    partnerId,
    name: `vendor updates ${randomUUID()}`,
    status: 'active',
  }).returning({ id: configurationPolicies.id });
  await getTestDb().insert(configPolicyFeatureLinks).values({
    configPolicyId: policy!.id,
    featureType: 'oem_updates',
    inlineSettings: settings,
  });
  await getTestDb().insert(configPolicyAssignments).values({
    configPolicyId: policy!.id,
    level: 'partner',
    targetId: partnerId,
  });
  return policy!.id;
}

async function dueIds(): Promise<string[]> {
  return (await selectDueDevices(new Date(), { limit: 200 })).map((due) => due.deviceId);
}

async function fanoutFixture() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  await seedPartnerWidePolicy(partner.id);
  return { partner, orgA, orgB, siteA, siteB };
}

beforeEach(() => {
  labDevices.length = 0;
  resetOemRebootSightingsForTests();
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('oemUpdates fan-out against real Postgres', () => {
  runDb('a partner-wide link reaches both of its orgs and no other partner', async () => {
    const { orgA, orgB, siteA, siteB } = await fanoutFixture();
    const inA = await seedDevice(orgA.id, siteA.id);
    const inB = await seedDevice(orgB.id, siteB.id);

    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const foreign = await seedDevice(otherOrg.id, otherSite.id);

    const due = await dueIds();
    expect(due).toEqual(expect.arrayContaining([inA, inB]));
    expect(due).not.toContain(foreign);
  });

  runDb('the tick queues the run with the policy side, and the status row takes the device org', async () => {
    const { orgA, orgB, siteA, siteB } = await fanoutFixture();
    const inA = await seedDevice(orgA.id, siteA.id);
    const inB = await seedDevice(orgB.id, siteB.id);

    await runOemUpdatesTick();

    const rows = await withSystemDbAccessContext(() => db
      .select({ deviceId: deviceOemUpdateStatus.deviceId, orgId: deviceOemUpdateStatus.orgId, key: deviceOemUpdateStatus.occurrenceKey, attempts: deviceOemUpdateStatus.attempts })
      .from(deviceOemUpdateStatus));
    const a = rows.find((row) => row.deviceId === inA);
    const b = rows.find((row) => row.deviceId === inB);
    expect(a?.orgId).toBe(orgA.id);
    expect(b?.orgId).toBe(orgB.id);
    const opened = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const key = `${opened.getUTCFullYear()}-${String(opened.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(a?.key).toBe(key);
    expect(a?.attempts).toBe(0);

    const [command] = await withSystemDbAccessContext(() => db
      .select({ payload: deviceCommands.payload, submittedOrgId: deviceCommands.submittedOrgId, deliverBy: deviceCommands.deliverBy })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, inA)));
    const payload = command!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      trigger: 'scheduled',
      occurrenceKey: key,
      categories: ['driver'],
      blockedUpdateIds: ['SKIP-ME'],
      rebootControlled: true,
    });
    expect(command!.submittedOrgId).toBe(orgA.id);
    // Derived from the remaining time, so a few milliseconds either side of it.
    expect(Math.abs(command!.deliverBy!.getTime() - new Date(payload.notAfter as string).getTime())).toBeLessThan(5000);
  });

  runDb('a second tick in the same window queues nothing more', async () => {
    const { orgA, siteA } = await fanoutFixture();
    const device = await seedDevice(orgA.id, siteA.id);

    await runOemUpdatesTick();
    await runOemUpdatesTick();

    const commands = await withSystemDbAccessContext(() => db
      .select({ id: deviceCommands.id })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, device)));
    expect(commands).toHaveLength(1);
  });

  runDb('an org-owned policy reaches its own org only', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const sibling = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const siblingSite = await createSite({ orgId: sibling.id });
    const [policy] = await getTestDb().insert(configurationPolicies).values({
      orgId: org.id,
      partnerId: null,
      name: `vendor updates ${randomUUID()}`,
      status: 'active',
    }).returning({ id: configurationPolicies.id });
    await getTestDb().insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'oem_updates', inlineSettings: armedSettings() });
    await getTestDb().insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'organization', targetId: org.id });
    const inOrg = await seedDevice(org.id, site.id);
    const inSibling = await seedDevice(sibling.id, siblingSite.id);

    const due = await dueIds();
    expect(due).toContain(inOrg);
    expect(due).not.toContain(inSibling);
  });

  runDb('leaves out offline, ephemeral, virtual and server devices', async () => {
    const { orgA, siteA } = await fanoutFixture();
    const control = await seedDevice(orgA.id, siteA.id);
    const offline = await seedDevice(orgA.id, siteA.id, { status: 'offline' });
    const ephemeral = await seedDevice(orgA.id, siteA.id, { isEphemeral: true });
    const virtual = await seedDevice(orgA.id, siteA.id, { isVirtual: true });
    const server = await seedDevice(orgA.id, siteA.id, { deviceRole: 'server' });

    const due = await dueIds();
    expect(due).toContain(control);
    for (const excluded of [offline, ephemeral, virtual, server]) expect(due).not.toContain(excluded);
  });

  runDb('leaves out a device parked in its partner holding org', async () => {
    const partner = await createPartner();
    const holding = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
    const site = await createSite({ orgId: holding.id });
    await seedPartnerWidePolicy(partner.id);
    const parked = await seedParkedDevice(holding.id, site.id);

    await expect(dueIds()).resolves.not.toContain(parked);
  });

  runDb('a closed lane is left out, with no lab override for the device', async () => {
    const { orgA, siteA } = await fanoutFixture();
    const device = await seedDevice(orgA.id, siteA.id);
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', '');

    await expect(dueIds()).resolves.not.toContain(device);
    await runOemUpdatesTick();
    const commands = await withSystemDbAccessContext(() => db
      .select({ id: deviceCommands.id })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, device)));
    expect(commands).toEqual([]);
  });

  runDb('a device that moved between selection and the send gets nothing from the old org', async () => {
    const { orgA, orgB, siteA, siteB } = await fanoutFixture();
    const device = await seedDevice(orgA.id, siteA.id);

    const [selected] = (await selectDueDevices(new Date(), { limit: 200 })).filter((due) => due.deviceId === device);
    expect(selected?.orgId).toBe(orgA.id);

    await getTestDb().update(devices).set({ orgId: orgB.id, siteId: siteB.id }).where(eq(devices.id, device));

    const outcome = await dispatchOemUpdateRun({
      deviceId: device,
      expectedOrgId: selected!.orgId,
      trigger: 'scheduled',
      requestedCategories: selected!.requestedCategories,
      blockedUpdateIds: selected!.blockedUpdateIds,
      rebootControlled: selected!.rebootControlled,
      notAfter: selected!.notAfter,
      occurrenceKey: selected!.occurrenceKey,
      actorUserId: null,
    });
    expect(outcome).toEqual({ ok: false, refusal: 'device_not_found' });
  });
});

describe('oemUpdates attempts against real Postgres', () => {
  const statusOf = async (deviceId: string) => {
    const [row] = await withSystemDbAccessContext(() => db
      .select()
      .from(deviceOemUpdateStatus)
      .where(eq(deviceOemUpdateStatus.deviceId, deviceId)));
    return row!;
  };

  const runAndReport = async (deviceId: string, orgId: string, occurrenceKey: string, outcome: string, errorCode: string | null = null) => {
    // Night after night: the seam refuses a second run while the first is unfinished.
    await getTestDb().update(deviceCommands).set({ status: 'completed' }).where(eq(deviceCommands.deviceId, deviceId));
    const dispatched = await dispatchOemUpdateRun({
      deviceId,
      expectedOrgId: orgId,
      trigger: 'scheduled',
      requestedCategories: ['driver'],
      blockedUpdateIds: [],
      rebootControlled: true,
      notAfter: new Date(Date.now() + 60 * 60 * 1000),
      occurrenceKey,
      actorUserId: null,
    });
    if (!dispatched.ok) throw new Error(`dispatch refused: ${dispatched.refusal}`);
    await applyOemUpdateResult({
      commandId: dispatched.commandId,
      deviceId,
      result: {
        lane: 'dell',
        outcome,
        toolVersion: '5.7.2',
        rawExitCode: 0,
        errorCode,
        rebootRequired: false,
        shutdownRequired: false,
        items: [],
        skippedCategories: [],
        takeover: 'ok',
      },
    });
    return dispatched.commandId;
  };

  runDb('counts what consumes one, and a new occurrence starts again', async () => {
    const { orgA, siteA } = await fanoutFixture();
    const device = await seedDevice(orgA.id, siteA.id);

    await runAndReport(device, orgA.id, '2027-01', 'blocked_on_battery');
    expect((await statusOf(device)).attempts).toBe(0);
    await runAndReport(device, orgA.id, '2027-01', 'retry_later', 'not_after_passed');
    expect((await statusOf(device)).attempts).toBe(0);
    await runAndReport(device, orgA.id, '2027-01', 'failed');
    expect((await statusOf(device)).attempts).toBe(1);
    await runAndReport(device, orgA.id, '2027-01', 'interrupted');
    const second = await runAndReport(device, orgA.id, '2027-01', 'failed');
    expect((await statusOf(device)).attempts).toBe(3);

    // The same result delivered again spends nothing.
    await applyOemUpdateResult({
      commandId: second,
      deviceId: device,
      result: {
        lane: 'dell', outcome: 'failed', toolVersion: '5.7.2', rawExitCode: 0, errorCode: null,
        rebootRequired: false, shutdownRequired: false, items: [], skippedCategories: [], takeover: 'ok',
      },
    });
    expect((await statusOf(device)).attempts).toBe(3);

    await runAndReport(device, orgA.id, '2027-02', 'blocked_on_battery');
    expect((await statusOf(device))).toMatchObject({ attempts: 0, occurrenceKey: '2027-02' });
  });
});

describe('oemUpdates reboot sweep against real Postgres', () => {
  runDb('a reboot owed in the window queues one held schedule_reboot, once a night', async () => {
    const { orgA, siteA } = await fanoutFixture();
    const device = await seedDevice(orgA.id, siteA.id);
    await getTestDb().update(devices)
      .set({ lastSeenAt: new Date(), uptimeSeconds: 30 * 24 * 60 * 60 })
      .where(eq(devices.id, device));
    const dispatched = await dispatchOemUpdateRun({
      deviceId: device,
      expectedOrgId: orgA.id,
      trigger: 'scheduled',
      requestedCategories: ['driver'],
      blockedUpdateIds: [],
      rebootControlled: true,
      notAfter: new Date(Date.now() + 60 * 60 * 1000),
      occurrenceKey: '2027-01',
      actorUserId: null,
    });
    if (!dispatched.ok) throw new Error(`dispatch refused: ${dispatched.refusal}`);
    await applyOemUpdateResult({
      commandId: dispatched.commandId,
      deviceId: device,
      result: {
        lane: 'dell', outcome: 'success_reboot_required', toolVersion: '5.7.2', rawExitCode: 1, errorCode: null,
        rebootRequired: true, shutdownRequired: false, items: [], skippedCategories: [], takeover: 'not_attempted',
      },
    });

    const reboots = () => withSystemDbAccessContext(() => db
      .select({ id: deviceCommands.id, payload: deviceCommands.payload, submittedOrgId: deviceCommands.submittedOrgId })
      .from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, device), eq(deviceCommands.type, 'schedule_reboot'))));

    await runOemRebootSweep(new Date());
    await runOemRebootSweep(new Date());
    expect(await reboots()).toHaveLength(1);
    const [first] = await reboots();
    expect(first!.submittedOrgId).toBe(orgA.id);
    expect(first!.payload).toMatchObject({ deadlineAction: 'hold', source: 'oem_updates' });

    // The agent answers as soon as it has scheduled the restart: still tonight's one.
    await getTestDb().update(deviceCommands).set({ status: 'completed' }).where(eq(deviceCommands.id, first!.id));
    await runOemRebootSweep(new Date());
    expect(await reboots()).toHaveLength(1);

    // Held, and no boot since: the next night asks again.
    await getTestDb().update(deviceCommands)
      .set({ createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(deviceCommands.id, first!.id));
    await runOemRebootSweep(new Date());
    expect(await reboots()).toHaveLength(2);
  });

  runDb('a boot since the reboot was owed clears it', async () => {
    const { orgA, siteA } = await fanoutFixture();
    const device = await seedDevice(orgA.id, siteA.id);
    const owedSince = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await getTestDb().insert(deviceOemUpdateStatus).values({
      deviceId: device,
      orgId: orgA.id,
      lane: 'dell',
      applicability: 'applicable',
      rebootRequired: true,
      rebootPendingSince: owedSince,
    });
    await getTestDb().update(devices).set({ lastSeenAt: new Date(), uptimeSeconds: 60 }).where(eq(devices.id, device));

    // Two ticks have to agree on the boot.
    await runOemRebootSweep(new Date());
    await runOemRebootSweep(new Date());

    const [row] = await withSystemDbAccessContext(() => db
      .select({ rebootRequired: deviceOemUpdateStatus.rebootRequired, rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince })
      .from(deviceOemUpdateStatus)
      .where(eq(deviceOemUpdateStatus.deviceId, device)));
    expect(row).toEqual({ rebootRequired: false, rebootPendingSince: null });
  });
});

describe('oemUpdates release sweep against real Postgres', () => {
  const takenOver = async (deviceId: string, orgId: string) => {
    await getTestDb().insert(deviceOemUpdateStatus).values({
      deviceId,
      orgId,
      lane: 'dell',
      applicability: 'applicable',
      takeoverState: 'taken_over',
    });
  };

  const stateOf = async (deviceId: string) => {
    const [row] = await withSystemDbAccessContext(() => db
      .select({ takeoverState: deviceOemUpdateStatus.takeoverState })
      .from(deviceOemUpdateStatus)
      .where(eq(deviceOemUpdateStatus.deviceId, deviceId)));
    return row!.takeoverState;
  };

  const releases = (deviceId: string) => withSystemDbAccessContext(() => db
    .select({ id: deviceCommands.id, status: deviceCommands.status, type: deviceCommands.type })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), oemReleaseCommandFilter())));

  async function deviceWithoutPolicy() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id);
    await takenOver(device, org.id);
    return { partner, org, device };
  }

  runDb('no enabled lane queues one release, and a second tick does not add another', async () => {
    const { device } = await deviceWithoutPolicy();

    await runOemReleaseSweep(new Date());
    await runOemReleaseSweep(new Date());

    expect(await stateOf(device)).toBe('releasing');
    expect(await releases(device)).toHaveLength(1);
  });

  runDb('still goes out with the feature flag off: that can be why it is needed', async () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    const { device } = await deviceWithoutPolicy();

    await runOemReleaseSweep(new Date());

    expect(await releases(device)).toHaveLength(1);
  });

  runDb('the ack clears the state, through the registered handler', async () => {
    const { device, org } = await deviceWithoutPolicy();
    await runOemReleaseSweep(new Date());
    const [release] = await releases(device);

    await commandResultHandlers[release!.type]!({
      agentId: 'agent-1',
      command: { id: release!.id, deviceId: device, orgId: org.id, type: release!.type } as never,
      commandId: release!.id,
      result: { status: 'completed' } as never,
      resolvedDeviceId: device,
      stdout: JSON.stringify({ lane: 'dell', outcome: 'restored', errorCode: null }),
    });

    expect(await stateOf(device)).toBe('none');
  });

  runDb('re-enabling before the ack keeps the takeover and cancels the release', async () => {
    const { device, partner } = await deviceWithoutPolicy();
    await runOemReleaseSweep(new Date());
    expect(await stateOf(device)).toBe('releasing');

    await seedPartnerWidePolicy(partner.id);
    await runOemReleaseSweep(new Date());

    expect(await stateOf(device)).toBe('taken_over');
    expect((await releases(device)).map((row) => row.status)).toEqual(['cancelled']);
  });

  runDb('a release already sent cannot be cancelled', async () => {
    const { device } = await deviceWithoutPolicy();
    await runOemReleaseSweep(new Date());
    const [release] = await releases(device);
    await getTestDb().update(deviceCommands).set({ status: 'sent' }).where(eq(deviceCommands.id, release!.id));

    await expect(withSystemDbAccessContext(() => cancelPendingOemUpdateRelease(device, new Date()))).resolves.toBe(false);
    expect((await releases(device)).map((row) => row.status)).toEqual(['sent']);
  });

  runDb('an ack does not undo a policy_locked row', async () => {
    const { device, org } = await deviceWithoutPolicy();
    await getTestDb().update(deviceOemUpdateStatus).set({ takeoverState: 'policy_locked' }).where(eq(deviceOemUpdateStatus.deviceId, device));
    const commandId = randomUUID();
    await getTestDb().insert(deviceCommands).values({
      id: commandId,
      deviceId: device,
      type: 'oem_update_release',
      payload: { lane: 'dell' },
      status: 'completed',
      submittedOrgId: org.id,
    });

    await applyOemUpdateRelease({ commandId, deviceId: device, result: { lane: 'dell', outcome: 'restored', errorCode: null } });

    expect(await stateOf(device)).toBe('policy_locked');
  });

  runDb('an org move does not release when the new org policy also resolves, and does when none does', async () => {
    const { orgA, orgB, siteB, siteA } = await fanoutFixture();
    const device = await seedDevice(orgA.id, siteA.id);
    await takenOver(device, orgA.id);
    await getTestDb().update(devices).set({ orgId: orgB.id, siteId: siteB.id }).where(eq(devices.id, device));

    await runOemReleaseSweep(new Date());
    expect(await releases(device)).toEqual([]);

    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    await getTestDb().update(devices).set({ orgId: otherOrg.id, siteId: otherSite.id }).where(eq(devices.id, device));

    await runOemReleaseSweep(new Date());
    expect(await releases(device)).toHaveLength(1);
    const [row] = await withSystemDbAccessContext(() => db
      .select({ orgId: deviceOemUpdateStatus.orgId })
      .from(deviceOemUpdateStatus)
      .where(eq(deviceOemUpdateStatus.deviceId, device)));
    expect(row!.orgId).toBe(otherOrg.id);
  });

  runDb('a parked device is left alone', async () => {
    const partner = await createPartner();
    const holding = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
    const site = await createSite({ orgId: holding.id });
    const parked = await seedParkedDevice(holding.id, site.id);
    await takenOver(parked, holding.id);

    await runOemReleaseSweep(new Date());

    expect(await releases(parked)).toEqual([]);
    expect(await stateOf(parked)).toBe('taken_over');
  });
});
