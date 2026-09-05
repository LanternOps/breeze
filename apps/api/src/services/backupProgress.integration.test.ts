import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  backupConfigs,
  backupJobs,
  devices,
  organizations,
  partners,
  sites,
} from '../db/schema';
import { applyBackupProgress, applyBackupStartedAck } from './backupProgress';

// Real-Postgres proof for the queue lifecycle guards in applyBackupProgress /
// applyBackupStartedAck (#4923). The mocked unit suite only substring-matches
// the generated `CASE WHEN last_progress_at IS NULL ...` fragments; it cannot
// tell a wrong cast, inverted branch, or lost race from a correct one. This
// drives the production functions against the migrated schema (real
// backup_status enum, real devices join for the agent ownership check).
const runDb = describe.runIf(!!process.env.DATABASE_URL);

runDb('backup queue lifecycle (real PostgreSQL)', () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `queue-agent-${unique}`;
  let orgId = '';
  let configId = '';
  let deviceId = '';

  beforeAll(async () => {
    await withSystemDbAccessContext(async () => {
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
      orgId = org!.id;
      configId = config!.id;
      deviceId = device!.id;
    });
  });

  /** Fresh job row per test in the given status; dispatch-time running marker optional. */
  async function seedJob(status: 'pending' | 'running', startedAt: Date | null): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [job] = await db
        .insert(backupJobs)
        .values({ orgId, configId, deviceId, status, type: 'manual', startedAt, lastProgressAt: null })
        .returning({ id: backupJobs.id });
      return job!.id;
    });
  }
  const row = (jobId: string) => withSystemDbAccessContext(async () => {
    const [r] = await db.select().from(backupJobs).where(eq(backupJobs.id, jobId));
    return r!;
  });
  const progress = (jobId: string, phase: string, who = agentId) =>
    withSystemDbAccessContext(() => applyBackupProgress({ agentId: who, commandId: jobId, progress: { phase } }));
  const admission = (jobId: string) =>
    withSystemDbAccessContext(() => applyBackupStartedAck({ jobId, deviceId, queued: true }));

  it('queued admission demotes the dispatch-time running marker; starting promotes once; late queued pings never reset it', async () => {
    // backupWorker's post-send write marks the row running/startedAt before
    // the helper has admitted it.
    const jobId = await seedJob('running', new Date('2026-01-01T00:00:00Z'));

    expect(await admission(jobId)).toBe(true);
    let r = await row(jobId);
    expect(r.status).toBe('pending');
    expect(r.startedAt).toBeNull();
    expect(r.lastProgressAt).not.toBeNull();

    expect(await progress(jobId, 'queued')).toMatchObject({ applied: true });
    r = await row(jobId);
    expect(r.status).toBe('pending');
    expect(r.startedAt).toBeNull();

    expect(await progress(jobId, 'starting')).toMatchObject({ applied: true });
    r = await row(jobId);
    expect(r.status).toBe('running');
    const started = r.startedAt;
    expect(started).toBeInstanceOf(Date);

    // A delayed duplicate admission / queued ping racing the start must not
    // demote or restamp the execution start.
    await Promise.all([admission(jobId), progress(jobId, 'queued'), progress(jobId, 'starting')]);
    r = await row(jobId);
    expect(r.status).toBe('running');
    expect(r.startedAt?.getTime()).toBe(started!.getTime());
  });

  it('starting before the admission ack wins, and a terminal row rejects every lifecycle signal', async () => {
    const jobId = await seedJob('pending', null);

    await progress(jobId, 'starting');
    const started = (await row(jobId)).startedAt;
    expect(started).toBeInstanceOf(Date);

    expect(await admission(jobId)).toBe(true);
    let r = await row(jobId);
    expect(r.status).toBe('running');
    expect(r.startedAt?.getTime()).toBe(started!.getTime());

    await withSystemDbAccessContext(() =>
      db.update(backupJobs).set({ status: 'completed', completedAt: new Date() }).where(eq(backupJobs.id, jobId)),
    );
    expect(await admission(jobId)).toBe(false);
    expect(await progress(jobId, 'queued')).toMatchObject({ applied: false, reason: 'terminal-status' });
    r = await row(jobId);
    expect(r.status).toBe('completed');
    expect(r.startedAt?.getTime()).toBe(started!.getTime());
  });

  it('legacy helper progress (no starting phase) promotes a pending row and stamps startedAt', async () => {
    const jobId = await seedJob('pending', null);
    expect(await progress(jobId, 'uploading')).toMatchObject({ applied: true });
    const r = await row(jobId);
    expect(r.status).toBe('running');
    expect(r.startedAt).toBeInstanceOf(Date);
  });

  it('rejects lifecycle messages from an agent that does not own the device', async () => {
    const jobId = await seedJob('pending', null);
    expect(await progress(jobId, 'starting', `other-agent-${unique}`)).toMatchObject({ applied: false, reason: 'agent-mismatch' });
    const r = await row(jobId);
    expect(r.status).toBe('pending');
    expect(r.lastProgressAt).toBeNull();
  });
});
