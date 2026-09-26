import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  backupConfigs,
  backupJobs,
  devices,
  organizations,
  partners,
  sites,
} from '../db/schema';
import { getTestDb } from '../__tests__/integration/setup';
import { applyBackupProgress, applyBackupStartedAck } from './backupProgress';

// Real-Postgres proof for the queue lifecycle guards in applyBackupProgress /
// applyBackupStartedAck (#4923). The mocked unit suite only substring-matches
// the generated `CASE WHEN last_progress_at IS NULL ...` fragments; it cannot
// tell a wrong cast, inverted branch, or lost race from a correct one. This
// drives the production functions against the migrated schema (real
// backup_status enum, real devices join for the agent ownership check).
const runDb = describe.runIf(!!process.env.DATABASE_URL);

runDb('backup queue lifecycle (real PostgreSQL)', () => {
  // The shared integration setup truncates between tests, so every test
  // seeds its own partner → org → site → device → config chain.
  async function seedFixture() {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agentId = `queue-agent-${unique}`;
    return withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({ name: `Queue Partner ${unique}`, slug: `queue-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active' })
        .returning({ id: partners.id });
      const [org] = await db
        .insert(organizations)
        .values({ currencyCode: 'USD', partnerId: partner!.id, name: `Queue Org ${unique}`, slug: `queue-org-${unique}`, type: 'customer', status: 'active' })
        .returning({ id: organizations.id });
      const [site] = await db.insert(sites).values({ orgId: org!.id, name: `Queue Site ${unique}` }).returning({ id: sites.id });
      const [device] = await db
        .insert(devices)
        .values({
          orgId: org!.id,
          siteId: site!.id,
          agentId,
          hostname: `queue-host-${unique}`,
          osType: 'windows',
          osVersion: '2022',
          architecture: 'x86_64',
          agentVersion: '0.110.0',
          backupVersion: '0.110.0',
          status: 'online',
        })
        .returning({ id: devices.id });
      const [config] = await db
        .insert(backupConfigs)
        .values({ orgId: org!.id, name: `Queue Config ${unique}`, type: 'file', provider: 'local', providerConfig: {} })
        .returning({ id: backupConfigs.id });
      return { unique, agentId, orgId: org!.id, configId: config!.id, deviceId: device!.id };
    });
  }
  type Fixture = Awaited<ReturnType<typeof seedFixture>>;

  /** Fresh job row in the given status; dispatch-time running marker optional. */
  async function seedJob(f: Fixture, status: 'pending' | 'running', startedAt: Date | null): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [job] = await db
        .insert(backupJobs)
        .values({ orgId: f.orgId, configId: f.configId, deviceId: f.deviceId, status, type: 'manual', startedAt, lastProgressAt: null })
        .returning({ id: backupJobs.id });
      return job!.id;
    });
  }
  const row = (jobId: string) => withSystemDbAccessContext(async () => {
    const [r] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId));
    return r!;
  });
  const progress = (f: Fixture, jobId: string, phase: string, who = f.agentId) =>
    withSystemDbAccessContext(() => applyBackupProgress({ agentId: who, commandId: jobId, progress: { phase } }));
  const admission = (f: Fixture, jobId: string) =>
    withSystemDbAccessContext(() => applyBackupStartedAck({ jobId, deviceId: f.deviceId, queued: true }));

  it('queued admission demotes the dispatch-time running marker; starting promotes once; late queued pings never reset it', async () => {
    // backupWorker's post-send write marks the row running/startedAt before
    // the helper has admitted it.
    const f = await seedFixture();
    const jobId = await seedJob(f, 'running', new Date('2026-01-01T00:00:00Z'));

    expect(await admission(f, jobId)).toBe(true);
    let r = await row(jobId);
    expect(r.status).toBe('pending');
    expect(r.startedAt).toBeNull();
    // #2798: admission is liveness, not transfer progress.
    expect(r.lastKeepaliveAt).not.toBeNull();
    expect(r.lastProgressAt).toBeNull();

    expect(await progress(f, jobId, 'queued')).toMatchObject({ applied: true });
    r = await row(jobId);
    expect(r.status).toBe('pending');
    expect(r.startedAt).toBeNull();

    expect(await progress(f, jobId, 'starting')).toMatchObject({ applied: true });
    r = await row(jobId);
    expect(r.status).toBe('running');
    const started = r.startedAt;
    expect(started).toBeInstanceOf(Date);

    // A delayed duplicate admission / queued ping racing the start must not
    // demote or restamp the execution start.
    await Promise.all([admission(f, jobId), progress(f, jobId, 'queued'), progress(f, jobId, 'starting')]);
    r = await row(jobId);
    expect(r.status).toBe('running');
    expect(r.startedAt?.getTime()).toBe(started!.getTime());
  });

  it('starting before the admission ack wins, and a terminal row rejects every lifecycle signal', async () => {
    const f = await seedFixture();
    const jobId = await seedJob(f, 'pending', null);

    await progress(f, jobId, 'starting');
    const started = (await row(jobId)).startedAt;
    expect(started).toBeInstanceOf(Date);

    expect(await admission(f, jobId)).toBe(true);
    let r = await row(jobId);
    expect(r.status).toBe('running');
    expect(r.startedAt?.getTime()).toBe(started!.getTime());

    await withSystemDbAccessContext(() =>
      db.update(backupJobs).set({ status: 'completed', completedAt: new Date() }).where(eq(backupJobs.id, jobId)),
    );
    expect(await admission(f, jobId)).toBe(false);
    expect(await progress(f, jobId, 'queued')).toMatchObject({ applied: false, reason: 'terminal-status' });
    r = await row(jobId);
    expect(r.status).toBe('completed');
    expect(r.startedAt?.getTime()).toBe(started!.getTime());
  });

  it('legacy helper progress (no starting phase) promotes a pending row and stamps startedAt', async () => {
    const f = await seedFixture();
    const jobId = await seedJob(f, 'pending', null);
    expect(await progress(f, jobId, 'uploading')).toMatchObject({ applied: true });
    const r = await row(jobId);
    expect(r.status).toBe('running');
    expect(r.startedAt).toBeInstanceOf(Date);
  });

  it('#2798: a keepalive with unchanged counters refreshes liveness but never last_progress_at; only a real byte/file increase does', async () => {
    const f = await seedFixture();
    const jobId = await seedJob(f, 'running', new Date(Date.now() - 60 * 60 * 1000));
    const send = (p: Record<string, unknown>) =>
      withSystemDbAccessContext(() => applyBackupProgress({ agentId: f.agentId, commandId: jobId, progress: p }));
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const backdate = () => withSystemDbAccessContext(() =>
      db.update(backupJobs).set({ lastProgressAt: old, lastKeepaliveAt: old }).where(eq(backupJobs.id, jobId)),
    );
    const expectProgressAdvanced = async (advanced: boolean) => {
      const r = await row(jobId);
      // Liveness moves on every applied message, advanced or not.
      expect(r.lastKeepaliveAt!.getTime()).toBeGreaterThan(old.getTime());
      if (advanced) expect(r.lastProgressAt!.getTime()).toBeGreaterThan(old.getTime());
      else expect(r.lastProgressAt!.getTime()).toBe(old.getTime());
      return r;
    };

    // The whole-run keepalive during VSS/scan sends 0,0,0,0: alive, no progress.
    expect(await send({ current: 0, total: 0, filesDone: 0, filesTotal: 0 })).toMatchObject({ applied: true });
    let r = await row(jobId);
    expect(r.lastKeepaliveAt).toBeInstanceOf(Date);
    expect(r.lastProgressAt).toBeNull();

    await send({ phase: 'uploading', current: 100, total: 1000, filesDone: 1, filesTotal: 10 });
    r = await row(jobId);
    expect(r.lastProgressAt).toBeInstanceOf(Date);

    // The upload-loop keepalive re-sends the same counters (the wedged-upload
    // signature from the issue): liveness only.
    await backdate();
    await send({ phase: 'uploading', current: 100, total: 1000, filesDone: 1, filesTotal: 10 });
    await expectProgressAdvanced(false);

    // A bare ping with no counters: liveness only.
    await backdate();
    await send({});
    await expectProgressAdvanced(false);

    // Bytes advanced.
    await backdate();
    await send({ current: 200, filesDone: 1 });
    await expectProgressAdvanced(true);

    // Files advanced with bytes flat (e.g. empty files).
    await backdate();
    await send({ current: 200, filesDone: 2 });
    await expectProgressAdvanced(true);

    // A counter regression (journal resume restarting its count) is not
    // progress, but the new values are still stored so the next increase is
    // measured from them.
    await backdate();
    await send({ current: 50, filesDone: 0 });
    r = await expectProgressAdvanced(false);
    expect(r.transferredSize).toBe(50);
    expect(r.fileCount).toBe(0);
    await backdate();
    await send({ current: 60, filesDone: 0 });
    await expectProgressAdvanced(true);
  });

  it('#2798 upgrade: the migration seeds liveness on in-flight rows so the first post-upgrade ping keeps started_at', async () => {
    // A job running across the upgrade has last_progress_at (old liveness)
    // but no last_keepalive_at. Without the seed, the "first signal" guard
    // (last_keepalive_at IS NULL) would restamp its started_at.
    const f = await seedFixture();
    const started = new Date('2026-01-01T00:00:00Z');
    const lastPing = new Date(Date.now() - 60 * 1000);
    const runningId = await seedJob(f, 'running', started);
    const doneId = await seedJob(f, 'running', started);
    await withSystemDbAccessContext(async () => {
      await db.update(backupJobs).set({ lastProgressAt: lastPing, lastKeepaliveAt: null }).where(eq(backupJobs.id, runningId));
      await db.update(backupJobs).set({ status: 'completed', lastProgressAt: lastPing, lastKeepaliveAt: null }).where(eq(backupJobs.id, doneId));
    });

    const migration = readFileSync(
      resolve(__dirname, '../../migrations/2026-11-02-100400-backup-jobs-last-keepalive-at.sql'),
      'utf8',
    );
    // Replayed as the owner role, the way autoMigrate runs it.
    const replay = () => getTestDb().transaction(async (tx) => { await tx.execute(sql.raw(migration)); });
    await replay();

    let r = await row(runningId);
    expect(r.lastKeepaliveAt?.getTime()).toBe(lastPing.getTime());
    // Terminal history is left alone.
    expect((await row(doneId)).lastKeepaliveAt).toBeNull();

    await progress(f, runningId, 'uploading');
    r = await row(runningId);
    expect(r.startedAt?.getTime()).toBe(started.getTime());

    // Re-applying is a no-op.
    await replay();
    expect((await row(runningId)).startedAt?.getTime()).toBe(started.getTime());
  });

  it('rejects lifecycle messages from an agent that does not own the device', async () => {
    const f = await seedFixture();
    const jobId = await seedJob(f, 'pending', null);
    expect(await progress(f, jobId, 'starting', `other-agent-${f.unique}`)).toMatchObject({ applied: false, reason: 'agent-mismatch' });
    const r = await row(jobId);
    expect(r.status).toBe('pending');
    expect(r.lastProgressAt).toBeNull();
    expect(r.lastKeepaliveAt).toBeNull();
  });
});
