import './setup';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyPatchSettings,
  configurationPolicies,
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
 * A patch job that names its patches (`patches.patchIds`, written by the AI
 * tool `manage_patches` action `install`) is judged under the device's CURRENT
 * patch policy and ring, the config the intent's effect digest pinned at
 * approval, and installs only the named patches. Real Postgres: the live
 * resolver's reads, the ring's FOR SHARE lock and the delete-time sweep all
 * run inside the executor's own transaction.
 */

type RingOpts = {
  autoApprove?: Record<string, unknown>;
  excludeCategories?: string[];
  appRules?: Array<{ source: string; packageId: string; action: 'block' }>;
  sources?: string[];
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('a job that names its patches is judged under the device\'s live policy — real PostgreSQL', () => {
  let env: Awaited<ReturnType<typeof setupTestEnvironment>>;

  beforeEach(async () => {
    env = await setupTestEnvironment({ scope: 'organization' });
  });

  /** A ring linked to the whole org through an active configuration policy. */
  async function makeRingPolicy(opts: RingOpts = {}) {
    return withSystemDbAccessContext(async () => {
      const [ring] = await db
        .insert(patchPolicies)
        .values({
          partnerId: env.partner.id,
          kind: 'ring',
          name: `requested ring ${randomUUID().slice(0, 8)}`,
          deferralDays: 0,
          autoApprove: opts.autoApprove ?? {},
          categoryRules: [],
          excludeCategories: opts.excludeCategories ?? [],
          appRules: opts.appRules ?? [],
        })
        .returning();
      const [policy] = await db
        .insert(configurationPolicies)
        .values({ orgId: env.organization.id, partnerId: null, name: 'requested patch policy', status: 'active' })
        .returning({ id: configurationPolicies.id });
      const [link] = await db
        .insert(configPolicyFeatureLinks)
        .values({ configPolicyId: policy!.id, featureType: 'patch', featurePolicyId: ring!.id, inlineSettings: {} })
        .returning({ id: configPolicyFeatureLinks.id });
      await db.insert(configPolicyPatchSettings).values({ featureLinkId: link!.id, sources: opts.sources ?? ['os'] });
      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy!.id, level: 'organization', targetId: env.organization.id, priority: 0,
      });
      return ring!;
    });
  }

  async function makeDevice() {
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `requested-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning();
    if (!device) throw new Error('device fixture insert failed');
    return device;
  }

  async function makeOutstandingPatch(
    deviceId: string,
    over: { source?: 'microsoft' | 'third_party'; category?: string; packageId?: string } = {},
  ) {
    const [patch] = await getTestDb()
      .insert(patches)
      .values({
        source: over.source ?? 'microsoft',
        externalId: `KB${randomUUID().slice(0, 8)}`,
        title: 'requested patch',
        severity: 'critical',
        category: over.category ?? 'security',
        packageId: over.packageId ?? null,
        releaseDate: '2020-01-01',
        requiresReboot: false,
      })
      .returning();
    if (!patch) throw new Error('patch fixture insert failed');
    await getTestDb().insert(devicePatches).values({
      deviceId, patchId: patch.id, orgId: env.organization.id, status: 'pending',
    });
    return patch;
  }

  async function approve(patchId: string, ringId: string | null = null) {
    await getTestDb().insert(patchApprovals).values({
      partnerId: env.partner.id, patchId, ringId, status: 'approved', approvedAt: new Date(),
    });
  }

  /** The exact row shape `manage_patches` action `install` inserts. */
  async function makeAiJob(patchIds: string[], deviceIds: string[]) {
    const [job] = await getTestDb()
      .insert(patchJobs)
      .values({
        orgId: env.organization.id,
        name: `AI-initiated patch install - ${new Date().toISOString()}`,
        patches: { patchIds },
        targets: { deviceIds },
        status: 'running',
        startedAt: new Date(),
        devicesTotal: deviceIds.length,
        devicesPending: deviceIds.length,
      })
      .returning();
    if (!job) throw new Error('patch job fixture insert failed');
    return job;
  }

  function dispatchDevice(jobId: string, deviceId: string) {
    // Not wrapped: processExecuteDevice opens its own system transaction.
    return patchExecutorTestOnly.processExecuteDevice({
      type: 'execute-patch-job-device',
      patchJobId: jobId,
      deviceId,
      orgId: env.organization.id,
    }) as Promise<{ kind?: string; reason?: string }>;
  }

  async function installCommands(deviceId: string) {
    return getTestDb()
      .select()
      .from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'install_patches')));
  }

  async function resultRows(jobId: string) {
    return getTestDb().select().from(patchJobResults).where(eq(patchJobResults.jobId, jobId));
  }

  async function expectSkipped(jobId: string, deviceId: string, reason: string) {
    expect(await installCommands(deviceId)).toHaveLength(0);
    const rows = await resultRows(jobId);
    expect(rows.map((r) => [r.status, r.errorMessage])).toEqual([['skipped', reason]]);
  }

  it('a patch the device ring auto-approves installs, and only the named one', async () => {
    const ring = await makeRingPolicy({ autoApprove: { enabled: true, severities: ['critical'] } });
    const device = await makeDevice();
    const named = await makeOutstandingPatch(device.id);
    await makeOutstandingPatch(device.id); // also auto-approved, not named
    const job = await makeAiJob([named.id], [device.id]);

    const outcome = await dispatchDevice(job.id, device.id);

    expect(outcome.kind).toBe('queued');
    const [cmd] = await installCommands(device.id);
    const payload = cmd?.payload as { patchIds?: string[]; evaluationRingId?: string };
    expect(payload.patchIds).toEqual([named.id]);
    expect(payload.evaluationRingId).toBe(ring.id);
  });

  it('a partner-wide-approved patch in a category the device ring excludes is not installed', async () => {
    await makeRingPolicy({ excludeCategories: ['security'] });
    const device = await makeDevice();
    const patch = await makeOutstandingPatch(device.id, { category: 'security' });
    await approve(patch.id);
    const job = await makeAiJob([patch.id], [device.id]);

    const outcome = await dispatchDevice(job.id, device.id);

    expect(outcome.kind).toBe('skipped');
    await expectSkipped(job.id, device.id, 'requested_patches_not_eligible');
  });

  it('a partner-wide-approved app the device ring blocks is not installed', async () => {
    await makeRingPolicy({
      sources: ['os', 'third_party'],
      appRules: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
    });
    const device = await makeDevice();
    const patch = await makeOutstandingPatch(device.id, { source: 'third_party', category: 'application', packageId: 'Mozilla.Firefox' });
    await approve(patch.id);
    const job = await makeAiJob([patch.id], [device.id]);

    const outcome = await dispatchDevice(job.id, device.id);

    expect(outcome.kind).toBe('skipped');
    await expectSkipped(job.id, device.id, 'requested_patches_not_eligible');
  });

  it('a device ring already disabled at dispatch fails closed: nothing installs, recorded as ring_unavailable', async () => {
    const ring = await makeRingPolicy({ autoApprove: { enabled: true, severities: ['critical'] } });
    const device = await makeDevice();
    const patch = await makeOutstandingPatch(device.id);
    await approve(patch.id); // partner-wide: would install under "no ring"
    const job = await makeAiJob([patch.id], [device.id]);
    await getTestDb().update(patchPolicies).set({ enabled: false }).where(eq(patchPolicies.id, ring.id));

    const outcome = await dispatchDevice(job.id, device.id);

    expect(outcome.kind).toBe('skipped');
    await expectSkipped(job.id, device.id, 'ring_unavailable');
  });

  it('RACE: a ring delete in flight when the device is dispatched makes the dispatch wait, then skip with ring_unavailable', async () => {
    const ring = await makeRingPolicy({ autoApprove: { enabled: true, severities: ['critical'] } });
    const device = await makeDevice();
    const patch = await makeOutstandingPatch(device.id);
    const job = await makeAiJob([patch.id], [device.id]);

    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const deleter = getTestDb().transaction(async (tx) => {
      await tx.update(patchPolicies).set({ enabled: false }).where(eq(patchPolicies.id, ring.id));
      signalLocked();
      await deleteGate;
    });
    await locked;

    let dispatchSettled = false;
    const dispatch = dispatchDevice(job.id, device.id).finally(() => { dispatchSettled = true; });
    // The live resolve reads the last COMMITTED ring (still enabled); only the
    // locking read makes the dispatch wait for the delete.
    await sleep(750);
    const settledWhileDeleteOpen = dispatchSettled;
    releaseDelete();
    await deleter;
    const outcome = await dispatch;
    expect(settledWhileDeleteOpen).toBe(false);

    expect(outcome.kind).toBe('skipped');
    await expectSkipped(job.id, device.id, 'ring_unavailable');
  });

  it('RACE: a ring edit committed while the dispatch waits on the ring lock is the rule set the dispatch uses', async () => {
    const ring = await makeRingPolicy({ autoApprove: { enabled: true, severities: ['critical'] } });
    const device = await makeDevice();
    const patch = await makeOutstandingPatch(device.id, { category: 'security' });
    const job = await makeAiJob([patch.id], [device.id]);

    let releaseEdit!: () => void;
    const editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    // An admin's edit in flight: the ring now excludes the patch's category,
    // written but not yet committed.
    const editor = getTestDb().transaction(async (tx) => {
      await tx.update(patchPolicies).set({ excludeCategories: ['security'] }).where(eq(patchPolicies.id, ring.id));
      signalLocked();
      await editGate;
    });
    await locked;

    let dispatchSettled = false;
    const dispatch = dispatchDevice(job.id, device.id).finally(() => { dispatchSettled = true; });
    // The first live read sees the committed (old) rules; the locking read waits.
    await sleep(750);
    const settledWhileEditOpen = dispatchSettled;
    releaseEdit();
    await editor;
    const outcome = await dispatch;
    expect(settledWhileEditOpen).toBe(false);

    expect(outcome.kind).toBe('skipped');
    await expectSkipped(job.id, device.id, 'requested_patches_not_eligible');
  });

  it('a device with no patch policy keeps the partner-wide-only rule', async () => {
    const otherRing = await makeRingPolicy(); // assigned to the org, then unassigned below
    await getTestDb().delete(configPolicyAssignments).where(eq(configPolicyAssignments.targetId, env.organization.id));
    const device = await makeDevice();
    const partnerWide = await makeOutstandingPatch(device.id);
    const ringScoped = await makeOutstandingPatch(device.id);
    await approve(partnerWide.id);
    await approve(ringScoped.id, otherRing.id);

    const ok = await makeAiJob([partnerWide.id], [device.id]);
    expect((await dispatchDevice(ok.id, device.id)).kind).toBe('queued');
    const [cmd] = await installCommands(device.id);
    const payload = cmd?.payload as { patchIds?: string[]; evaluationRingId?: string };
    expect(payload.patchIds).toEqual([partnerWide.id]);
    expect(payload).not.toHaveProperty('evaluationRingId');

    const device2 = await makeDevice();
    await getTestDb().insert(devicePatches).values({
      deviceId: device2.id, patchId: ringScoped.id, orgId: env.organization.id, status: 'pending',
    });
    const refused = await makeAiJob([ringScoped.id], [device2.id]);
    expect((await dispatchDevice(refused.id, device2.id)).kind).toBe('skipped');
    await expectSkipped(refused.id, device2.id, 'requested_patches_not_eligible');
  });

  it('deleting the ring that admitted a queued install cancels it (#8909 sweep)', async () => {
    const ring = await makeRingPolicy({ autoApprove: { enabled: true, severities: ['critical'] } });
    const device = await makeDevice();
    const patch = await makeOutstandingPatch(device.id);
    const job = await makeAiJob([patch.id], [device.id]);
    expect((await dispatchDevice(job.id, device.id)).kind).toBe('queued');

    const result = await withSystemDbAccessContext(async () => {
      await db.update(patchPolicies).set({ enabled: false, updatedAt: new Date() }).where(eq(patchPolicies.id, ring.id));
      return cancelQueuedRingPatchWork(ring.id, 'ring_deleted');
    });

    expect(result.cancelledInstallCount).toBe(1);
    const [cmd] = await installCommands(device.id);
    expect(cmd?.status).toBe('cancelled');
    const rows = await resultRows(job.id);
    expect(rows.map((r) => [r.status, r.errorMessage])).toEqual([['skipped', 'ring_deleted']]);
  });

  it('a stamped install whose job is no longer running is left alone by the sweep', async () => {
    const ring = await makeRingPolicy({ autoApprove: { enabled: true, severities: ['critical'] } });
    const device = await makeDevice();
    const patch = await makeOutstandingPatch(device.id);
    const job = await makeAiJob([patch.id], [device.id]);
    expect((await dispatchDevice(job.id, device.id)).kind).toBe('queued');
    await getTestDb().update(patchJobs).set({ status: 'completed' }).where(eq(patchJobs.id, job.id));

    const result = await withSystemDbAccessContext(async () => {
      await db.update(patchPolicies).set({ enabled: false }).where(eq(patchPolicies.id, ring.id));
      return cancelQueuedRingPatchWork(ring.id, 'ring_deleted');
    });

    expect(result.cancelledInstallCount).toBe(0);
    const [cmd] = await installCommands(device.id);
    expect(cmd?.status).toBe('pending');
  });

  it('a queued install of an unrelated job is left alone by another ring\'s delete', async () => {
    await makeRingPolicy({ autoApprove: { enabled: true, severities: ['critical'] } });
    const unrelated = await withSystemDbAccessContext(async () => {
      const [r] = await db.insert(patchPolicies).values({
        partnerId: env.partner.id, kind: 'ring', name: `unrelated ${randomUUID().slice(0, 8)}`, deferralDays: 0,
        autoApprove: {}, categoryRules: [],
      }).returning();
      return r!;
    });
    const device = await makeDevice();
    const patch = await makeOutstandingPatch(device.id);
    const job = await makeAiJob([patch.id], [device.id]);
    expect((await dispatchDevice(job.id, device.id)).kind).toBe('queued');

    const result = await withSystemDbAccessContext(async () => {
      await db.update(patchPolicies).set({ enabled: false }).where(eq(patchPolicies.id, unrelated.id));
      return cancelQueuedRingPatchWork(unrelated.id, 'ring_deleted');
    });

    expect(result.cancelledInstallCount).toBe(0);
    const [cmd] = await installCommands(device.id);
    expect(cmd?.status).toBe('pending');
  });
});
