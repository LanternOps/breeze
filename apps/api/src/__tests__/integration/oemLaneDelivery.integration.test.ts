/**
 * One owner per update class against real Postgres and RLS (#11073, spec 4.6): a
 * scan writes the type onto the device's own row under the agent's context, the
 * CHECK holds, and the real predicate decides what the real evaluator leaves to a
 * lane. Mocks cannot prove the column exists, the join is right, or that a
 * partner-wide link reaches the device.
 *
 * Gates are closed in code until the lab wave, so the lab override opens them for
 * the seeded devices.
 *
 * Run:
 *   pnpm test-stack up
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/oemLaneDelivery.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  deviceHardware,
  deviceOemUpdateStatus,
  devicePatches,
  devices,
  patchApprovals,
  patches,
} from '../../db/schema';
import { patchesRoutes } from '../../routes/agents/patches';
import { getVendorManagedClasses, getVendorManagedClassesForDevices } from '../../services/oemUpdates/laneDelivery';
import { computeOccurrence } from '../../services/oemUpdates/occurrence';
import { evaluatePatchInstallEligibility, resolveApprovedPatchesForDevice } from '../../services/patchEligibility';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SCHEDULE = { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 } as const;
const NO_RING = { ringId: null, categoryRules: [], autoApprove: {}, deferralDays: 0 };

function armedSettings(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    enabled: true,
    schedule: SCHEDULE,
    catchUpNights: 7,
    reboot: 'overnight',
    vendors: { dell: { enabled: true, categories: { bios: true, firmware: true, driver: true }, blockedUpdateIds: [] } },
    ...over,
  };
}

function agentContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: null };
}

const labDevices: string[] = [];

async function seedDevice(orgId: string, siteId: string) {
  const agentId = `oem-lane-${randomUUID()}`;
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId,
    hostname: `lane-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '0.127.0',
    status: 'online',
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
  return { id: device!.id, agentId };
}

async function seedPartnerWidePolicy(partnerId: string, settings: Record<string, unknown> = armedSettings()) {
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
}

/** A lane that finished this occurrence, whatever day the test runs on. */
async function seedDeliveringStatus(
  deviceId: string,
  orgId: string,
  over: Partial<typeof deviceOemUpdateStatus.$inferInsert> = {},
  run: { trigger?: string; skippedCategories?: Array<{ category: string; reason: string }> } = {},
) {
  const now = new Date();
  const [command] = await getTestDb().insert(deviceCommands).values({
    deviceId,
    type: 'oem_update_run',
    payload: { lane: 'dell', trigger: run.trigger ?? 'scheduled', categories: ['bios', 'firmware', 'driver'] },
    status: 'completed',
    submittedOrgId: orgId,
    result: {
      stdout: JSON.stringify({
        lane: 'dell',
        outcome: 'success',
        toolVersion: '5.7.2',
        rawExitCode: 0,
        errorCode: null,
        rebootRequired: false,
        shutdownRequired: false,
        items: [],
        skippedCategories: run.skippedCategories ?? [],
        takeover: 'ok',
      }),
    },
  }).returning({ id: deviceCommands.id });
  await getTestDb().insert(deviceOemUpdateStatus).values({
    lastCommandId: command!.id,
    deviceId,
    orgId,
    lane: 'dell',
    applicability: 'applicable',
    occurrenceKey: computeOccurrence({ ...SCHEDULE, catchUpNights: 7 }, 'UTC', now).occurrenceKey,
    attempts: 1,
    lastOutcome: 'success',
    lastAttemptAt: now,
    lastSuccessAt: now,
    firstCompletedAt: now,
    ...over,
  });
}

async function scan(orgId: string, device: { id: string; agentId: string }, reported: Array<Record<string, unknown>>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', { orgId, agentId: device.agentId, role: 'agent' } as never);
    await next();
  });
  app.route('/agents', patchesRoutes);
  return withDbAccessContext(agentContext(orgId), async () =>
    app.request(`/agents/${device.agentId}/patches/pending`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'microsoft', patches: reported }),
    }));
}

