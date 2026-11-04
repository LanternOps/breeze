/**
 * Missed-schedule catch-up (#11013) against real Postgres: the conditional
 * writes and the SQL filters that unit-test mocks cannot see. A dropped status
 * guard or an inverted window comparison would pass every mocked test.
 *
 * Stubbed: agent connectivity and the socket send, the dispatch expectation,
 * and the BullMQ add.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupCatchUp.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Frame = { id: string; type: string; payload: Record<string, unknown> };

const relay = vi.hoisted(() => ({ connected: false, frames: [] as Frame[] }));
const queued = vi.hoisted(() => ({ jobs: [] as Array<{ jobId: string; catchUpUntil: Date; configGeneration?: number }> }));

vi.mock('../../services/agentCommandRelay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agentCommandRelay')>()),
  isAgentConnectedAnywhere: vi.fn(async () => relay.connected),
  dispatchCommandToAgent: vi.fn(async (_agentId: string, command: Frame) => {
    relay.frames.push(command);
    return { status: 'sent', via: 'local' };
  }),
}));

vi.mock('../../services/agentWorkExpectation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agentWorkExpectation')>()),
  recordDispatchedExpectation: vi.fn(async () => undefined),
}));

vi.mock('../../jobs/backupEnqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/backupEnqueue')>()),
  enqueueBackupCatchUpDispatch: vi.fn(async (row: { jobId: string; catchUpUntil: Date; configGeneration?: number }) => {
    queued.jobs.push(row);
    return `backup-dispatch-${row.jobId}-catch-up`;
  }),
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  configPolicyAssignments,
  configPolicyBackupSettings,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
} from '../../db/schema';
import { isAgentConnectedAnywhere } from '../../services/agentCommandRelay';
import {
  BACKUP_CATCH_UP_NOT_STARTED_ERROR,
  BACKUP_MISSED_ERROR,
  deviceHasBackupCatchUp,
  dispatchBackupCatchUpJobs,
  dispatchCatchUpsForConnectedDevices,
  expireSupersededBackupCatchUps,
} from '../../jobs/backupCatchUp';
import { __testOnly } from '../../jobs/backupWorker';
import { reapStaleBackupJobs } from '../../jobs/staleCommandReaper';
import { createManualBackupJobIfIdle } from '../../services/backupJobCreation';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const HOUR = 3_600_000;
const fromNow = (ms: number) => new Date(Date.now() + ms);

const inSystemContext = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

type Seeded = {
  orgId: string;
  deviceId: string;
  agentId: string;
  configId: string;
  featureLinkId: string;
  policyId: string;
};

async function seedDevice(schedule: Record<string, unknown> = { frequency: 'daily', time: '05:00' }): Promise<Seeded> {
  const partner = await createPartner({ status: 'active' });
  const org = await createOrganization({ partnerId: partner.id, status: 'active' });
  const site = await createSite({ orgId: org.id });
  const suffix = randomUUID().slice(0, 8);
  const agentId = `agent-catch-up-${suffix}`;
  const db = getTestDb();
  const [device] = await db.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId,
    hostname: `host-catch-up-${suffix}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
    agentTokenHash: `hash-${suffix}`,
    enrolledAt: new Date(),
    // An older helper that has reported: dispatch goes straight out.
    backupReadProtocolVersion: 0,
    backupIntegrityProtocolVersion: 0,
    backupWriteProtocolVersion: 0,
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    orgId: org.id,
    name: `Local ${suffix}`,
    type: 'file',
    provider: 'local',
    providerConfig: { path: '/backups' },
  }).returning({ id: backupConfigs.id });
  const [policy] = await db.insert(configurationPolicies).values({
    orgId: org.id,
    name: `Policy ${suffix}`,
    status: 'active',
  }).returning({ id: configurationPolicies.id });
  const [link] = await db.insert(configPolicyFeatureLinks).values({
    configPolicyId: policy!.id,
    featureType: 'backup',
  }).returning({ id: configPolicyFeatureLinks.id });
  await db.insert(configPolicyBackupSettings).values({
    featureLinkId: link!.id,
    orgId: org.id,
    schedule,
    backupMode: 'file',
    targets: { paths: ['C:\\Data'] },
    destinationConfigId: config!.id,
  });
  // A real assignment: a catch-up re-resolves the device's winning backup link.
  await db.insert(configPolicyAssignments).values({
    configPolicyId: policy!.id,
    level: 'device',
    targetId: device!.id,
  });
  return {
    orgId: org.id,
    deviceId: device!.id,
    agentId,
    configId: config!.id,
    featureLinkId: link!.id,
    policyId: policy!.id,
  };
}

async function seedJob(t: Seeded, values: Partial<typeof backupJobs.$inferInsert> = {}): Promise<string> {
  const [job] = await getTestDb().insert(backupJobs).values({
    orgId: t.orgId,
    configId: t.configId,
    deviceId: t.deviceId,
    featureLinkId: t.featureLinkId,
    status: 'pending',
    type: 'scheduled',
    backupMode: 'file',
    modeTargets: { paths: ['C:\\Data'] },
    ...values,
  }).returning({ id: backupJobs.id });
  return job!.id;
}

async function jobRow(jobId: string) {
  const [row] = await getTestDb().select().from(backupJobs).where(eq(backupJobs.id, jobId));
  return row!;
}

const dispatchData = (t: Seeded, jobId: string, extra: Record<string, unknown> = {}) => ({
  type: 'dispatch-backup' as const,
  jobId,
  configId: t.configId,
  orgId: t.orgId,
  deviceId: t.deviceId,
  ...extra,
});

describe('missed-schedule backup catch-up', () => {
  beforeEach(() => {
    relay.connected = false;
    relay.frames.length = 0;
    queued.jobs.length = 0;
    vi.mocked(isAgentConnectedAnywhere).mockImplementation(async () => relay.connected);
  });

  it('ships the partial index the connect hook relies on', async () => {
    const indexes = await getTestDb().execute(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'backup_jobs_catch_up_device_idx'
    `);
    expect(JSON.stringify(indexes)).toContain('catch_up_until IS NOT NULL');
  });

  it('an offline device leaves the scheduled job pending with its window', async () => {
    const t = await seedDevice();
    const jobId = await seedJob(t);
    const until = fromNow(20 * HOUR);

    await expect(__testOnly.processDispatchBackup(
      dispatchData(t, jobId, { catchUpUntil: until.toISOString() }),
    )).resolves.toEqual({ dispatched: false });

    const row = await jobRow(jobId);
    expect(row.status).toBe('pending');
    expect(row.catchUpUntil?.toISOString()).toBe(until.toISOString());
    expect(row.errorLog).toBeNull();
    expect(relay.frames).toEqual([]);
  });

  it('carries the config generation the job was queued against through the wait (contract §3)', async () => {
    const t = await seedDevice();
    const jobId = await seedJob(t);

    await __testOnly.processDispatchBackup(
      dispatchData(t, jobId, { configGeneration: 1, catchUpUntil: fromNow(HOUR).toISOString() }),
    );
    expect((await jobRow(jobId)).catchUpConfigGeneration).toBe(1);

    await dispatchBackupCatchUpJobs(t.deviceId);
    expect(queued.jobs).toEqual([expect.objectContaining({ jobId, configGeneration: 1 })]);

    // The destination is edited while the job waits: the catch-up fails closed.
    await getTestDb().update(backupConfigs).set({ approvalGeneration: 2 }).where(eq(backupConfigs.id, t.configId));
    relay.connected = true;
    await __testOnly.processDispatchBackup(dispatchData(t, jobId, {
      configGeneration: 1, catchUpDispatch: true, catchUpUntil: fromNow(HOUR).toISOString(),
    }));

    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.errorLog).toBe('backup_config_changed');
    expect(relay.frames).toEqual([]);
  });

  it('never stamps a window on a job that is already over', async () => {
    const t = await seedDevice();
    const jobId = await seedJob(t, { status: 'cancelled', completedAt: new Date() });

    await __testOnly.processDispatchBackup(dispatchData(t, jobId, { catchUpUntil: fromNow(HOUR).toISOString() }));

    expect((await jobRow(jobId)).catchUpUntil).toBeNull();
  });

  it('the reconnect sweep picks up only this device\'s rows inside their window', async () => {
    const t = await seedDevice();
    const other = await seedDevice();
    const inside = await seedJob(t, { catchUpUntil: fromNow(HOUR) });
    await seedJob(t, { catchUpUntil: fromNow(-HOUR) }); // lapsed
    await seedJob(t, { status: 'failed', catchUpUntil: fromNow(HOUR) }); // settled
    await seedJob(t); // an ordinary pending job, not waiting
    await seedJob(other, { catchUpUntil: fromNow(HOUR) }); // someone else's

    await expect(dispatchBackupCatchUpJobs(t.deviceId)).resolves.toBe(1);

    expect(queued.jobs.map((j) => j.jobId)).toEqual([inside]);
  });

  it('the connect hook\'s EXISTS agrees with the sweep', async () => {
    const waiting = await seedDevice();
    const lapsed = await seedDevice();
    const idle = await seedDevice();
    await seedJob(waiting, { catchUpUntil: fromNow(HOUR) });
    await seedJob(lapsed, { catchUpUntil: fromNow(-HOUR) });
    await seedJob(idle);

    const read = async (deviceId: string) => {
      const [row] = await getTestDb()
        .select({ has: deviceHasBackupCatchUp() })
        .from(devices)
        .where(eq(devices.id, deviceId));
      return row!.has;
    };

    expect(await read(waiting.deviceId)).toBe(true);
    expect(await read(lapsed.deviceId)).toBe(false);
    expect(await read(idle.deviceId)).toBe(false);
  });

  it('a catch-up dispatch claims the row and sends the backup', async () => {
    const t = await seedDevice();
    const jobId = await seedJob(t, { catchUpUntil: fromNow(HOUR), createdAt: fromNow(-10 * HOUR) });
    relay.connected = true;

    await expect(__testOnly.processDispatchBackup(
      dispatchData(t, jobId, { catchUpDispatch: true, catchUpUntil: fromNow(HOUR).toISOString() }),
    )).resolves.toEqual({ dispatched: true });

    expect(relay.frames).toHaveLength(1);
    expect(relay.frames[0]).toMatchObject({ id: jobId, type: 'backup_run' });
    const row = await jobRow(jobId);
    expect(row.status).toBe('running');
    expect(row.catchUpUntil).toBeNull();

    // A second dispatch (a racing connect) finds nothing left to claim.
    relay.frames.length = 0;
    await __testOnly.processDispatchBackup(
      dispatchData(t, jobId, { catchUpDispatch: true, catchUpUntil: fromNow(HOUR).toISOString() }),
    );
    expect(relay.frames).toEqual([]);
  });

  it('a catch-up dispatch whose window closed on the way leaves the row to the reaper', async () => {
    const t = await seedDevice();
    const jobId = await seedJob(t, { catchUpUntil: fromNow(-60_000) });
    relay.connected = true;

    await __testOnly.processDispatchBackup(
      dispatchData(t, jobId, { catchUpDispatch: true, catchUpUntil: fromNow(-60_000).toISOString() }),
    );

    // Neither sent nor claimed: the reaper settles it, and cannot race a send.
    expect(relay.frames).toEqual([]);
    const row = await jobRow(jobId);
    expect(row.status).toBe('pending');
    expect(row.catchUpUntil).not.toBeNull();
  });

  it('a catch-up dispatch fails the job when its policy was deactivated meanwhile', async () => {
    const t = await seedDevice();
    const jobId = await seedJob(t, { catchUpUntil: fromNow(HOUR) });
    relay.connected = true;
    await getTestDb().update(configurationPolicies).set({ status: 'inactive' }).where(eq(configurationPolicies.id, t.policyId));

    await __testOnly.processDispatchBackup(
      dispatchData(t, jobId, { catchUpDispatch: true, catchUpUntil: fromNow(HOUR).toISOString() }),
    );

    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.errorLog).toMatch(/^Catch-up cancelled:/);
    expect(relay.frames).toEqual([]);
  });

  it('a catch-up dispatch fails the job when the toggle was turned off meanwhile', async () => {
    const t = await seedDevice({ frequency: 'daily', time: '05:00', runMissedBackupsOnConnect: false });
    const jobId = await seedJob(t, { catchUpUntil: fromNow(HOUR) });
    relay.connected = true;

    await __testOnly.processDispatchBackup(
      dispatchData(t, jobId, { catchUpDispatch: true, catchUpUntil: fromNow(HOUR).toISOString() }),
    );

    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.errorLog).toMatch(/^Catch-up cancelled:/);
    expect(relay.frames).toEqual([]);
  });

  it('a catch-up dispatch fails the job when the policy link was removed', async () => {
    const t = await seedDevice();
    const jobId = await seedJob(t, { catchUpUntil: fromNow(HOUR) });
    relay.connected = true;
    await getTestDb().delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, t.featureLinkId));

    await __testOnly.processDispatchBackup(
      dispatchData(t, jobId, { catchUpDispatch: true, catchUpUntil: fromNow(HOUR).toISOString() }),
    );

    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.errorLog).toMatch(/^Catch-up cancelled:/);
    expect(relay.frames).toEqual([]);
  });

  it('the safety net dispatches for a connected device and leaves an offline one', async () => {
    const online = await seedDevice();
    const offlineAgent = await seedDevice();
    const statusOffline = await seedDevice();
    const onlineJob = await seedJob(online, { catchUpUntil: fromNow(HOUR) });
    const agentGoneJob = await seedJob(offlineAgent, { catchUpUntil: fromNow(HOUR) });
    const statusOfflineJob = await seedJob(statusOffline, { catchUpUntil: fromNow(HOUR) });
    await getTestDb().update(devices).set({ status: 'offline' }).where(eq(devices.id, statusOffline.deviceId));
    // statusOffline's agent would answer "connected": only the status filter keeps it out.
    vi.mocked(isAgentConnectedAnywhere)
      .mockImplementation(async (agentId: string) => agentId === online.agentId || agentId === statusOffline.agentId);

    await dispatchCatchUpsForConnectedDevices();

    const ours = new Set([onlineJob, agentGoneJob, statusOfflineJob]);
    expect(queued.jobs.map((j) => j.jobId).filter((id) => ours.has(id))).toEqual([onlineJob]);
  });

  it('the scheduler expiry settles only the older catch-ups of that link and device', async () => {
    const t = await seedDevice();
    const other = await seedDevice();
    const occurrenceStart = fromNow(-5 * 60_000);
    const older = await seedJob(t, { catchUpUntil: fromNow(HOUR), createdAt: fromNow(-HOUR) });
    // Same occurrence, another profile selection, created on an earlier tick.
    const sameOccurrence = await seedJob(t, { catchUpUntil: fromNow(HOUR), createdAt: fromNow(-60_000) });
    const fresh = await seedJob(t);
    const othersJob = await seedJob(other, { catchUpUntil: fromNow(HOUR), createdAt: fromNow(-HOUR) });

    await inSystemContext(() => expireSupersededBackupCatchUps({
      deviceId: t.deviceId,
      featureLinkId: t.featureLinkId,
      occurrenceStart,
    }));

    const expired = await jobRow(older);
    expect(expired.status).toBe('failed');
    expect(expired.errorLog).toBe(BACKUP_MISSED_ERROR);
    expect(expired.completedAt).toBeInstanceOf(Date);
    expect((await jobRow(sameOccurrence)).status).toBe('pending');
    expect((await jobRow(fresh)).status).toBe('pending');
    expect((await jobRow(othersJob)).status).toBe('pending');
  });

  it('the scheduler expiry does not call it Missed when the device came back', async () => {
    const t = await seedDevice();
    const older = await seedJob(t, { catchUpUntil: fromNow(HOUR), createdAt: fromNow(-HOUR) });
    await getTestDb().update(devices).set({ lastSeenAt: fromNow(-60_000) }).where(eq(devices.id, t.deviceId));

    await inSystemContext(() => expireSupersededBackupCatchUps({
      deviceId: t.deviceId,
      featureLinkId: t.featureLinkId,
      occurrenceStart: fromNow(-5 * 60_000),
    }));

    expect((await jobRow(older)).errorLog).toBe(BACKUP_CATCH_UP_NOT_STARTED_ERROR);
  });

  describe('the stale reaper', () => {
    const old = () => fromNow(-10 * HOUR);

    it('spares a job before catch_up_until, and settles it with the exact Missed text after', async () => {
      const t = await seedDevice();
      const waiting = await seedJob(t, { createdAt: old(), catchUpUntil: fromNow(HOUR) });
      const lapsed = await seedJob(t, { createdAt: old(), catchUpUntil: fromNow(-HOUR) });

      await inSystemContext(() => reapStaleBackupJobs());

      expect((await jobRow(waiting)).status).toBe('pending');
      const missed = await jobRow(lapsed);
      expect(missed.status).toBe('failed');
      expect(missed.errorLog).toBe(BACKUP_MISSED_ERROR);
    });

    it('gives a claimed catch-up its own hour rather than reading the time since the schedule', async () => {
      const t = await seedDevice();
      const claimed = await seedJob(t, { createdAt: old(), startedAt: fromNow(-60_000) });
      const dead = await seedJob(t, { createdAt: old(), startedAt: fromNow(-2 * HOUR) });

      await inSystemContext(() => reapStaleBackupJobs());

      expect((await jobRow(claimed)).status).toBe('pending');
      const reaped = await jobRow(dead);
      expect(reaped.status).toBe('failed');
      expect(reaped.errorLog).toContain('Backup dispatch never completed');
    });

    it('still reaps an ordinary pending job on its creation time', async () => {
      const t = await seedDevice();
      const stuck = await seedJob(t, { createdAt: old() });

      await inSystemContext(() => reapStaleBackupJobs());

      expect((await jobRow(stuck)).status).toBe('failed');
    });
  });

  it('a manual run is not answered with a job that is waiting for the device', async () => {
    const t = await seedDevice();
    const waiting = await seedJob(t, {
      catchUpUntil: fromNow(HOUR),
      backupMode: null,
      modeTargets: null,
    });

    const result = await inSystemContext(() => createManualBackupJobIfIdle({
      orgId: t.orgId,
      configId: t.configId,
      featureLinkId: t.featureLinkId,
      deviceId: t.deviceId,
      helperQueues: true,
    }));

    expect(result?.created).toBe(true);
    expect(result?.job.id).not.toBe(waiting);
    expect(result?.job.type).toBe('manual');
  });

  it('a manual run on an older helper still counts the waiting job, so the two never run side by side', async () => {
    const t = await seedDevice();
    const waiting = await seedJob(t, { catchUpUntil: fromNow(HOUR), backupMode: null, modeTargets: null });

    const result = await inSystemContext(() => createManualBackupJobIfIdle({
      orgId: t.orgId,
      configId: t.configId,
      featureLinkId: t.featureLinkId,
      deviceId: t.deviceId,
      helperQueues: false,
    }));

    expect(result?.created).toBe(false);
    expect(result?.job.id).toBe(waiting);
  });
});
