/**
 * Backups started before a new device reports its backup helper wait for that
 * report — against real Postgres, the real heartbeat route and the real
 * backup worker dispatch.
 *
 * A device's helper protocols are NULL from enrollment until its first
 * heartbeat. A backup started in that window (a "Run now" seconds after
 * enrollment) used to be built as if the helper were an older one, so the
 * storage destination went out even to a helper that writes through storage
 * sessions. Now nothing is sent until the heartbeat reports the helper; that
 * report then decides, exactly as it would have for a device that reported
 * first. An agent whose heartbeat omits the fields is an older helper and is
 * served as before.
 *
 * Stubbed: the agent socket (captures the frame the helper would receive),
 * the relay's connectivity/expectation bookkeeping, and the re-queue of a
 * waiting dispatch (captured, then run by hand the way the queue would).
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupHelperUnreported.integration.test.ts
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Frame = { id: string; type: string; payload: Record<string, unknown> };

const relay = vi.hoisted(() => ({ frames: [] as Frame[] }));
const waits = vi.hoisted(() => ({ calls: [] as Array<{ data: Record<string, unknown>; wait: { attempt: number; since: string } }> }));

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

import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { backupConfigs, backupJobs, deviceCommands, devices } from '../../db/schema';
import { __testOnly } from '../../jobs/backupWorker';
import { agentRoutes } from '../../routes/agents';
import { backupWriteCredentialPayload } from '../../services/backupCommandCredentials';
import { BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE } from '../../services/backupHelperProtocols';
import { prepareClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { WRITE_DESTINATION } from './backupWriteFixtures';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const HELPER_REPORTS_BROKERED = {
  backupReadProtocolVersion: 1,
  backupIntegrityProtocolVersion: 1,
  backupWriteProtocolVersion: 1,
};

function buildAgentApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/agents', agentRoutes);
  return app;
}

type Seeded = { orgId: string; deviceId: string; agentId: string; agentToken: string; configId: string };

/** A device row as enrollment leaves it (no heartbeat yet), plus an S3 backup configuration. */
async function seedNewDevice(): Promise<Seeded> {
  const partner = await createPartner({ status: 'active' });
  const org = await createOrganization({ partnerId: partner.id, status: 'active' });
  const site = await createSite({ orgId: org.id });
  const suffix = randomUUID().slice(0, 8);
  const agentId = `agent-unreported-${suffix}`;
  const agentToken = `brz_unreported_${suffix}`;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId,
      hostname: `host-unreported-${suffix}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      agentTokenHash: createHash('sha256').update(agentToken).digest('hex'),
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  const [config] = await getTestDb()
    .insert(backupConfigs)
    .values({ orgId: org.id, name: `Primary ${suffix}`, type: 'file', provider: 's3', providerConfig: WRITE_DESTINATION })
    .returning({ id: backupConfigs.id });
  return { orgId: org.id, deviceId: device!.id, agentId, agentToken, configId: config!.id };
}

async function helperProtocols(deviceId: string) {
  const [row] = await getTestDb()
    .select({
      read: devices.backupReadProtocolVersion,
      integrity: devices.backupIntegrityProtocolVersion,
      write: devices.backupWriteProtocolVersion,
    })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return row!;
}

/** "Run now": the pending job row the route creates for the dispatch it queues. */
async function runNow(t: Seeded): Promise<string> {
  const [job] = await getTestDb()
    .insert(backupJobs)
    .values({
      orgId: t.orgId, configId: t.configId, deviceId: t.deviceId, status: 'pending',
      backupMode: 'file', modeTargets: { paths: ['C:\\Data'] },
    })
    .returning({ id: backupJobs.id });
  return job!.id;
}

async function jobStatus(jobId: string): Promise<string> {
  const [row] = await getTestDb().select({ status: backupJobs.status }).from(backupJobs).where(eq(backupJobs.id, jobId));
  return row!.status;
}

async function heartbeat(t: Seeded, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await buildAgentApp().request(`/api/v1/agents/${t.agentId}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ok', agentVersion: '1.0.0-test', ...extra }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Nothing of the storage destination (configuration or keys) in what was sent. */
function expectNoDestination(payload: Record<string, unknown>) {
  expect(payload).not.toHaveProperty('providerConfig');
  expect(payload).not.toHaveProperty('providerConfigRef');
  const wire = JSON.stringify(payload);
  expect(wire).not.toContain(WRITE_DESTINATION.accessKey);
  expect(wire).not.toContain(WRITE_DESTINATION.secretKey);
}

describe('backups started before a new device reports its backup helper', () => {
  const previousOrigin = process.env.PUBLIC_API_URL;
  beforeAll(() => { process.env.PUBLIC_API_URL = 'https://api.breeze.example'; });
  afterAll(() => {
    if (previousOrigin === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = previousOrigin;
  });
  beforeEach(() => {
    relay.frames.length = 0;
    waits.calls.length = 0;
  });

  it('a new device starts with its helper protocols unreported', async () => {
    const t = await seedNewDevice();
    expect(await helperProtocols(t.deviceId)).toEqual({ read: null, integrity: null, write: null });
  });

  it('Run now before the first heartbeat sends nothing; after the heartbeat the waiting backup goes out brokered', async () => {
    const t = await seedNewDevice();
    const jobId = await runNow(t);
    const data = { type: 'dispatch-backup' as const, jobId, configId: t.configId, orgId: t.orgId, deviceId: t.deviceId };

    await expect(__testOnly.processDispatchBackup(data)).resolves.toEqual({ dispatched: false });
    expect(relay.frames).toEqual([]);
    expect(await jobStatus(jobId)).toBe('pending');
    expect(waits.calls).toHaveLength(1);
    expect(waits.calls[0]!.wait.attempt).toBe(1);

    // The first heartbeat reports a helper that writes through storage sessions.
    await heartbeat(t, HELPER_REPORTS_BROKERED);
    expect(await helperProtocols(t.deviceId)).toEqual({ read: 1, integrity: 1, write: 1 });

    // The queued re-check runs.
    const recheck = { ...data, capabilityWaitAttempt: 1, capabilityWaitSince: waits.calls[0]!.wait.since };
    await expect(__testOnly.processDispatchBackup(recheck)).resolves.toEqual({ dispatched: true });
    expect(relay.frames).toHaveLength(1);
    const frame = relay.frames[0]!;
    expect(frame).toMatchObject({ id: jobId, type: 'backup_run' });
    expectNoDestination(frame.payload);
    expect(frame.payload.storageSession).toMatchObject({ scope: 'snapshot_write', baseUrl: 'https://api.breeze.example' });
    expect(await jobStatus(jobId)).toBe('running');
    expect(waits.calls).toHaveLength(1);
  });

  it('an agent whose heartbeat omits the fields is an older helper and gets the backup as before', async () => {
    const t = await seedNewDevice();
    await heartbeat(t, {});
    expect(await helperProtocols(t.deviceId)).toEqual({ read: 0, integrity: 0, write: 0 });

    const jobId = await runNow(t);
    await expect(__testOnly.processDispatchBackup({
      type: 'dispatch-backup', jobId, configId: t.configId, orgId: t.orgId, deviceId: t.deviceId,
    })).resolves.toEqual({ dispatched: true });

    expect(waits.calls).toEqual([]);
    expect(relay.frames).toHaveLength(1);
    expect(relay.frames[0]!.payload.providerConfig).toMatchObject({ bucket: WRITE_DESTINATION.bucket });
    expect(relay.frames[0]!.payload).not.toHaveProperty('storageSession');
  });

  it('a waiting backup is never sent once its job is no longer pending', async () => {
    const t = await seedNewDevice();
    const jobId = await runNow(t);
    const data = { type: 'dispatch-backup' as const, jobId, configId: t.configId, orgId: t.orgId, deviceId: t.deviceId };
    await __testOnly.processDispatchBackup(data);
    await getTestDb().update(backupJobs).set({ status: 'failed', errorLog: 'Backup dispatch never completed' }).where(eq(backupJobs.id, jobId));
    await heartbeat(t, HELPER_REPORTS_BROKERED);

    await expect(__testOnly.processDispatchBackup({
      ...data, capabilityWaitAttempt: 1, capabilityWaitSince: waits.calls[0]!.wait.since,
    })).resolves.toEqual({ dispatched: false });
    expect(relay.frames).toEqual([]);
    expect(await jobStatus(jobId)).toBe('failed');
  });

  it('a queued database backup polled before the first heartbeat is held, then delivered brokered by the heartbeat', async () => {
    const t = await seedNewDevice();
    const [job] = await getTestDb()
      .insert(backupJobs)
      .values({ orgId: t.orgId, configId: t.configId, deviceId: t.deviceId, status: 'pending', type: 'manual' })
      .returning({ id: backupJobs.id });
    const commandId = randomUUID();
    await getTestDb().insert(deviceCommands).values({
      id: commandId,
      deviceId: t.deviceId,
      type: 'mssql_backup',
      status: 'pending',
      targetRole: 'agent',
      payload: {
        jobId: job!.id,
        configId: t.configId,
        ...backupWriteCredentialPayload(t.configId, t.orgId, { provider: 's3', storageEncryption: { required: false, mode: 'disabled' } }),
        instance: 'MSSQLSERVER',
        database: 'db1',
      },
    });

    // The command poll carries no helper report: the stored NULL decides.
    const polled = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () =>
        prepareClaimedCommandsForDelivery(await claimPendingCommandsForDevice(t.deviceId, 10, 'agent'))),
    );
    expect(polled).toEqual([]);
    const [row] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, commandId));
    expect(row!.status).toBe('pending');
    expect(row!.result).toMatchObject({ deliveryDeferred: BACKUP_HELPER_UNREPORTED_DEFERRAL_MESSAGE });
    // The row still holds only the destination reference it was queued with.
    expect(row!.payload).not.toHaveProperty('providerConfig');
    expect(JSON.stringify(row!.payload)).not.toContain(WRITE_DESTINATION.secretKey);

    // The first heartbeat reports the helper and collects the command.
    const beat = await heartbeat(t, HELPER_REPORTS_BROKERED);
    const commands = beat.commands as Array<{ id: string; type: string; payload: Record<string, unknown> }>;
    const delivered = commands.find((c) => c.id === commandId);
    expect(delivered?.type).toBe('mssql_backup');
    expectNoDestination(delivered!.payload);
    expect(delivered!.payload.storageSession).toMatchObject({ scope: 'snapshot_write' });
  });

  // The agent reports explicit nulls when its probe of the installed helper
  // got no answer (not installed yet, timed out, crashed).
  describe('a heartbeat that reports the helper as unknown', () => {
    const UNKNOWN = { backupReadProtocolVersion: null, backupIntegrityProtocolVersion: null, backupWriteProtocolVersion: null };

    it('keeps the last report, and a backup still goes out brokered', async () => {
      const t = await seedNewDevice();
      await heartbeat(t, HELPER_REPORTS_BROKERED);
      await heartbeat(t, UNKNOWN);
      expect(await helperProtocols(t.deviceId)).toEqual({ read: 1, integrity: 1, write: 1 });

      const jobId = await runNow(t);
      await expect(__testOnly.processDispatchBackup({
        type: 'dispatch-backup', jobId, configId: t.configId, orgId: t.orgId, deviceId: t.deviceId,
      })).resolves.toEqual({ dispatched: true });
      expect(waits.calls).toEqual([]);
      expect(relay.frames).toHaveLength(1);
      expectNoDestination(relay.frames[0]!.payload);
      expect(relay.frames[0]!.payload.storageSession).toMatchObject({ scope: 'snapshot_write' });
    });

    it('before any report the device stays unreported and the backup waits', async () => {
      const t = await seedNewDevice();
      await heartbeat(t, UNKNOWN);
      expect(await helperProtocols(t.deviceId)).toEqual({ read: null, integrity: null, write: null });

      const jobId = await runNow(t);
      await expect(__testOnly.processDispatchBackup({
        type: 'dispatch-backup', jobId, configId: t.configId, orgId: t.orgId, deviceId: t.deviceId,
      })).resolves.toEqual({ dispatched: false });
      expect(relay.frames).toEqual([]);
      expect(waits.calls).toHaveLength(1);
      expect(await jobStatus(jobId)).toBe('pending');
    });

    it('after an older-helper report (0) the device waits for a real report instead of being served as an older helper', async () => {
      const t = await seedNewDevice();
      await heartbeat(t, {});
      expect(await helperProtocols(t.deviceId)).toEqual({ read: 0, integrity: 0, write: 0 });
      await heartbeat(t, UNKNOWN);
      expect(await helperProtocols(t.deviceId)).toEqual({ read: null, integrity: null, write: null });

      const jobId = await runNow(t);
      await expect(__testOnly.processDispatchBackup({
        type: 'dispatch-backup', jobId, configId: t.configId, orgId: t.orgId, deviceId: t.deviceId,
      })).resolves.toEqual({ dispatched: false });
      expect(relay.frames).toEqual([]);
    });
  });
});
