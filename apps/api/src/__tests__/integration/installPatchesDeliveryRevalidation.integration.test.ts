import './setup';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Count every step outside the ambient DB context taken WHILE a context is
// held. `runOutsideDbContext` is the first step of every system-context
// escalation (`readOwnPartnerAxisRows`, `readWithPartnerAxisVisibility`), each
// of which borrows a SECOND pooled connection while the claim still holds its
// own (#1105). The eligibility reads must stay on the claim's connection.
// Work deferred until the claim's context has exited (the cancel path's
// automation-action terminaliser, `runAfterDbContextExit`) holds nothing and
// is not counted.
const dbSpy = vi.hoisted(() => ({ outside: 0 }));
vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  return {
    ...actual,
    runOutsideDbContext: ((fn: () => unknown) => {
      if (actual.getCurrentDbAccessContext() !== undefined) dbSpy.outside += 1;
      return (actual.runOutsideDbContext as (f: () => unknown) => unknown)(fn);
    }) as typeof actual.runOutsideDbContext,
  };
});

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyPatchSettings,
  configurationPolicies,
  deviceCommands,
  deviceHardware,
  deviceOemUpdateStatus,
  devicePatches,
  devices,
  patchApprovals,
  patchJobResults,
  patchJobs,
  patchPolicies,
  patches,
} from '../../db/schema';
import { __testOnly as patchExecutorTestOnly } from '../../jobs/patchJobExecutor';
import { claimPendingCommandForDelivery, claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { computeOccurrence } from '../../services/oemUpdates/occurrence';
import { REQUESTED_PATCHES_NO_LONGER_ELIGIBLE } from '../../services/installPatchesRevalidation';
import { createOrganization, createPartner, deviceAgentId, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * #12493 — a queued `install_patches` from a job that names its patches (the
 * AI `manage_patches` install) is re-judged at delivery under the device's
 * LIVE policy and ring. If any delivered patch is no longer eligible the
 * whole command is cancelled (the approval pinned that exact set); otherwise
 * it is delivered. Every claim below runs as `breeze_app` under the context
 * the agent heartbeat builds (org-scoped, `currentPartnerId` = the device
 * org's partner), so the RLS visibility of every table the resolver reads is
 * what decides the outcome — mocks cannot.
 */

const AGENT_CAPS = {
  peripheralPolicyProtocolVersion: 2,
  rollbackProtocolVersion: 1,
  pamLifetimeProtocolVersion: 2,
} as const;

const AUTO_APPROVE_CRITICAL = { enabled: true, severities: ['critical'] };

type RingOpts = {
  autoApprove?: Record<string, unknown>;
  excludeCategories?: string[];
  partnerId?: string;
};

describe('install_patches delivery revalidation (#12493) — real PostgreSQL, agent claim context', () => {
  let env: Awaited<ReturnType<typeof setupTestEnvironment>>;

  beforeEach(async () => {
    dbSpy.outside = 0;
    env = await setupTestEnvironment({ scope: 'organization' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function agentContext(): DbAccessContext {
    // The exact shape middleware/agentAuth.ts builds for a heartbeat.
    return {
      scope: 'organization',
      orgId: env.organization.id,
      accessibleOrgIds: [env.organization.id],
      accessiblePartnerIds: [],
      currentPartnerId: env.partner.id,
    };
  }

  async function makeRing(opts: RingOpts = {}) {
    const [ring] = await getTestDb()
      .insert(patchPolicies)
      .values({
        partnerId: opts.partnerId ?? env.partner.id,
        kind: 'ring',
        name: `reval ring ${randomUUID().slice(0, 8)}`,
        deferralDays: 0,
        autoApprove: opts.autoApprove ?? {},
        categoryRules: [],
        excludeCategories: opts.excludeCategories ?? [],
        appRules: [],
      })
      .returning();
    if (!ring) throw new Error('ring fixture insert failed');
    return ring;
  }

  /**
   * A PARTNER-WIDE configuration policy (org_id NULL) linking `ringId`,
   * assigned at `level`. Partner-wide on purpose: the agent context reads it
   * only through the own-partner SELECT branch, so an invisible read would
   * resolve "no policy" and flip the control to a false cancel.
   */
  async function linkPolicy(ringId: string, level: 'organization' | 'device', targetId: string, partnerWide = true) {
    return withSystemDbAccessContext(async () => {
      const [policy] = await db
        .insert(configurationPolicies)
        .values({
          orgId: partnerWide ? null : env.organization.id,
          partnerId: partnerWide ? env.partner.id : null,
          name: `reval policy ${randomUUID().slice(0, 8)}`,
          status: 'active',
        })
        .returning({ id: configurationPolicies.id });
      const [link] = await db
        .insert(configPolicyFeatureLinks)
        .values({ configPolicyId: policy!.id, featureType: 'patch', featurePolicyId: ringId, inlineSettings: {} })
        .returning({ id: configPolicyFeatureLinks.id });
      await db.insert(configPolicyPatchSettings).values({ featureLinkId: link!.id, sources: ['os'] });
      await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level, targetId, priority: 0 });
      return policy!;
    });
  }

  async function makeDevice() {
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `reval-${randomUUID()}`,
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

  async function makeOutstandingPatch(deviceId: string, over: { severity?: string; category?: string } = {}) {
    const [patch] = await getTestDb()
      .insert(patches)
      .values({
        source: 'microsoft',
        externalId: `KB${randomUUID().slice(0, 8)}`,
        title: 'reval patch',
        severity: (over.severity ?? 'critical') as 'critical',
        category: over.category ?? 'security',
        releaseDate: '2020-01-01',
        requiresReboot: false,
      })
      .returning();
    if (!patch) throw new Error('patch fixture insert failed');
    await getTestDb().insert(devicePatches).values({ deviceId, patchId: patch.id, orgId: env.organization.id, status: 'pending' });
    return patch;
  }

  /** The partner-wide decision for a patch, replacing any earlier one (one row per partner+patch+ring). */
  async function decide(patchId: string, status: 'approved' | 'rejected') {
    await getTestDb()
      .delete(patchApprovals)
      .where(and(eq(patchApprovals.partnerId, env.partner.id), eq(patchApprovals.patchId, patchId)));
    await getTestDb().insert(patchApprovals).values({
      partnerId: env.partner.id,
      patchId,
      ringId: null,
      status,
      ...(status === 'approved' ? { approvedAt: new Date() } : {}),
      updatedAt: new Date(),
    });
  }

  async function makeJob(patchesConfig: Record<string, unknown>, deviceIds: string[]) {
    const [job] = await getTestDb()
      .insert(patchJobs)
      .values({
        orgId: env.organization.id,
        name: `reval job ${new Date().toISOString()}`,
        patches: patchesConfig,
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
    return patchExecutorTestOnly.processExecuteDevice({
      type: 'execute-patch-job-device',
      patchJobId: jobId,
      deviceId,
      orgId: env.organization.id,
    }) as Promise<{ kind?: string }>;
  }

  async function installCommand(deviceId: string) {
    const rows = await getTestDb()
      .select()
      .from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'install_patches')));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function commandRow(id: string) {
    const [row] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, id)).limit(1);
    return row!;
  }

  async function jobRow(id: string) {
    const [row] = await getTestDb().select().from(patchJobs).where(eq(patchJobs.id, id)).limit(1);
    return row!;
  }

  async function resultRows(jobId: string) {
    return getTestDb().select().from(patchJobResults).where(eq(patchJobResults.jobId, jobId));
  }

  async function claimAsAgent(deviceId: string) {
    return withDbAccessContext(agentContext(), async () =>
      claimPendingCommandsForDevice(
        { deviceId, agentId: await deviceAgentId(deviceId), installIncarnation: 1 },
        10,
        'agent',
        undefined,
        { ...AGENT_CAPS },
      ),
    );
  }

  /**
   * The standard fixture: a partner-wide policy at org level linking a ring
   * that auto-approves critical patches; P1 is admitted by the ring's
   * auto-approve, P2 (low severity) only by a partner-wide manual approval.
   * The AI job names both, and the device is offline, so the install queues.
   */
  async function queuedAiInstall() {
    const ring = await makeRing({ autoApprove: AUTO_APPROVE_CRITICAL });
    await linkPolicy(ring.id, 'organization', env.organization.id);
    const device = await makeDevice();
    const p1 = await makeOutstandingPatch(device.id, { severity: 'critical', category: 'security' });
    const p2 = await makeOutstandingPatch(device.id, { severity: 'low', category: 'definitions' });
    await decide(p2.id, 'approved');
    const job = await makeJob({ patchIds: [p1.id, p2.id] }, [device.id]);

    expect((await dispatchDevice(job.id, device.id)).kind).toBe('queued');
    const cmd = await installCommand(device.id);
    expect(cmd.status).toBe('pending');
    expect([...((cmd.payload as { patchIds: string[] }).patchIds)].sort()).toEqual([p1.id, p2.id].sort());
    expect((await jobRow(job.id)).devicesQueued).toBe(1);
    return { ring, device, p1, p2, job, cmd };
  }

  async function expectCancelledWith(jobId: string, commandId: string, droppedIds: string[]) {
    const row = await commandRow(commandId);
    expect(row.status).toBe('cancelled');
    expect(row.result).toMatchObject({
      status: 'cancelled',
      reason: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
      cancelledBy: 'claim_eligibility',
      detail: { ineligiblePatchIds: [...droppedIds].sort() },
    });
    // The finalizer closed every queued per-patch row with the reason and
    // moved the device out of the queue exactly once.
    const rows = await resultRows(jobId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('skipped');
      expect(r.errorMessage).toBe(REQUESTED_PATCHES_NO_LONGER_ELIGIBLE);
    }
    const job = await jobRow(jobId);
    expect(job.devicesQueued).toBe(0);
    expect(job.devicesPending).toBe(0);
    expect(job.devicesCompleted).toBe(1);
    expect(job.status).not.toBe('running');
  }

  // -------------------------------------------------------------------------
  // The claim context itself (task 4): non-bypass role, partner-axis reads in
  // place, a foreign partner's ring invisible.
  // -------------------------------------------------------------------------

  it('the claim connection is breeze_app without BYPASSRLS and sees only its own partner\'s rings', async () => {
    const own = await makeRing();
    const otherPartner = await createPartner();
    await createOrganization({ partnerId: otherPartner.id });
    const foreign = await makeRing({ partnerId: otherPartner.id });

    const probe = await withDbAccessContext(agentContext(), async () => {
      const [role] = (await db.execute(
        sql`SELECT current_user AS who, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
      )) as unknown as Array<{ who: string; bypass: boolean }>;
      const visible = await db
        .select({ id: patchPolicies.id })
        .from(patchPolicies)
        .where(sql`${patchPolicies.id} IN (${own.id}::uuid, ${foreign.id}::uuid)`);
      return { role, visible: visible.map((r) => r.id) };
    });

    expect(probe.role).toEqual({ who: 'breeze_app', bypass: false });
    expect(probe.visible).toEqual([own.id]);
  });

  // -------------------------------------------------------------------------
  // Heartbeat leg
  // -------------------------------------------------------------------------

  it('CONTROL: nothing changed — the install is delivered, with every read on the claim connection', async () => {
    const { job, cmd } = await queuedAiInstall();

    dbSpy.outside = 0;
    const claimed = await claimAsAgent(cmd.deviceId);

    expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
    expect((await commandRow(cmd.id)).status).toBe('sent');
    expect(dbSpy.outside).toBe(0);
    expect((await jobRow(job.id)).devicesQueued).toBe(1);
  });

  it('(a) a patch the ring auto-approves is declined after dispatch — the whole install is cancelled', async () => {
    const { job, cmd, p1 } = await queuedAiInstall();
    await decide(p1.id, 'rejected');

    dbSpy.outside = 0;
    const claimed = await claimAsAgent(cmd.deviceId);

    expect(claimed).toEqual([]);
    expect(dbSpy.outside).toBe(0);
    await expectCancelledWith(job.id, cmd.id, [p1.id]);
  });

  it('(b) the device ring gains a rule that blocks a delivered patch — the whole install is cancelled', async () => {
    const { job, cmd, ring, p2 } = await queuedAiInstall();
    await getTestDb().update(patchPolicies).set({ excludeCategories: ['definitions'] }).where(eq(patchPolicies.id, ring.id));

    const claimed = await claimAsAgent(cmd.deviceId);

    expect(claimed).toEqual([]);
    await expectCancelledWith(job.id, cmd.id, [p2.id]);
  });

  it('(c) the device moves to a stricter ring — the whole install is cancelled', async () => {
    const { job, cmd, device, p1 } = await queuedAiInstall();
    // A device-level assignment beats the org-level one: the device now
    // resolves to a ring with no auto-approve that excludes security.
    const strict = await makeRing({ excludeCategories: ['security'] });
    await linkPolicy(strict.id, 'device', device.id);

    const claimed = await claimAsAgent(cmd.deviceId);

    expect(claimed).toEqual([]);
    await expectCancelledWith(job.id, cmd.id, [p1.id]);
  });

  it('a claim context without the partner axis HOLDS the install instead of judging it on rows it cannot see', async () => {
    const { job, cmd } = await queuedAiInstall();

    const claimed = await withDbAccessContext({ ...agentContext(), currentPartnerId: null }, async () =>
      claimPendingCommandsForDevice(
        { deviceId: cmd.deviceId, agentId: await deviceAgentId(cmd.deviceId), installIncarnation: 1 },
        10,
        'agent',
        undefined,
        { ...AGENT_CAPS },
      ),
    );

    expect(claimed).toEqual([]);
    const row = await commandRow(cmd.id);
    expect(row.status).toBe('pending');
    expect(row.result).toBeNull();
    expect((await jobRow(job.id)).devicesQueued).toBe(1);
  });

  it('a row queued before this change (no evaluationRingId) is found by its patchJobId and revalidated', async () => {
    const { job, cmd, p1 } = await queuedAiInstall();
    const payload = { ...(cmd.payload as Record<string, unknown>) };
    delete payload.evaluationRingId;
    await getTestDb().update(deviceCommands).set({ payload }).where(eq(deviceCommands.id, cmd.id));
    await decide(p1.id, 'rejected');

    expect(await claimAsAgent(cmd.deviceId)).toEqual([]);
    await expectCancelledWith(job.id, cmd.id, [p1.id]);
  });

  // -------------------------------------------------------------------------
  // Push leg (dispatchDeviceCommand → claimPendingCommandForDelivery)
  // -------------------------------------------------------------------------

  it('push leg: nothing changed — a no-op, the row is claimed', async () => {
    const { cmd } = await queuedAiInstall();

    const outcome = await claimPendingCommandForDelivery(cmd.id);

    expect(outcome.status).toBe('claimed');
    expect((await commandRow(cmd.id)).status).toBe('sent');
  });

  it('push leg: a declined patch cancels once, and a later heartbeat does not cancel or count it again', async () => {
    const { job, cmd, p1 } = await queuedAiInstall();
    await decide(p1.id, 'rejected');

    const outcome = await claimPendingCommandForDelivery(cmd.id);
    expect(outcome).toMatchObject({ status: 'cancelled', reason: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE });
    await expectCancelledWith(job.id, cmd.id, [p1.id]);

    expect(await claimAsAgent(cmd.deviceId)).toEqual([]);
    await expectCancelledWith(job.id, cmd.id, [p1.id]);
  });

  // -------------------------------------------------------------------------
  // Unchanged behaviour
  // -------------------------------------------------------------------------

  it('a job without a patch list (scheduled / ring / config-policy) is delivered exactly as today, even after a decline', async () => {
    const ring = await makeRing({ autoApprove: AUTO_APPROVE_CRITICAL });
    await linkPolicy(ring.id, 'organization', env.organization.id);
    const device = await makeDevice();
    const p2 = await makeOutstandingPatch(device.id, { severity: 'low', category: 'definitions' });
    await decide(p2.id, 'approved');
    // A frozen ring-less snapshot: only the manual approval admits P2.
    const job = await makeJob({}, [device.id]);
    expect((await dispatchDevice(job.id, device.id)).kind).toBe('queued');
    const cmd = await installCommand(device.id);
    await decide(p2.id, 'rejected');

    const claimed = await claimAsAgent(device.id);

    expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
    expect((await commandRow(cmd.id)).status).toBe('sent');
  });

  it('a technician\'s direct install (no patchJobId) is delivered exactly as today', async () => {
    const device = await makeDevice();
    const p1 = await makeOutstandingPatch(device.id);
    await decide(p1.id, 'rejected');
    const [cmd] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'install_patches',
        payload: { patchIds: [p1.id] },
        status: 'pending',
        targetRole: 'agent',
        submittedOrgId: env.organization.id,
        deliverBy: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();

    const claimed = await claimAsAgent(device.id);

    expect(claimed.map((c) => c.id)).toEqual([cmd!.id]);
  });

  it('a command whose patch job row is missing is HELD (fail closed, not cancelled, not delivered)', async () => {
    const device = await makeDevice();
    const p1 = await makeOutstandingPatch(device.id);
    const [cmd] = await getTestDb()
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: 'install_patches',
        payload: { patchJobId: randomUUID(), patchIds: [p1.id] },
        status: 'pending',
        targetRole: 'agent',
        submittedOrgId: env.organization.id,
        deliverBy: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();

    const claimed = await claimAsAgent(device.id);

    expect(claimed).toEqual([]);
    const row = await commandRow(cmd!.id);
    expect(row.status).toBe('pending');
    expect(row.result).toBeNull();
  });
  // -------------------------------------------------------------------------
  // Vendor lane: the one read path the fixtures above never reach. A driver
  // that a vendor lane starts delivering after dispatch is left to the lane
  // (`managed_by_vendor_updates`); proving it here proves the lane tables
  // (`device_oem_update_status`, the partner-wide `oem_updates` link,
  // `device_hardware`) are readable on the agent's claim connection.
  // -------------------------------------------------------------------------

  it('a driver a Dell lane starts delivering after dispatch cancels the install, read in place on the claim', async () => {
    const OEM_SCHEDULE = { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 } as const;
    const ring = await makeRing();
    await linkPolicy(ring.id, 'organization', env.organization.id);
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `reval-lane-${randomUUID()}`,
        hostname: `lane-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '0.127.0',
        status: 'offline',
      })
      .returning();
    await getTestDb().insert(deviceHardware).values({
      deviceId: device!.id, orgId: env.organization.id, manufacturer: 'Dell Inc.', model: 'Latitude 7420', biosVersion: '1.20.0',
    });
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', device!.id);
    // A partner-wide Vendor updates policy with the Dell driver class armed.
    await withSystemDbAccessContext(async () => {
      const [policy] = await db
        .insert(configurationPolicies)
        .values({ orgId: null, partnerId: env.partner.id, name: `vendor updates ${randomUUID()}`, status: 'active' })
        .returning({ id: configurationPolicies.id });
      await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id,
        featureType: 'oem_updates',
        inlineSettings: {
          version: 1,
          enabled: true,
          schedule: OEM_SCHEDULE,
          catchUpNights: 7,
          reboot: 'overnight',
          vendors: { dell: { enabled: true, categories: { bios: true, firmware: true, driver: true }, blockedUpdateIds: [] } },
        },
      });
      await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'partner', targetId: env.partner.id });
    });
    const [driver] = await getTestDb()
      .insert(patches)
      .values({
        source: 'microsoft', externalId: `wu-${randomUUID()}`, title: 'Dell Inc. - Display', severity: 'low' as 'critical',
        category: 'driver', releaseDate: '2020-01-01', requiresReboot: false,
      })
      .returning();
    await getTestDb().insert(devicePatches).values({
      deviceId: device!.id, patchId: driver!.id, orgId: env.organization.id, status: 'pending',
      reportedUpdateType: 'driver', reportedUpdateOwner: 'dell',
    });
    await decide(driver!.id, 'approved');
    const job = await makeJob({ patchIds: [driver!.id] }, [device!.id]);
    // No lane has delivered yet, so the approved driver is Windows Update's.
    expect((await dispatchDevice(job.id, device!.id)).kind).toBe('queued');
    const cmd = await installCommand(device!.id);

    // The lane completes this occurrence: it now owns the driver class.
    const now = new Date();
    const [run] = await getTestDb().insert(deviceCommands).values({
      deviceId: device!.id,
      type: 'oem_update_run',
      payload: { lane: 'dell', trigger: 'scheduled', categories: ['bios', 'firmware', 'driver'] },
      status: 'completed',
      submittedOrgId: env.organization.id,
      result: {
        stdout: JSON.stringify({
          lane: 'dell', outcome: 'success', toolVersion: '5.7.2', rawExitCode: 0, errorCode: null,
          rebootRequired: false, shutdownRequired: false, items: [], skippedCategories: [], takeover: 'ok',
        }),
      },
    }).returning({ id: deviceCommands.id });
    await getTestDb().insert(deviceOemUpdateStatus).values({
      lastCommandId: run!.id,
      deviceId: device!.id,
      orgId: env.organization.id,
      lane: 'dell',
      applicability: 'applicable',
      occurrenceKey: computeOccurrence({ ...OEM_SCHEDULE, catchUpNights: 7 }, 'UTC', now).occurrenceKey,
      attempts: 1,
      lastOutcome: 'success',
      lastAttemptAt: now,
      lastSuccessAt: now,
      firstCompletedAt: now,
    });

    dbSpy.outside = 0;
    const claimed = await claimAsAgent(device!.id);

    expect(claimed.filter((c) => c.type === 'install_patches')).toEqual([]);
    expect(dbSpy.outside).toBe(0);
    const row = await commandRow(cmd.id);
    expect(row.status).toBe('cancelled');
    expect(row.result).toMatchObject({
      reason: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
      detail: { ineligiblePatchIds: [driver!.id] },
    });
  });
});