async function devicePatchRow(deviceId: string, externalId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ patchId: devicePatches.patchId, reportedUpdateType: devicePatches.reportedUpdateType })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(and(eq(devicePatches.deviceId, deviceId), eq(patches.externalId, externalId)));
    return row ?? null;
  });
}

/** A device with a scanned driver, approved so that only the lane can hold it back. */
async function deliveringFixture(
  settings: Record<string, unknown> = armedSettings(),
  type = 'driver',
  category = 'driver',
  owner: string | null = 'dell',
) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  await seedPartnerWidePolicy(partner.id, settings);
  const device = await seedDevice(org.id, site.id);
  const externalId = `wu-${randomUUID()}`;
  const res = await scan(org.id, device, [
    { name: 'Dell Inc. - Display', source: 'microsoft', externalId, category, reportedUpdateType: type, reportedUpdateOwner: owner ?? undefined },
  ]);
  expect(res.status).toBe(200);
  const row = await devicePatchRow(device.id, externalId);
  await getTestDb().insert(patchApprovals).values({ partnerId: partner.id, patchId: row!.patchId, status: 'approved' });
  return { partner, org, site, device, patchId: row!.patchId, externalId };
}

async function approvedIds(deviceId: string, orgId: string): Promise<string[]> {
  const approved = await withSystemDbAccessContext(() => resolveApprovedPatchesForDevice(deviceId, orgId, NO_RING));
  return approved.map((p) => p.patchId);
}

