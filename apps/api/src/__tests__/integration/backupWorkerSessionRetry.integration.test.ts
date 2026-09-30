/**
 * A transient failure to issue a write session while the backup worker builds
 * a dispatch — against real Postgres and the real worker.
 *
 * The preparation phase runs in one system transaction: child job rows for
 * extra targets, the dispatch pin on the job, and the write sessions (with
 * their snapshot id reservations) already issued for earlier targets. When
 * issuing a session for a later target fails for a transient reason, that
 * whole transaction rolls back, nothing is sent, the job stays pending and the
 * dispatch is queued again — and the next attempt builds the dispatch once,
 * with no leftovers from the failed one.
 *
 * Stubbed: the agent socket (captures frames), the relay's expectation
 * bookkeeping, the re-queue (captured), and the session issuer, which fails
 * on a chosen call and otherwise runs for real.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupWorkerSessionRetry.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Frame = { id: string; type: string; payload: Record<string, unknown> };

const relay = vi.hoisted(() => ({ frames: [] as Frame[] }));
const waits = vi.hoisted(() => ({ calls: [] as Array<{ data: Record<string, unknown>; wait: { attempt: number; since: string } }> }));
const mint = vi.hoisted(() => ({ calls: 0, failOnCall: 0 }));

vi.mock('../../services/agentCommandRelay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agentCommandRelay')>()),
  isAgentConnectedAnywhere: vi.fn(async () => true),
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
  enqueueBackupDispatchCapabilityWait: vi.fn(async (data: Record<string, unknown>, wait: { attempt: number; since: string }) => {
    waits.calls.push({ data, wait });
    return `backup-dispatch-${String(data.jobId)}-capability-wait-${wait.attempt}`;
  }),
}));

vi.mock('../../services/backupStorageWriteSessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/backupStorageWriteSessions')>();
  return {
    ...actual,
    mintBackupWriteSession: vi.fn(async (...args: Parameters<typeof actual.mintBackupWriteSession>) => {
      mint.calls += 1;
      if (mint.calls === mint.failOnCall) throw new Error('connection terminated unexpectedly');
      return actual.mintBackupWriteSession(...args);
    }),
  };
});

import { backupConfigs, backupJobs, devices, hypervVms } from '../../db/schema';
import { __testOnly } from '../../jobs/backupWorker';
import { WRITE_DESTINATION } from './backupWriteFixtures';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

type Seeded = { orgId: string; deviceId: string; configId: string };

async function seed(vmNames: string[]): Promise<Seeded> {
  const partner = await createPartner({ status: 'active' });
  const org = await createOrganization({ partnerId: partner.id, status: 'active' });
  const site = await createSite({ orgId: org.id });
  const suffix = randomUUID().slice(0, 8);
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `agent-retry-${suffix}`,
      hostname: `host-retry-${suffix}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.119.0',
      status: 'online',
      enrolledAt: new Date(),
      backupReadProtocolVersion: 1,
      backupIntegrityProtocolVersion: 1,
      backupWriteProtocolVersion: 1,
    })
    .returning({ id: devices.id });
  for (const vmName of vmNames) {
    await getTestDb().insert(hypervVms).values({ orgId: org.id, deviceId: device!.id, vmId: randomUUID(), vmName });
  }
  const [config] = await getTestDb()
    .insert(backupConfigs)
    .values({ orgId: org.id, name: `Primary ${suffix}`, type: 'file', provider: 's3', providerConfig: WRITE_DESTINATION })
    .returning({ id: backupConfigs.id });
  return { orgId: org.id, deviceId: device!.id, configId: config!.id };
}

async function pendingJob(t: Seeded, mode: 'hyperv' | 'file'): Promise<string> {
  const [job] = await getTestDb()
    .insert(backupJobs)
    .values({
      orgId: t.orgId, configId: t.configId, deviceId: t.deviceId, status: 'pending',
      backupMode: mode,
      modeTargets: mode === 'file' ? { paths: ['C:\\Data'] } : { consistencyType: 'application' },
    })
    .returning({ id: backupJobs.id });
  return job!.id;
}

async function orgCounts(orgId: string) {
  const [row] = (await getTestDb().execute(sql`
    SELECT
      (SELECT count(*)::int FROM backup_jobs WHERE org_id = ${orgId})                                    AS jobs,
      (SELECT count(*)::int FROM backup_storage_sessions WHERE org_id = ${orgId} AND scope = 'snapshot_write') AS sessions,
      (SELECT count(*)::int FROM backup_snapshot_id_reservations WHERE org_id = ${orgId})                AS reservations
  `)) as unknown as Array<{ jobs: number; sessions: number; reservations: number }>;
  return row!;
}

async function job(jobId: string) {
  const [row] = await getTestDb()
    .select({
      status: backupJobs.status,
      storageIdentity: backupJobs.storageIdentity,
      publishLeaseExpiresAt: backupJobs.publishLeaseExpiresAt,
      snapshotId: backupJobs.snapshotId,
      errorLog: backupJobs.errorLog,
    })
    .from(backupJobs)
    .where(eq(backupJobs.id, jobId));
  return row!;
}

function dispatchData(t: Seeded, jobId: string) {
  return { type: 'dispatch-backup' as const, jobId, configId: t.configId, orgId: t.orgId, deviceId: t.deviceId };
}

describe('a transient failure to issue a write session while building a backup dispatch', () => {
  const previousOrigin = process.env.PUBLIC_API_URL;
  beforeAll(() => { process.env.PUBLIC_API_URL = 'https://api.breeze.example'; });
  afterAll(() => {
    if (previousOrigin === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = previousOrigin;
  });
  beforeEach(() => {
    relay.frames.length = 0;
    waits.calls.length = 0;
    mint.calls = 0;
    mint.failOnCall = 0;
  });

  it('rolls back child jobs and the sessions issued for earlier targets, sends nothing, and retries the job', async () => {
    const t = await seed(['vm-a', 'vm-b', 'vm-c']);
    const jobId = await pendingJob(t, 'hyperv');
    mint.failOnCall = 3; // the first two targets get real sessions, the third fails

    await expect(__testOnly.processDispatchBackup(dispatchData(t, jobId))).resolves.toEqual({ dispatched: false });

    expect(mint.calls).toBe(3);
    expect(relay.frames).toEqual([]);
    // Only the parent job remains: the two child rows and both sessions (and
    // their snapshot id reservations) were rolled back with the preparation.
    expect(await orgCounts(t.orgId)).toEqual({ jobs: 1, sessions: 0, reservations: 0 });
    expect(await job(jobId)).toMatchObject({ status: 'pending', storageIdentity: null, snapshotId: null, errorLog: null });
    // Retried, not failed.
    expect(waits.calls).toHaveLength(1);
    expect(waits.calls[0]!.data).toMatchObject({ jobId });

    // The retry builds the dispatch once, with no leftovers.
    await expect(__testOnly.processDispatchBackup({
      ...dispatchData(t, jobId), capabilityWaitAttempt: 1, capabilityWaitSince: waits.calls[0]!.wait.since,
    })).resolves.toEqual({ dispatched: true });
    expect(relay.frames).toHaveLength(3);
    for (const frame of relay.frames) {
      expect(frame.payload).not.toHaveProperty('providerConfig');
      expect(frame.payload.storageSession).toMatchObject({ scope: 'snapshot_write' });
    }
    expect(await orgCounts(t.orgId)).toEqual({ jobs: 3, sessions: 3, reservations: 3 });
  });

  it('rolls back the dispatch pin a file backup stamps on its job', async () => {
    const t = await seed([]);
    const jobId = await pendingJob(t, 'file');
    mint.failOnCall = 1;

    await expect(__testOnly.processDispatchBackup(dispatchData(t, jobId))).resolves.toEqual({ dispatched: false });

    expect(relay.frames).toEqual([]);
    expect(await job(jobId)).toMatchObject({
      status: 'pending', storageIdentity: null, publishLeaseExpiresAt: null, snapshotId: null,
    });
    expect(waits.calls).toHaveLength(1);
  });
});
