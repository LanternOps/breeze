/**
 * #12292: the scheduled vendor-updates observe sweep against real PostgreSQL.
 *
 * The unit tests mock the database, so the sweep's query never ran anywhere
 * before it shipped, and it threw on every tick (a JS `Date` bound into a raw
 * `sql` parameter). This runs `runOemObserveSweep` itself, as `breeze_app`
 * under the real RLS, and proves:
 *   - the query runs, and a canary partner's eligible device gets exactly one
 *     scheduled `oem_observe` command;
 *   - a device whose last attempt did not complete is not swept again inside
 *     the retry window, and is once the window has passed;
 *   - a completed observation keeps the device out of the sweep for a week;
 *   - a partner not on the canary list gets nothing, in the same sweep run.
 *
 * The window checks assert the sweep's own `considered` count, not only the
 * rows: the dispatch seam's `recent_observation` check would otherwise hide a
 * broken query clause.
 *
 * Run:
 *   pnpm test-stack up
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/oemObserveSweep.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OEM_OBSERVE_MIN_AGENT_VERSION } from '@breeze/shared';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  deviceHardware,
  devices,
} from '../../db/schema';
import {
  OEM_OBSERVE_SWEEP_INTERVAL_MS,
  OEM_OBSERVE_SWEEP_RETRY_MS,
  resetOemObserveSweepCursorForTests,
  runOemObserveSweep,
} from '../../services/oemUpdates/observe';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const HOUR = 60 * 60 * 1000;

const lenovoObserveOn = {
  version: 1,
  enabled: true,
  schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
  catchUpNights: 7,
  reboot: 'overnight',
  // Observe needs the lane enabled, not a category: every gate is closed at observe.
  vendors: { lenovo: { enabled: true, categories: {}, blockedUpdateIds: [] } },
};

/** An eligible Lenovo workstation, online, on an agent that can observe. */
async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `observe-${randomUUID()}`,
    hostname: 'observe-host',
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: OEM_OBSERVE_MIN_AGENT_VERSION,
    status: 'online',
    deviceRole: 'workstation',
  }).returning({ id: devices.id });
  await getTestDb().insert(deviceHardware).values({
    deviceId: device!.id,
    orgId,
    manufacturer: 'LENOVO',
    model: '21K5CTO1WW',
    biosVersion: 'N3JET30W',
  });
  return device!.id;
}

/** A partner with one org, one eligible device, and an org policy that enables the lane. */
async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const deviceId = await seedDevice(org.id, site.id);
  const [policy] = await getTestDb().insert(configurationPolicies).values({
    orgId: org.id,
    name: `vendor updates ${randomUUID()}`,
    status: 'active',
  }).returning({ id: configurationPolicies.id });
  await getTestDb().insert(configPolicyFeatureLinks).values({
    configPolicyId: policy!.id,
    featureType: 'oem_updates',
    inlineSettings: lenovoObserveOn,
  });
  await getTestDb().insert(configPolicyAssignments).values({
    configPolicyId: policy!.id,
    level: 'organization',
    targetId: org.id,
    priority: 0,
  });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId };
}

const observeRows = (deviceId: string) =>
  getTestDb().select().from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'oem_observe')));