beforeEach(() => {
  labDevices.length = 0;
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('device_patches.reported_update_type (real Postgres)', () => {
  runDb('a scan writes it on the device row under the agent RLS context, and absent stays null', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id);
    const driver = `wu-${randomUUID()}`;
    const old = `wu-${randomUUID()}`;
    const odd = `wu-${randomUUID()}`;

    const res = await scan(org.id, device, [
      { name: 'Driver', source: 'microsoft', externalId: driver, category: 'driver', reportedUpdateType: 'driver' },
      { name: 'From an older agent', source: 'microsoft', externalId: old, category: 'driver' },
      { name: 'From a newer agent', source: 'microsoft', externalId: odd, category: 'driver', reportedUpdateType: 'capsule' },
    ]);

    expect(res.status).toBe(200);
    expect((await devicePatchRow(device.id, driver))?.reportedUpdateType).toBe('driver');
    expect((await devicePatchRow(device.id, old))?.reportedUpdateType).toBeNull();
    expect((await devicePatchRow(device.id, odd))?.reportedUpdateType).toBeNull();
  });

  runDb('a later scan without the field keeps the stored value', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id);
    const externalId = `wu-${randomUUID()}`;
    const patch = { name: 'Driver', source: 'microsoft', externalId, category: 'driver' };

    await scan(org.id, device, [{ ...patch, reportedUpdateType: 'firmware' }]);
    await scan(org.id, device, [patch]);

    expect((await devicePatchRow(device.id, externalId))?.reportedUpdateType).toBe('firmware');
  });

  runDb('one tenant\'s report never reaches another tenant\'s row or the shared one', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: (await createPartner()).id });
    const deviceA = await seedDevice(orgA.id, (await createSite({ orgId: orgA.id })).id);
    const deviceB = await seedDevice(orgB.id, (await createSite({ orgId: orgB.id })).id);
    const externalId = `wu-${randomUUID()}`;
    const patch = { name: 'Same update', source: 'microsoft', externalId, category: 'driver' };

    await scan(orgA.id, deviceA, [{ ...patch, reportedUpdateType: 'driver' }]);
    await scan(orgB.id, deviceB, [{ ...patch, reportedUpdateType: 'other' }]);

    expect((await devicePatchRow(deviceA.id, externalId))?.reportedUpdateType).toBe('driver');
    expect((await devicePatchRow(deviceB.id, externalId))?.reportedUpdateType).toBe('other');
    const shared = await getTestDb().execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'patches' AND column_name = 'reported_update_type'
    `);
    expect(Array.from(shared)).toHaveLength(0);
  });

  runDb('the CHECK refuses a value outside the set', async () => {
    const { device, patchId } = await deliveringFixture();
    await expect(
      getTestDb().execute(sql`
        UPDATE device_patches SET reported_update_type = 'capsule'
        WHERE device_id = ${device.id} AND patch_id = ${patchId}
      `),
    ).rejects.toThrow();
  });
});

describe('the predicate and the evaluator together (real Postgres)', () => {
  runDb('a driver leaves patch jobs while the lane delivers, through a partner-wide link', async () => {
    const { org, device, patchId } = await deliveringFixture();
    await seedDeliveringStatus(device.id, org.id);

    expect(await withSystemDbAccessContext(() => getVendorManagedClasses(device.id))).toEqual(new Set(['driver', 'firmware']));
    expect(await approvedIds(device.id, org.id)).toEqual([]);

    const verdict = await withSystemDbAccessContext(() =>
      evaluatePatchInstallEligibility({ deviceId: device.id, orgId: org.id, config: NO_RING }));
    expect(verdict.ineligible).toEqual([{ patchId, reason: 'managed_by_vendor_updates' }]);
  });

  runDb('a device with no status row is unchanged', async () => {
    const { org, device, patchId } = await deliveringFixture();

    expect(await withSystemDbAccessContext(() => getVendorManagedClasses(device.id))).toEqual(new Set());
    expect(await approvedIds(device.id, org.id)).toEqual([patchId]);
  });

  runDb('the lane going Failing, then Overdue, hands the driver back on the next evaluation', async () => {
    const { org, device, patchId } = await deliveringFixture();
    await seedDeliveringStatus(device.id, org.id);
    expect(await approvedIds(device.id, org.id)).toEqual([]);

    await getTestDb().update(deviceOemUpdateStatus)
      .set({ lastOutcome: 'failed' })
      .where(eq(deviceOemUpdateStatus.deviceId, device.id));
    expect(await approvedIds(device.id, org.id)).toEqual([patchId]);

    await getTestDb().update(deviceOemUpdateStatus)
      .set({ lastOutcome: 'blocked_on_battery', attempts: 3 })
      .where(eq(deviceOemUpdateStatus.deviceId, device.id));
    expect(await approvedIds(device.id, org.id)).toEqual([patchId]);

    await getTestDb().update(deviceOemUpdateStatus)
      .set({ lastOutcome: 'success', attempts: 1 })
      .where(eq(deviceOemUpdateStatus.deviceId, device.id));
    expect(await approvedIds(device.id, org.id)).toEqual([]);
  });

  runDb('not_supported and no completed run keep the driver with Windows Update', async () => {
    const unsupported = await deliveringFixture();
    await seedDeliveringStatus(unsupported.device.id, unsupported.org.id, { applicability: 'not_supported' });
    expect(await approvedIds(unsupported.device.id, unsupported.org.id)).toEqual([unsupported.patchId]);

    const neverRan = await deliveringFixture();
    await seedDeliveringStatus(neverRan.device.id, neverRan.org.id, { firstCompletedAt: null });
    expect(await approvedIds(neverRan.device.id, neverRan.org.id)).toEqual([neverRan.patchId]);
  });

  runDb('a driver the lane does not own stays with Windows Update while the lane delivers', async () => {
    const intel = await deliveringFixture(armedSettings(), 'driver', 'driver', null);
    await seedDeliveringStatus(intel.device.id, intel.org.id);
    expect(await approvedIds(intel.device.id, intel.org.id)).toEqual([intel.patchId]);

    const printer = await deliveringFixture(armedSettings(), 'driver', 'driver', 'hp');
    await seedDeliveringStatus(printer.device.id, printer.org.id);
    expect(await approvedIds(printer.device.id, printer.org.id)).toEqual([printer.patchId]);
  });

  runDb('a Run Now since the last scheduled run hands the class back', async () => {
    const { org, device, patchId } = await deliveringFixture();
    await seedDeliveringStatus(device.id, org.id, {}, { trigger: 'on_demand' });

    expect(await approvedIds(device.id, org.id)).toEqual([patchId]);
  });

  runDb('firmware the last run refused stays with Windows Update', async () => {
    const { org, device, patchId } = await deliveringFixture(armedSettings(), 'firmware', 'driver');
    await seedDeliveringStatus(device.id, org.id, {}, { skippedCategories: [{ category: 'firmware', reason: 'no_recovery_key' }] });

    expect(await withSystemDbAccessContext(() => getVendorManagedClasses(device.id))).toEqual(new Set(['driver']));
    expect(await approvedIds(device.id, org.id)).toEqual([patchId]);
  });

  runDb('a security classification on a driver stays with Windows Update', async () => {
    const { org, device, patchId } = await deliveringFixture(armedSettings(), 'driver', 'security');
    await seedDeliveringStatus(device.id, org.id);

    expect(await approvedIds(device.id, org.id)).toEqual([patchId]);
  });

  runDb('a policy that never reboots leaves firmware with Windows Update and drivers with the lane', async () => {
    const firmware = await deliveringFixture(armedSettings({ reboot: 'never' }), 'firmware', 'driver');
    await seedDeliveringStatus(firmware.device.id, firmware.org.id);
    expect(await approvedIds(firmware.device.id, firmware.org.id)).toEqual([firmware.patchId]);

    const driver = await deliveringFixture(armedSettings({ reboot: 'never' }));
    await seedDeliveringStatus(driver.device.id, driver.org.id);
    expect(await approvedIds(driver.device.id, driver.org.id)).toEqual([]);
  });

  runDb('RLS: an org context reads its own device, and nothing for another org\'s', async () => {
    const mine = await deliveringFixture();
    await seedDeliveringStatus(mine.device.id, mine.org.id);
    const theirs = await deliveringFixture();
    await seedDeliveringStatus(theirs.device.id, theirs.org.id);

    // The context the device Patches tab reads in (readOwnPartnerAxisRows).
    const result = await withDbAccessContext({ ...agentContext(mine.org.id), currentPartnerId: mine.partner.id }, () =>
      getVendorManagedClassesForDevices([mine.device.id, theirs.device.id]));

    expect(result.get(theirs.device.id)).toEqual(new Set());
    expect(result.get(mine.device.id)).toEqual(new Set(['driver', 'firmware']));
  });

  runDb('a parked device has no lane delivering', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
    const site = await createSite({ orgId: org.id });
    await seedPartnerWidePolicy(partner.id);
    const id = await withSystemDbAccessContext(async () => {
      await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
      const [device] = await db.insert(devices).values({
        orgId: org.id,
        siteId: site.id,
        agentId: `oem-parked-${randomUUID()}`,
        hostname: `parked-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '0.127.0',
        status: 'online',
      }).returning({ id: devices.id });
      await db.insert(deviceHardware).values({ deviceId: device!.id, orgId: org.id, manufacturer: 'Dell Inc.', model: 'Latitude 7420' });
      return device!.id;
    });
    labDevices.push(id);
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', labDevices.join(','));
    await seedDeliveringStatus(id, org.id);

    expect(await withSystemDbAccessContext(() => getVendorManagedClasses(id))).toEqual(new Set());
  });

  runDb('the flag off leaves everything with Windows Update', async () => {
    const { org, device, patchId } = await deliveringFixture();
    await seedDeliveringStatus(device.id, org.id);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');

    expect(await approvedIds(device.id, org.id)).toEqual([patchId]);
  });
});
