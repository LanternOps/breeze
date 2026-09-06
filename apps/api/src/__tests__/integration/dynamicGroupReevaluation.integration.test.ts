/**
 * Real-Postgres proof that a DEVICE ATTRIBUTE CHANGE flips dynamic group
 * membership — the actual thing #4630 asked for, in both directions.
 *
 * Why a real database is mandatory here. Every unit test on this path mocks
 * either `services/groupMembership` or `events/deviceEvents`, so the whole
 * chain reduces to "a vi.fn() was called with the right arguments". The two
 * ways this feature silently does nothing are invisible to that:
 *
 *   1. RLS. `device_groups` is FORCE ROW LEVEL SECURITY under the
 *      unprivileged `breeze_app` role, so a re-evaluation that runs with no DB
 *      access context reads ZERO dynamic groups and reports a perfectly happy
 *      `{evaluatedGroups: 0}` — no error, no log, no membership change. A mock
 *      returns whatever rows it was handed regardless of context.
 *   2. The filter engine. `deviceMatchesFilter` compiles the stored
 *      filterConditions to SQL; whether `hostname startsWith 'srv-'` actually
 *      matches the row after an UPDATE is a Postgres question, not a
 *      TypeScript one.
 *
 * So this drives the REAL queue processor (`processDeviceGroupReevaluation`,
 * the function the BullMQ worker runs) against real Postgres, real RLS and the
 * real filter engine — mutating device rows exactly the way a heartbeat does
 * and asserting the membership table afterwards.
 *
 * Coverage:
 *   1. add — a device whose hostname starts matching the filter gains a row.
 *   2. remove — the same device losing the match has its row deleted.
 *   3. device.created — a device that already matched at insert is picked up
 *      without waiting for a change (the enrollment/provision path).
 *   4. the processor uses the DEVICE's own org, not the job payload's, so a
 *      stale/forged payload cannot steer the evaluation at another tenant.
 *   5. a matching device in another partner's org is never absorbed.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
import { processDeviceGroupReevaluation } from '../../jobs/deviceGroupJobs';
import {
  createOrganization,
  createPartner,
  createSite,
  setupTestEnvironment,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** `hostname startsWith 'srv-'` — a filter a heartbeat's hostname change can flip. */
const SERVER_HOSTNAME_FILTER = {
  operator: 'AND' as const,
  conditions: [{ field: 'hostname', operator: 'startsWith', value: 'srv-' }],
};

async function seedDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname,
        osType: 'windows',
        osVersion: '10',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning({ id: devices.id });
    return row!.id;
  });
}

async function seedDynamicGroup(orgId: string): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(deviceGroups)
      .values({
        orgId,
        name: `servers ${randomUUID().slice(0, 8)}`,
        type: 'dynamic',
        filterConditions: SERVER_HOSTNAME_FILTER,
        filterFieldsUsed: ['hostname'],
      })
      .returning({ id: deviceGroups.id });
    return row!.id;
  });
}

/** Mutate the device the way the heartbeat handler's `UPDATE devices` does. */
async function setHostname(deviceId: string, hostname: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.update(devices).set({ hostname }).where(eq(devices.id, deviceId));
  });
}

async function memberDeviceIds(groupId: string): Promise<string[]> {
  const rows = await withSystemDbAccessContext(async () =>
    db
      .select({ deviceId: deviceGroupMemberships.deviceId })
      .from(deviceGroupMemberships)
      .where(eq(deviceGroupMemberships.groupId, groupId)),
  );
  return rows.map((r) => r.deviceId).sort();
}

/**
 * Run the job body exactly as `createDeviceGroupReevaluationWorker` does:
 * inside a system DB access context, from the queue payload.
 */
async function runReevaluation(payload: {
  deviceId: string;
  orgId: string;
  eventType: 'device.created' | 'device.updated';
  changedFields?: string[];
}) {
  return withSystemDbAccessContext(() =>
    processDeviceGroupReevaluation({
      type: 'group-reevaluation',
      deviceId: payload.deviceId,
      orgId: payload.orgId,
      eventType: payload.eventType,
      changedFields: payload.changedFields ?? [],
      reason: 'integration-test',
      queuedAt: new Date().toISOString(),
    }),
  );
}