describe('#12292 scheduled observe sweep against real PostgreSQL', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    resetOemObserveSweepCursorForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetOemObserveSweepCursorForTests();
  });

  it('dispatches exactly one scheduled oem_observe to a canary partner\'s eligible device', async () => {
    const canary = await seedTenant();
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', canary.partnerId);

    await expect(runOemObserveSweep(new Date())).resolves.toEqual({ considered: 1, dispatched: 1 });

    const rows = await observeRows(canary.deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ submittedOrgId: canary.orgId, createdBy: null });
    expect(rows[0]!.payload).toMatchObject({ lane: 'lenovo', observeLevel: 'passive' });

    // The same tick again: the in-flight row keeps the device out of the query itself.
    await expect(runOemObserveSweep(new Date())).resolves.toEqual({ considered: 0, dispatched: 0 });
    expect(await observeRows(canary.deviceId)).toHaveLength(1);
  });

  it('does not re-sweep an attempt that did not complete inside the retry window, and does after it', async () => {
    const canary = await seedTenant();
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', canary.partnerId);
    const now = Date.now();

    await expect(runOemObserveSweep(new Date(now))).resolves.toEqual({ considered: 1, dispatched: 1 });
    // Failed: the seam's own recent check no longer counts it, so only the
    // sweep query's retry clause can keep the device out.
    await getTestDb().update(deviceCommands).set({ status: 'failed' })
      .where(and(eq(deviceCommands.deviceId, canary.deviceId), eq(deviceCommands.type, 'oem_observe')));

    await expect(runOemObserveSweep(new Date(now + OEM_OBSERVE_SWEEP_RETRY_MS - HOUR)))
      .resolves.toEqual({ considered: 0, dispatched: 0 });
    expect(await observeRows(canary.deviceId)).toHaveLength(1);

    await expect(runOemObserveSweep(new Date(now + OEM_OBSERVE_SWEEP_RETRY_MS + HOUR)))
      .resolves.toEqual({ considered: 1, dispatched: 1 });
    expect(await observeRows(canary.deviceId)).toHaveLength(2);
  });

  it('keeps a device with a completed observation out of the sweep for the sweep interval', async () => {
    const canary = await seedTenant();
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', canary.partnerId);
    const now = Date.now();

    await expect(runOemObserveSweep(new Date(now))).resolves.toEqual({ considered: 1, dispatched: 1 });
    await getTestDb().update(deviceCommands).set({ status: 'completed' })
      .where(and(eq(deviceCommands.deviceId, canary.deviceId), eq(deviceCommands.type, 'oem_observe')));

    // Past the retry window but inside the week: only the completed clause keeps it out.
    await expect(runOemObserveSweep(new Date(now + OEM_OBSERVE_SWEEP_RETRY_MS + HOUR)))
      .resolves.toEqual({ considered: 0, dispatched: 0 });

    // Back-date the completed row past the week: due again. (The seam reads the
    // real clock for its own 24 h check, so move the row rather than `now`.)
    await getTestDb().update(deviceCommands)
      .set({ createdAt: new Date(now - OEM_OBSERVE_SWEEP_INTERVAL_MS - HOUR) })
      .where(and(eq(deviceCommands.deviceId, canary.deviceId), eq(deviceCommands.type, 'oem_observe')));
    await expect(runOemObserveSweep(new Date(now))).resolves.toEqual({ considered: 1, dispatched: 1 });
    expect(await observeRows(canary.deviceId)).toHaveLength(2);
  });

  it('reads each device\'s own commands: one device\'s recent observation does not hold back another', async () => {
    const canary = await seedTenant();
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', canary.partnerId);
    const now = new Date();

    await expect(runOemObserveSweep(now)).resolves.toEqual({ considered: 1, dispatched: 1 });
    // A second device in the same org, under the same policy, with no command of its own.
    const sibling = await seedDevice(canary.orgId, canary.siteId);

    await expect(runOemObserveSweep(now)).resolves.toEqual({ considered: 1, dispatched: 1 });
    expect(await observeRows(canary.deviceId)).toHaveLength(1);
    expect(await observeRows(sibling)).toHaveLength(1);
  });

  it('sends nothing to a partner that is not on the canary list, in the same run as one that is', async () => {
    const canary = await seedTenant();
    const outsider = await seedTenant();
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', canary.partnerId);

    await expect(runOemObserveSweep(new Date())).resolves.toEqual({ considered: 1, dispatched: 1 });

    expect(await observeRows(canary.deviceId)).toHaveLength(1);
    expect(await observeRows(outsider.deviceId)).toEqual([]);
  });
});
