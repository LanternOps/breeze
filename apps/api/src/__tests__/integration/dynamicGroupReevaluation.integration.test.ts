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
 *   6. a device DELETED between enqueue and run no-ops (and that this is
 *      distinguishable from "not committed yet" — see case 7).
 *   7. #5039 review finding 1, the enqueue-before-commit race: the enqueue
 *      happens INSIDE the caller's still-open transaction, so an undelayed
 *      worker reads a snapshot without the device row and silently completes
 *      having evaluated nothing. Driven end to end against real Redis with a
 *      real BullMQ worker, with the undelayed behaviour as a paired negative
 *      control in the same test.
 */
import './setup';

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';

import { db, withSystemDbAccessContext } from '../../db';
import {
  deviceGroupMemberships,
  deviceGroups,
  devices,
  groupMembershipLog,
} from '../../db/schema';
import {
  DEVICE_GROUP_REEVALUATION_DELAY_MS,
  createDeviceGroupReevaluationWorker,
  deviceGroupReevaluationJobId,
  getDeviceGroupReevaluationQueue,
  processDeviceGroupReevaluation,
  runDeviceGroupReevaluationJob,
  scheduleDeviceGroupReevaluation,
  shutdownDeviceGroupJobs,
} from '../../jobs/deviceGroupJobs';
import { closeRedis } from '../../services/redis';
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

  /**
   * The `!device` branch means DELETED, not "committing right now".
   *
   * That distinction is only true because of `DEVICE_GROUP_REEVALUATION_DELAY_MS`
   * (#5039 review finding 1). Before the delay, the same branch also absorbed a
   * device whose INSERT had not committed yet — the enrolment path — and
   * reported `{evaluated: false}` as a SUCCESS, so nothing retried and the
   * device was never added to any dynamic group. Case 7 below proves the
   * not-yet-committed device now IS evaluated, which is what makes it safe for
   * this branch to treat a missing row as a genuine deletion.
   */
  runDb('no-ops for a device deleted between enqueue and run', async () => {
    const env = await setupTestEnvironment();
    const groupId = await seedDynamicGroup(env.organization.id);
    const deviceId = await seedDevice(env.organization.id, env.site.id, 'srv-epsilon');

    // It matched and was a member before the delete.
    await runReevaluation({
      deviceId,
      orgId: env.organization.id,
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });
    expect(await memberDeviceIds(groupId)).toEqual([deviceId]);

    // Delete it in the same order the device cascade does: children first.
    // Neither device_group_memberships.device_id nor group_membership_log
    // .device_id is ON DELETE CASCADE, so both have to go before the device
    // (this is exactly why CORE_DEVICE_CASCADE_DELETE_TABLES exists).
    await withSystemDbAccessContext(async () => {
      await db.delete(groupMembershipLog).where(eq(groupMembershipLog.deviceId, deviceId));
      await db.delete(deviceGroupMemberships).where(eq(deviceGroupMemberships.deviceId, deviceId));
      await db.delete(devices).where(eq(devices.id, deviceId));
    });

    const result = await runReevaluation({
      deviceId,
      orgId: env.organization.id,
      eventType: 'device.updated',
      changedFields: ['hostname'],
    });

    expect(result).toEqual({ evaluated: false, orgId: null });
    expect(await memberDeviceIds(groupId)).toEqual([]);
  });

  // A device id that never existed takes the same branch — there is nothing to
  // evaluate either way.
  runDb('no-ops for a device id that never existed', async () => {
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

/**
 * #5039 review finding 1 — the enqueue-before-commit race, end to end against
 * real Redis + real Postgres with a real BullMQ worker.
 *
 * Every producer (`/enroll`, `/provision`, the heartbeat) calls
 * `requestDeviceGroupReevaluation` from INSIDE its own still-open
 * `withDbAccessContext` / `withSystemDbAccessContext` transaction — that is the
 * point of the queue. The worker runs on a different pooled connection, so
 * without a delay it can start before the producer commits and read a snapshot
 * in which the device row does not exist. That is not an error: it is
 * `{evaluated: false}`, a COMPLETED job, no retry, and a device that is never
 * added to any dynamic group.
 *
 * This is the only place in the file that goes through the real queue. Every
 * other case calls `processDeviceGroupReevaluation` directly, which cannot
 * observe the delay — or the race — at all.
 */
describe('enqueue-before-commit race (#5039)', () => {
  const workers: Worker[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close()));
    // Delayed jobs outlive the test's TRUNCATE; drop them so a later case
    // cannot be woken by one.
    await getDeviceGroupReevaluationQueue().obliterate({ force: true }).catch(() => {});
  });

  afterAll(async () => {
    await shutdownDeviceGroupJobs();
    await closeRedis();
  });

  runDb('evaluates a device whose INSERT commits only after the enqueue', async () => {
    const env = await setupTestEnvironment();
    const groupId = await seedDynamicGroup(env.organization.id);
    const deviceId = randomUUID();

    // The worker is running BEFORE the enqueue, so it has every opportunity to
    // pick the job up the instant it becomes runnable. Anything that stops it
    // from doing so is the delay, not a slow test.
    const worker = createDeviceGroupReevaluationWorker();
    workers.push(worker);
    await worker.waitUntilReady();

    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('re-evaluation job never completed')),
        DEVICE_GROUP_REEVALUATION_DELAY_MS + 20_000,
      );
      worker.on('completed', (job) => {
        if (job.data?.deviceId !== deviceId) return;
        clearTimeout(timer);
        resolve();
      });
    });

    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let markEnqueued!: () => void;
    const enqueued = new Promise<void>((resolve) => { markEnqueued = resolve; });

    // Stand in for the /enroll handler: INSERT the device and enqueue, both
    // inside one transaction that stays open for a while afterwards (the real
    // handler goes on to issue an mTLS certificate).
    const enrolment = withSystemDbAccessContext(async () => {
      await db.insert(devices).values({
        id: deviceId,
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `agent-${randomUUID()}`,
        hostname: 'srv-uncommitted',
        osType: 'windows',
        osVersion: '10',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      });

      await scheduleDeviceGroupReevaluation({
        deviceId,
        orgId: env.organization.id,
        eventType: 'device.created',
        reason: 'device_enrolled',
      });

      markEnqueued();
      await commitGate;
    });

    let sawUncommitted: unknown;
    try {
      await enqueued;

      // NEGATIVE CONTROL. Deliberately run from the TEST BODY, outside the
      // enrolment's async-local DB context, so this opens its own transaction
      // on its own pooled connection — a nested withSystemDbAccessContext
      // would reuse the caller's transaction and see the uncommitted row,
      // which is exactly the thing the real worker cannot do. This is what the
      // worker would have concluded had the job been runnable immediately: the
      // bug, reproduced.
      // Round 3: on device.created the processor THROWS for a missing row rather
      // than completing — the retry is the safety net for an enrolment held
      // open past the delay. Capture the rejection as the reproduced bug.
      sawUncommitted = await runDeviceGroupReevaluationJob({
        type: 'group-reevaluation',
        deviceId,
        orgId: env.organization.id,
        eventType: 'device.created',
        changedFields: [],
        reason: 'negative-control',
        queuedAt: new Date().toISOString(),
      }).then(
        () => 'resolved',
        (error: unknown) => error,
      );

      // Give the ready worker a real chance to grab the job early.
      await new Promise((resolve) => setTimeout(resolve, 750));

      const job = await getDeviceGroupReevaluationQueue()
        .getJob(deviceGroupReevaluationJobId(deviceId));
      expect(job, 'the job should be queued').toBeDefined();
      expect(job!.opts.delay).toBe(DEVICE_GROUP_REEVALUATION_DELAY_MS);
      // Still parked: the running worker has NOT been able to take it.
      expect(await job!.getState()).toBe('delayed');
      expect(await memberDeviceIds(groupId)).toEqual([]);
    } finally {
      releaseCommit();
      await enrolment;
    }

    // The bug, as it would have happened without the delay: the row was not
    // visible — and the processor refused to treat that as success.
    expect(sawUncommitted).toBeInstanceOf(Error);
    expect(String(sawUncommitted)).toMatch(/device\.created/);

    // And the fix: once the delay elapses the device is visible and evaluated.
    await completed;
    expect(await memberDeviceIds(groupId)).toEqual([deviceId]);
  }, DEVICE_GROUP_REEVALUATION_DELAY_MS + 45_000);

  runDb('coalesces a second change into the still-delayed job', async () => {
    // The delay window doubles as the coalescing window, so `delayed` has to
    // stay in isReusableState — otherwise every change inside the window would
    // add a duplicate job instead of merging.
    const env = await setupTestEnvironment();
    await seedDynamicGroup(env.organization.id);
    const deviceId = await seedDevice(env.organization.id, env.site.id, 'wks-coalesce');

    await scheduleDeviceGroupReevaluation({
      deviceId,
      orgId: env.organization.id,
      eventType: 'device.updated',
      changedFields: ['hostname'],
      reason: 'heartbeat_device_change',
    });
    const secondId = await scheduleDeviceGroupReevaluation({
      deviceId,
      orgId: env.organization.id,
      eventType: 'device.updated',
      changedFields: ['osVersion'],
      reason: 'heartbeat_device_change',
    });

    const jobId = deviceGroupReevaluationJobId(deviceId);
    expect(secondId).toBe(jobId);

    const job = await getDeviceGroupReevaluationQueue().getJob(jobId);
    expect(await job!.getState()).toBe('delayed');
    // Merged, not duplicated: one job carrying the union of both changes.
    expect([...job!.data.changedFields].sort()).toEqual(['hostname', 'osVersion']);
    expect(await getDeviceGroupReevaluationQueue().getDelayedCount()).toBe(1);
  }, 30_000);
});
