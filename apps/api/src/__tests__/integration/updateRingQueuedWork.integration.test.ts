import './setup';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import {
  deviceCommands,
  devicePatches,
  devices,
  patchApprovals,
  patchJobResults,
  patchJobs,
  patchPolicies,
  patches,
} from '../../db/schema';
import { __testOnly as patchExecutorTestOnly } from '../../jobs/patchJobExecutor';
import { cancelQueuedRingPatchWork } from '../../services/updateRingQueuedWork';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * #8909 item 2 — what a ring delete/disable does to patch work that is already
 * queued. Real Postgres, because every case is decided by row locks and by
 * which committed version a statement sees, which a mocked `db` cannot model.
 *
 * Product decision: work not yet dispatched to a device is cancelled with a
 * reason; an install already delivered to the device is left to finish.
 */

const HOUR_MS = 60 * 60 * 1000;

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return withSystemDbAccessContext(fn);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('update ring delete/disable vs queued patch work — real PostgreSQL (#8909)', () => {
  let env: Awaited<ReturnType<typeof setupTestEnvironment>>;

  beforeEach(async () => {
    env = await setupTestEnvironment({ scope: 'organization' });
  });

  async function makeRing(name = `8909 ring ${randomUUID().slice(0, 8)}`) {
    const [ring] = await getTestDb()
      .insert(patchPolicies)
      .values({ partnerId: env.partner.id, kind: 'ring', name, deferralDays: 0, autoApprove: {}, categoryRules: [] })
      .returning();
    if (!ring) throw new Error('ring fixture insert failed');
    return ring;
  }

  async function makeDevice(status: 'online' | 'offline' = 'offline') {
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `ring-8909-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x64',
        agentVersion: '0.0.0-test',
        status,
      })
      .returning();
    if (!device) throw new Error('device fixture insert failed');
    return device;
  }

  async function makeApprovedPatch(deviceId: string) {
    const [patch] = await getTestDb()
      .insert(patches)
      .values({ source: 'microsoft', externalId: `KB${randomUUID().slice(0, 8)}`, title: '8909 patch', requiresReboot: false })
      .returning();
    if (!patch) throw new Error('patch fixture insert failed');
    await getTestDb().insert(devicePatches).values({
      deviceId,
      patchId: patch.id,
      orgId: env.organization.id,
      status: 'pending',
    });
    // Partner-wide manual approval (ring_id NULL): admits the patch under any
    // ring of this partner, so the only thing deciding the outcome is the ring.
    await getTestDb().insert(patchApprovals).values({
      partnerId: env.partner.id,
      patchId: patch.id,
      status: 'approved',
      approvedAt: new Date(),
    });
    return patch;
  }

  async function makeJob(
    ringId: string | null,
    deviceIds: string[],
    status: 'scheduled' | 'running',
  ) {
    const [job] = await getTestDb()
      .insert(patchJobs)
      .values({
        orgId: env.organization.id,
        ringId,
        name: '8909 ring job',
        status,
        patches: { ringId, autoApprove: {} },
        targets: {
          deviceIds,
          deployment: { rebootPolicy: 'never', offlineBehavior: 'queue' },
          scheduleNextOccurrenceAt: new Date(Date.now() + 6 * HOUR_MS).toISOString(),
        },
        devicesTotal: deviceIds.length,
        devicesPending: deviceIds.length,
        ...(status === 'running' ? { startedAt: new Date() } : { scheduledAt: new Date() }),
      })
      .returning();
    if (!job) throw new Error('patch job fixture insert failed');
    return job;
  }

  async function jobRow(jobId: string) {
    const [row] = await getTestDb().select().from(patchJobs).where(eq(patchJobs.id, jobId)).limit(1);
    return row;
  }

  async function resultRows(jobId: string) {
    return getTestDb().select().from(patchJobResults).where(eq(patchJobResults.jobId, jobId));
  }

  async function installCommands(deviceId: string) {
    return getTestDb()
      .select()
      .from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'install_patches')));
  }

  async function setRingEnabled(ringId: string, enabled: boolean) {
    await getTestDb().update(patchPolicies).set({ enabled }).where(eq(patchPolicies.id, ringId));
  }

  function dispatchDevice(jobId: string, deviceId: string) {
    // NOT wrapped in asSystem: processExecuteDevice opens its own system
    // transaction, and the race cases need it to be a separate one.
    return patchExecutorTestOnly.processExecuteDevice({
      type: 'execute-patch-job-device',
      patchJobId: jobId,
      deviceId,
      orgId: env.organization.id,
    }) as Promise<{ kind?: string; reason?: string }>;
  }

  /** The route's transaction shape: disable the ring, then sweep, in one transaction. */
  function deleteRing(ringId: string) {
    return asSystem(async () => {
      await db.update(patchPolicies).set({ enabled: false, updatedAt: new Date() }).where(eq(patchPolicies.id, ringId));
      return cancelQueuedRingPatchWork(ringId, 'ring_deleted');
    });
  }

  describe('dispatch-time check (patchJobExecutor)', () => {
    it('a device dispatched after its ring was deleted is skipped with ring_unavailable and gets no command', async () => {
      const ring = await makeRing();
      const device = await makeDevice('offline');
      await makeApprovedPatch(device.id);
      const job = await makeJob(ring.id, [device.id], 'running');

      await setRingEnabled(ring.id, false);
      const outcome = await dispatchDevice(job.id, device.id);

      expect(outcome.kind).toBe('skipped');
      expect(await installCommands(device.id)).toHaveLength(0);
      const rows = await resultRows(job.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('skipped');
      expect(rows[0]?.errorMessage).toBe('ring_unavailable');
      const after = await jobRow(job.id);
      expect(after?.devicesPending).toBe(0);
      expect(after?.status).toBe('completed');
    });

    it('control: the same dispatch against an enabled ring queues the install', async () => {
      const ring = await makeRing();
      const device = await makeDevice('offline');
      await makeApprovedPatch(device.id);
      const job = await makeJob(ring.id, [device.id], 'running');

      const outcome = await dispatchDevice(job.id, device.id);

      expect(outcome.kind).toBe('queued');
      expect(await installCommands(device.id)).toHaveLength(1);
    });

    it('RACE: a dispatch that starts while a delete is uncommitted waits for it and then skips', async () => {
      const ring = await makeRing();
      const device = await makeDevice('offline');
      await makeApprovedPatch(device.id);
      const job = await makeJob(ring.id, [device.id], 'running');

      let releaseDelete!: () => void;
      const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });

      // A delete in flight: the ring row is written but not yet committed.
      const deleter = getTestDb().transaction(async (tx) => {
        await tx.update(patchPolicies).set({ enabled: false }).where(eq(patchPolicies.id, ring.id));
        signalLocked();
        await deleteGate;
      });
      await locked;

      let dispatchSettled = false;
      const dispatch = dispatchDevice(job.id, device.id).finally(() => { dispatchSettled = true; });

      // Without the dispatch-time row lock the executor reads the last
      // COMMITTED ring (still enabled) and dispatches immediately.
      await sleep(750);
      const settledWhileDeleteOpen = dispatchSettled;
      // Release before asserting, so a failure cannot strand an open
      // transaction that blocks the suite's cleanup.
      releaseDelete();
      await deleter;
      const outcome = await dispatch;
      expect(settledWhileDeleteOpen).toBe(false);

      expect(outcome.kind).toBe('skipped');
      expect(await installCommands(device.id)).toHaveLength(0);
      const rows = await resultRows(job.id);
      expect(rows.map((r) => r.errorMessage)).toEqual(['ring_unavailable']);
    });
  });

  describe('delete-time sweep (cancelQueuedRingPatchWork)', () => {
    it('cancels a scheduled job and records ring_deleted for each target device', async () => {
      const ring = await makeRing();
      const otherRing = await makeRing();
      const d1 = await makeDevice();
      const d2 = await makeDevice();
      const job = await makeJob(ring.id, [d1.id, d2.id], 'scheduled');
      const untouched = await makeJob(otherRing.id, [d1.id], 'scheduled');

      const result = await deleteRing(ring.id);

      expect(result.cancelledJobIds).toEqual([job.id]);
      const after = await jobRow(job.id);
      expect(after?.status).toBe('cancelled');
      expect(after?.completedAt).toBeInstanceOf(Date);
      expect(after?.devicesPending).toBe(0);
      const rows = await resultRows(job.id);
      expect(rows.map((r) => r.deviceId).sort()).toEqual([d1.id, d2.id].sort());
      expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['skipped']));
      expect(new Set(rows.map((r) => r.errorMessage))).toEqual(new Set(['ring_deleted']));

      expect((await jobRow(untouched.id))?.status).toBe('scheduled');
    });

    it('a target device that no longer exists does not fail the delete', async () => {
      const ring = await makeRing();
      const device = await makeDevice();
      const job = await makeJob(ring.id, [device.id, randomUUID(), 'not-a-uuid'], 'scheduled');

      const result = await deleteRing(ring.id);

      expect(result.cancelledJobIds).toEqual([job.id]);
      const rows = await resultRows(job.id);
      expect(rows.map((r) => r.deviceId)).toEqual([device.id]);
      expect((await jobRow(job.id))?.status).toBe('cancelled');
    });

    it('cancels an install queued for an offline device but leaves a delivered one running', async () => {
      const ring = await makeRing();
      const queuedDevice = await makeDevice('offline');
      const deliveredDevice = await makeDevice('offline');
      await makeApprovedPatch(queuedDevice.id);
      await makeApprovedPatch(deliveredDevice.id);
      const job = await makeJob(ring.id, [queuedDevice.id, deliveredDevice.id], 'running');

      expect((await dispatchDevice(job.id, queuedDevice.id)).kind).toBe('queued');
      expect((await dispatchDevice(job.id, deliveredDevice.id)).kind).toBe('queued');
      // The second device came online and its heartbeat took the install.
      const [delivered] = await installCommands(deliveredDevice.id);
      await getTestDb().update(deviceCommands).set({ status: 'sent' }).where(eq(deviceCommands.id, delivered!.id));

      const result = await deleteRing(ring.id);

      expect(result.cancelledJobIds).toEqual([]);
      expect(result.cancelledInstallCount).toBe(1);

      const [queuedCmd] = await installCommands(queuedDevice.id);
      expect(queuedCmd?.status).toBe('cancelled');
      expect((queuedCmd?.result as { reason?: string } | null)?.reason).toBe('ring_deleted');
      const [deliveredCmd] = await installCommands(deliveredDevice.id);
      expect(deliveredCmd?.status).toBe('sent');

      const rows = await resultRows(job.id);
      const byDevice = new Map(rows.map((r) => [r.deviceId, r]));
      expect(byDevice.get(queuedDevice.id)?.status).toBe('skipped');
      expect(byDevice.get(queuedDevice.id)?.errorMessage).toBe('ring_deleted');
      expect(byDevice.get(deliveredDevice.id)?.status).toBe('queued');

      const after = await jobRow(job.id);
      expect(after?.devicesQueued).toBe(1);
      expect(after?.status).toBe('running');
    });

    it('does nothing while the ring is still enabled', async () => {
      const ring = await makeRing();
      const device = await makeDevice();
      const job = await makeJob(ring.id, [device.id], 'scheduled');

      const result = await asSystem(() => cancelQueuedRingPatchWork(ring.id, 'ring_disabled'));

      expect(result).toEqual({ cancelledJobIds: [], cancelledInstallCount: 0 });
      expect((await jobRow(job.id))?.status).toBe('scheduled');
    });

    it('re-enabling the ring does not resurrect a cancelled job', async () => {
      const ring = await makeRing();
      const device = await makeDevice();
      const job = await makeJob(ring.id, [device.id], 'scheduled');

      await deleteRing(ring.id);
      await setRingEnabled(ring.id, true);

      expect((await jobRow(job.id))?.status).toBe('cancelled');
    });

    it('RACE: an install committed by a dispatch that held the ring before the delete is still cancelled', async () => {
      const ring = await makeRing();
      const device = await makeDevice('offline');
      const job = await makeJob(ring.id, [device.id], 'running');

      let releaseDispatch!: () => void;
      const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });

      // An executor mid-dispatch: holds the ring FOR SHARE (as the executor
      // does) and has written, but not committed, an offline install.
      const dispatcher = getTestDb().transaction(async (tx) => {
        await tx.select({ id: patchPolicies.id }).from(patchPolicies).where(eq(patchPolicies.id, ring.id)).for('share');
        await tx.insert(deviceCommands).values({
          deviceId: device.id,
          type: 'install_patches',
          status: 'pending',
          payload: { patchJobId: job.id, patchIds: [] },
          deliverBy: new Date(Date.now() + HOUR_MS),
          submittedOrgId: env.organization.id,
        });
        await tx.insert(patchJobResults).values({ jobId: job.id, deviceId: device.id, patchId: null, status: 'queued' });
        await tx.update(patchJobs).set({ devicesPending: 0, devicesQueued: 1 }).where(eq(patchJobs.id, job.id));
        signalLocked();
        await dispatchGate;
      });
      await locked;

      let deleteSettled = false;
      const deletion = deleteRing(ring.id).finally(() => { deleteSettled = true; });
      await sleep(750);
      const settledWhileDispatchOpen = deleteSettled;
      releaseDispatch();
      await dispatcher;
      const result = await deletion;
      // The delete waited for the in-flight dispatch rather than sweeping past it.
      expect(settledWhileDispatchOpen).toBe(false);

      expect(result.cancelledInstallCount).toBe(1);
      const [cmd] = await installCommands(device.id);
      expect(cmd?.status).toBe('cancelled');
      const rows = await resultRows(job.id);
      expect(rows.map((r) => [r.status, r.errorMessage])).toEqual([['skipped', 'ring_deleted']]);
      expect((await jobRow(job.id))?.status).toBe('completed');
    });
  });
});