describe('dynamic device group re-evaluation on device change (#4630)', () => {
  runDb('adds the device when a hostname change starts matching the filter', async () => {
    const env = await setupTestEnvironment();
    const groupId = await seedDynamicGroup(env.organization.id);
    const deviceId = await seedDevice(env.organization.id, env.site.id, 'wks-alpha');

    // Baseline: the device does not match, so re-evaluating changes nothing.
    await runReevaluation({
      deviceId,
      orgId: env.organization.id,
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });
    expect(await memberDeviceIds(groupId)).toEqual([]);

    // The heartbeat's own UPDATE, then the queued re-evaluation.
    await setHostname(deviceId, 'srv-alpha');
    const result = await runReevaluation({
      deviceId,
      orgId: env.organization.id,
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });

    expect(result).toEqual({ evaluated: true, orgId: env.organization.id });
    expect(await memberDeviceIds(groupId)).toEqual([deviceId]);
  });

  runDb('removes the device when a hostname change stops matching the filter', async () => {
    const env = await setupTestEnvironment();
    const groupId = await seedDynamicGroup(env.organization.id);
    const deviceId = await seedDevice(env.organization.id, env.site.id, 'srv-beta');

    await runReevaluation({
      deviceId,
      orgId: env.organization.id,
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });
    expect(await memberDeviceIds(groupId)).toEqual([deviceId]);

    // Renamed out of the filter — the membership must not survive.
    await setHostname(deviceId, 'wks-beta');
    await runReevaluation({
      deviceId,
      orgId: env.organization.id,
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });

    expect(await memberDeviceIds(groupId)).toEqual([]);
  });

  runDb('picks up a device that already matched at insert (device.created)', async () => {
    // The enrollment/provision path: hostname is already correct at insert, so
    // no later heartbeat diff would ever fire for this device.
    const env = await setupTestEnvironment();
    const groupId = await seedDynamicGroup(env.organization.id);
    const deviceId = await seedDevice(env.organization.id, env.site.id, 'srv-gamma');

    await runReevaluation({ deviceId, orgId: env.organization.id, eventType: 'device.created' });

    expect(await memberDeviceIds(groupId)).toEqual([deviceId]);
  });

  runDb('evaluates against the DEVICE\'s org, not the org named in the job payload', async () => {
    // The job outlives the request that produced it. A membership row stamped
    // from a stale or forged payload org would be a cross-tenant row, so the
    // processor re-reads the device's own org id.
    const env = await setupTestEnvironment();
    const groupId = await seedDynamicGroup(env.organization.id);
    const deviceId = await seedDevice(env.organization.id, env.site.id, 'srv-delta');

    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });

    const result = await runReevaluation({
      deviceId,
      orgId: foreignOrg.id, // wrong on purpose
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });

    expect(result.orgId).toBe(env.organization.id);
    const rows = await withSystemDbAccessContext(async () =>
      db
        .select({ deviceId: deviceGroupMemberships.deviceId, orgId: deviceGroupMemberships.orgId })
        .from(deviceGroupMemberships)
        .where(eq(deviceGroupMemberships.groupId, groupId)),
    );
    expect(rows.map((r) => r.deviceId)).toEqual([deviceId]);
    // Every row carries the GROUP's own org, never the payload's.
    expect(rows[0]!.orgId).toBe(env.organization.id);
  });

  runDb('never absorbs a matching device from another tenant', async () => {
    const env = await setupTestEnvironment();
    const groupId = await seedDynamicGroup(env.organization.id);

    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
    const foreignSite = await createSite({ orgId: foreignOrg.id });
    const foreignDevice = await seedDevice(foreignOrg.id, foreignSite.id, 'srv-foreign');

    // Re-evaluating the foreign device names org A's group nowhere, and org A's
    // group is not in the foreign device's org, so nothing is written at all.
    await runReevaluation({
      deviceId: foreignDevice,
      orgId: foreignOrg.id,
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });

    expect(await memberDeviceIds(groupId)).toEqual([]);
    const anyRowForForeign = await withSystemDbAccessContext(async () =>
      db
        .select({ groupId: deviceGroupMemberships.groupId })
        .from(deviceGroupMemberships)
        .where(and(
          eq(deviceGroupMemberships.deviceId, foreignDevice),
          eq(deviceGroupMemberships.groupId, groupId),
        )),
    );
    expect(anyRowForForeign).toHaveLength(0);
  });

  runDb('no-ops for a device deleted between enqueue and run', async () => {
    const env = await setupTestEnvironment();
    await seedDynamicGroup(env.organization.id);

    const result = await runReevaluation({
      deviceId: randomUUID(),
      orgId: env.organization.id,
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });

    expect(result).toEqual({ evaluated: false, orgId: null });
  });
});
