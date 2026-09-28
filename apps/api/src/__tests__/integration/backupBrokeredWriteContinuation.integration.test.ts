/**
 * Continuing an unfinished brokered snapshot across backup jobs, against real
 * Postgres as the app role in the agent's organization context (storage
 * calls are faked):
 *
 *  - a later job of the same device, configuration, destination and
 *    dispatched base takes over an id the cleanup job abandoned after the
 *    earlier job ended, within the takeover age limit; every mismatch, an
 *    id past the limit, and an id given up by a resume are refused;
 *  - after a takeover only the new job publishes the id: the earlier job's
 *    late result (agent or reconcile) is refused, and the insert trigger
 *    enforces the same rule for a direct insert;
 *  - the same job's late result is still adopted within the window;
 *  - the fence and sealing wait out URL expiry plus the transfer margin;
 *  - the write session names the destination identity, and multipart:create
 *    reports the encryption it applied.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupBrokeredWriteContinuation.integration.test.ts
 */
import './setup';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { withDbAccessContext } from '../../db';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';
import { runBackupWriteSessionJanitor } from '../../jobs/backupWriteSessionJanitor';
import { reconcileOrphanedBackupSnapshots } from '../../services/backupSnapshotReconcile';
import { setBackupMetricsRecorder } from '../../services/backupMetrics';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import { SNAPSHOT_TAKEOVER_MAX_AGE_MS } from '../../services/backupSnapshotIdReservations';
import { authenticateStorageSession, type StorageSessionRow } from '../../services/backupStorageSessions';
import {
  STORAGE_WRITE_TRANSFER_MARGIN_MS,
  createWriteSessionMultipart,
  mintBackupWriteSession,
  resumeWriteSession,
  type WriteSessionDeps,
} from '../../services/backupStorageWriteSessions';
import {
  WRITE_DESTINATION,
  expectSqlState,
  orgContext,
  reservationRow,
  seedBackupJob,
  seedWriteDevice,
  seedWriteTenant,
  type WriteTenant,
} from './backupWriteFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function fakeDeps(overrides: Partial<WriteSessionDeps['storage']> = {}): WriteSessionDeps {
  return {
    now: () => new Date(),
    randomToken: () => randomBytes(32).toString('base64url'),
    random: (n) => randomBytes(n),
    publicOrigins: () => ['https://api.breeze.example'],
    scheduleProbe: vi.fn(),
    storage: {
      presignPut: async (_cfg, key, size, _sse, opts) => ({
        url: `https://storage.example/${key}?put`,
        headers: { 'content-length': String(size) },
        expiresAt: new Date(Date.now() + opts.expiresInSeconds * 1000),
      }),
      presignPart: async (_cfg, key, uploadId, partNumber, size, ttl) => ({
        url: `https://storage.example/${key}?uploadId=${uploadId}&partNumber=${partNumber}`,
        headers: { 'content-length': String(size) },
        expiresAt: new Date(Date.now() + ttl * 1000),
      }),
      presignGet: async (_cfg, key) => `https://storage.example/${key}?get`,
      createMultipart: async () => ({ uploadId: `upload-${randomUUID()}`, encryption: { algorithm: null, kmsKeyId: null } }),
      completeMultipart: async () => undefined,
      abortMultipart: async () => undefined,
      listMultipart: async () => [],
      listKeys: async () => ({ keys: [], nextToken: null }),
      deleteKeys: async (_cfg, keys) => ({ deleted: keys, failed: [] }),
      ...overrides,
    },
  };
}

const janitorDeps = { now: () => new Date(), storage: { abortMultipart: async () => undefined, listMultipart: async () => [] } };

function runFor(t: { orgId: string }) {
  return <T,>(fn: () => Promise<T>) => withDbAccessContext(orgContext(t.orgId), fn);
}

async function mintFor(
  t: { orgId: string; deviceId: string; configId: string },
  jobId: string,
  providerConfig: Record<string, unknown> = WRITE_DESTINATION,
) {
  const minted = await withDbAccessContext(orgContext(t.orgId), () =>
    mintBackupWriteSession({
      orgId: t.orgId, jobId, deviceId: t.deviceId, configId: t.configId, provider: 's3', providerConfig, baseManifestKey: null,
    }, fakeDeps()),
  );
  if (minted.mode !== 'brokered') throw new Error(`expected brokered, got ${minted.reason}`);
  const auth = await withDbAccessContext(orgContext(t.orgId), () =>
    authenticateStorageSession({
      sessionId: minted.envelope.sessionId as string,
      token: minted.envelope.token as string,
      agent: { deviceId: t.deviceId, orgId: t.orgId },
    }),
  );
  if (!auth.ok) throw new Error(`authentication failed: ${auth.error}`);
  return { ...minted, session: auth.session as StorageSessionRow };
}

const dbExec = (q: ReturnType<typeof sql>) => getTestDb().execute(q);

async function setBase(jobId: string, base: string | null) {
  await dbExec(sql`UPDATE backup_jobs SET base_snapshot_id = ${base} WHERE id = ${jobId}`);
}

/**
 * An earlier job minted an id, issued upload URLs that expired long enough
 * ago, and ended; the cleanup job then abandoned the id and swept its prefix.
 */
async function unfinishedId(t: WriteTenant, opts: { base?: string | null; abandon?: boolean } = {}) {
  const jobA = await seedBackupJob(t.orgId, t.configId, t.deviceId, 'running');
  await setBase(jobA, opts.base ?? null);
  const a = await mintFor(t, jobA);
  const expired = new Date(Date.now() - STORAGE_WRITE_TRANSFER_MARGIN_MS - 5 * 60_000).toISOString();
  await dbExec(sql`UPDATE backup_storage_sessions SET url_horizon_at = ${expired}::timestamptz WHERE id = ${a.sessionId}`);
  await dbExec(sql`UPDATE backup_jobs SET status = 'failed' WHERE id = ${jobA}`);
  if (opts.abandon !== false) {
    await runBackupWriteSessionJanitor(janitorDeps);
    const row = await reservationRow(a.snapshotId);
    expect(row).toMatchObject({ state: 'abandoned', current_job_id: jobA });
    expect(row?.uploads_swept_at).not.toBeNull();
  }
  return { jobA, x: a.snapshotId, sessionA: a.sessionId };
}

async function laterJob(t: WriteTenant, base: string | null = null) {
  const jobB = await seedBackupJob(t.orgId, t.configId, t.deviceId, 'running');
  await setBase(jobB, base);
  return { jobB, ...(await mintFor(t, jobB)) };
}

const resume = (t: { orgId: string }, session: StorageSessionRow, id: string) =>
  resumeWriteSession(session, id, runFor(t), fakeDeps());

async function report(t: WriteTenant, jobId: string, snapshotId: string, source: 'agent' | 'reconcile' = 'agent') {
  return withDbAccessContext(orgContext(t.orgId), () =>
    applyBackupCommandResultToJob({
      jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed', source,
      result: { snapshotId, filesBackedUp: 1, bytesBackedUp: 1 },
    }),
  );
}

describe('taking over an earlier job\'s unfinished snapshot id', () => {
  runDb('a later job of the same device, configuration, destination and base continues it', async () => {
    const t = await seedWriteTenant();
    const { jobA, x, sessionA } = await unfinishedId(t, { base: 'snapshot-20261101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const b = await laterJob(t, 'snapshot-20261101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa');

    const result = await resume(t, b.session, x);
    expect(result).toEqual({ status: 200, body: { snapshotId: x, mode: 'write', takeover: true } });
    expect(await reservationRow(x)).toMatchObject({
      state: 'reserved', current_job_id: b.jobB, write_generation: 2, uploads_swept_at: null,
    });
    // The id B was issued is given up with no job; A's session is revoked.
    expect(await reservationRow(b.snapshotId)).toMatchObject({ state: 'abandoned', current_job_id: null });
    const a = await dbExec(sql`SELECT revoked_at FROM backup_storage_sessions WHERE id = ${sessionA}`);
    expect((a[0] as { revoked_at: unknown }).revoked_at).not.toBeNull();
    const job = await dbExec(sql`SELECT snapshot_id FROM backup_jobs WHERE id = ${b.jobB}`);
    expect(job[0]).toMatchObject({ snapshot_id: x });
    expect(jobA).not.toBe(b.jobB);
  });

  runDb('an id the earlier job left reserved (not yet abandoned) is taken over the same way', async () => {
    const t = await seedWriteTenant();
    const { x } = await unfinishedId(t, { abandon: false });
    expect((await reservationRow(x))?.state).toBe('reserved');
    const b = await laterJob(t);
    expect(await resume(t, b.session, x)).toMatchObject({ status: 200, body: { mode: 'write', takeover: true } });
  });

  runDb('refuses another device', async () => {
    const t = await seedWriteTenant();
    const { x } = await unfinishedId(t);
    const sibling = await seedWriteDevice(t.orgId, t.siteId, 1);
    const job = await seedBackupJob(t.orgId, t.configId, sibling, 'running');
    const s = await mintFor({ ...t, deviceId: sibling }, job);
    expect(await resume(t, s.session, x)).toMatchObject({ status: 409, code: 'not_resumable' });
    expect((await reservationRow(x))?.state).toBe('abandoned');
  });

  runDb('refuses another configuration, even for the same destination', async () => {
    const t = await seedWriteTenant();
    const { x } = await unfinishedId(t, { abandon: false });
    const otherConfig = randomUUID();
    await dbExec(sql`
      INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
      VALUES (${otherConfig}, ${t.orgId}, 'Second', 'file', 's3', ${JSON.stringify(WRITE_DESTINATION)}::jsonb)
    `);
    const job = await seedBackupJob(t.orgId, otherConfig, t.deviceId, 'running');
    const s = await mintFor({ ...t, configId: otherConfig }, job);
    expect(await resume(t, s.session, x)).toMatchObject({ status: 409, code: 'not_resumable' });
  });

  runDb('refuses another storage destination', async () => {
    const t = await seedWriteTenant();
    const { x } = await unfinishedId(t, { abandon: false });
    await dbExec(sql`UPDATE backup_snapshot_id_reservations SET storage_identity = 's3::other.example::other-bucket' WHERE snapshot_id = ${x}`);
    const b = await laterJob(t);
    expect(await resume(t, b.session, x)).toMatchObject({ status: 409, code: 'not_resumable' });
  });

  runDb('refuses another dispatched base, whether the id is abandoned or still reserved', async () => {
    const t = await seedWriteTenant();
    const abandoned = await unfinishedId(t, { base: 'snapshot-20261101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa' });
    const b1 = await laterJob(t, 'snapshot-20261102T000000Z-bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(await resume(t, b1.session, abandoned.x)).toMatchObject({ status: 409, code: 'not_resumable' });

    const reserved = await unfinishedId(t, { abandon: false });
    const b2 = await laterJob(t, 'snapshot-20261102T000000Z-bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(await resume(t, b2.session, reserved.x)).toMatchObject({ status: 409, code: 'not_resumable' });
    expect(await reservationRow(reserved.x)).toMatchObject({ state: 'reserved', current_job_id: reserved.jobA, write_generation: 1 });
  });

  runDb('refuses a read-only completion for another configuration or base', async () => {
    const t = await seedWriteTenant();
    const { x, jobA } = await unfinishedId(t, { abandon: false });
    await dbExec(sql`UPDATE backup_jobs SET status = 'running' WHERE id = ${jobA}`);
    expect((await report(t, jobA, x)).snapshotDbId).not.toBeNull();
    expect(['sealing', 'published']).toContain((await reservationRow(x))?.state);
    const b = await laterJob(t, 'snapshot-20261102T000000Z-bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(await resume(t, b.session, x)).toMatchObject({ status: 409, code: 'not_resumable' });
    const same = await laterJob(t);
    expect(await resume(t, same.session, x)).toMatchObject({ status: 200, body: { mode: 'read_only_completion', takeover: false } });
  });

  runDb('refuses an id issued longer ago than the takeover limit', async () => {
    const t = await seedWriteTenant();
    const { x } = await unfinishedId(t, { abandon: false });
    const old = new Date(Date.now() - SNAPSHOT_TAKEOVER_MAX_AGE_MS - 60_000).toISOString();
    await dbExec(sql`UPDATE backup_snapshot_id_reservations SET created_at = ${old}::timestamptz WHERE snapshot_id = ${x}`);
    const b = await laterJob(t);
    expect(await resume(t, b.session, x)).toMatchObject({ status: 409, code: 'not_resumable' });
  });

  runDb('refuses an id a resume gave up (it has no job)', async () => {
    const t = await seedWriteTenant();
    const { x } = await unfinishedId(t);
    const b = await laterJob(t);
    expect((await resume(t, b.session, x)).status).toBe(200);
    // b's issued id is now abandoned with no job.
    const c = await laterJob(t);
    expect(await resume(t, c.session, b.snapshotId)).toMatchObject({ status: 409, code: 'not_resumable' });
  });

  runDb('waits (Retry-After) until the cleanup job has swept the abandoned prefix', async () => {
    const t = await seedWriteTenant();
    const { x } = await unfinishedId(t);
    await dbExec(sql`UPDATE backup_snapshot_id_reservations SET uploads_swept_at = NULL WHERE snapshot_id = ${x}`);
    const b = await laterJob(t);
    const waiting = await resume(t, b.session, x);
    expect(waiting).toMatchObject({ status: 409, code: 'previous_writer_active' });
    expect((waiting as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((await reservationRow(x))?.state).toBe('abandoned');
  });
});

describe('publishing after a takeover', () => {
  runDb('the earlier job\'s late result is refused; the new job\'s result publishes', async () => {
    const t = await seedWriteTenant();
    const { jobA, x } = await unfinishedId(t);
    const b = await laterJob(t);
    expect((await resume(t, b.session, x)).status).toBe(200);

    const late = await report(t, jobA, x);
    expect(late).toMatchObject({ snapshotDbId: null });
    const audit = await dbExec(sql`
      SELECT 1 FROM audit_logs WHERE action = 'backup.result.reservation_mismatch' AND resource_id = ${jobA}
    `);
    expect(audit.length).toBe(1);
    const lateReconcile = await report(t, jobA, x, 'reconcile');
    expect(lateReconcile.snapshotDbId).toBeNull();
    expect((await dbExec(sql`SELECT 1 FROM backup_snapshots WHERE snapshot_id = ${x}`)).length).toBe(0);

    const published = await report(t, b.jobB, x);
    expect(published.snapshotDbId).not.toBeNull();
    const snap = await dbExec(sql`SELECT job_id FROM backup_snapshots WHERE snapshot_id = ${x}`);
    expect(snap[0]).toMatchObject({ job_id: b.jobB });
    expect(await reservationRow(x)).toMatchObject({ current_job_id: b.jobB, published_snapshot_db_id: published.snapshotDbId });
    // A's session URLs expired more than the margin ago: nothing left to wait out.
    expect((await reservationRow(x))?.state).toBe('published');
  });

  runDb('the insert trigger refuses a direct insert from any job but the current one', async () => {
    const t = await seedWriteTenant();
    const { jobA, x } = await unfinishedId(t);
    const b = await laterJob(t);
    expect((await resume(t, b.session, x)).status).toBe(200);

    const insert = (jobId: string) => expectSqlState(() => dbExec(sql`
      INSERT INTO backup_snapshots (id, org_id, job_id, device_id, config_id, snapshot_id, storage_identity)
      VALUES (${randomUUID()}, ${t.orgId}, ${jobId}, ${t.deviceId}, ${t.configId}, ${x}, ${'s3::alias.example::shared-bucket'})
    `));
    expect(await insert(jobA)).toBe('23505');
    expect(await insert(b.jobB)).toBeNull();
  });

  runDb('the same job\'s late result is still adopted after its id was abandoned', async () => {
    const t = await seedWriteTenant();
    const { jobA, x } = await unfinishedId(t);
    const adopted = await report(t, jobA, x, 'reconcile');
    expect(adopted.snapshotDbId).not.toBeNull();
    expect(await reservationRow(x)).toMatchObject({ state: 'published', current_job_id: jobA });
  });
});

describe('transfer margin', () => {
  runDb('a continuing writer waits until the earlier writer\'s last URL expired more than the margin ago', async () => {
    const t = await seedWriteTenant();
    const { x, sessionA } = await unfinishedId(t, { abandon: false });
    // Expired five minutes ago: an upload started just before may still land.
    await dbExec(sql`UPDATE backup_storage_sessions SET url_horizon_at = now() - interval '5 minutes' WHERE id = ${sessionA}`);
    const b = await laterJob(t);
    const waiting = await resume(t, b.session, x);
    expect(waiting).toMatchObject({ status: 409, code: 'previous_writer_active' });
    const retry = (waiting as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0;
    expect(retry).toBeGreaterThan(9 * 60);
    expect(retry).toBeLessThanOrEqual(10 * 60 + 2);

    // The janitor does not abandon it either while the margin runs.
    await runBackupWriteSessionJanitor(janitorDeps);
    expect((await reservationRow(x))?.state).toBe('reserved');
  });

  runDb('publication stays sealing until URL expiry plus the margin has passed', async () => {
    const t = await seedWriteTenant();
    const a = await mintFor(t, t.jobId);
    await dbExec(sql`UPDATE backup_storage_sessions SET url_horizon_at = now() - interval '1 minute' WHERE id = ${a.sessionId}`);
    expect((await report(t, t.jobId, a.snapshotId)).snapshotDbId).not.toBeNull();
    const row = await reservationRow(a.snapshotId);
    expect(row?.state).toBe('sealing');
    const sealedUntil = new Date(String(row?.sealed_until)).getTime();
    expect(sealedUntil).toBeGreaterThan(Date.now() + 13 * 60 * 1000);
    expect(sealedUntil).toBeLessThan(Date.now() + 16 * 60 * 1000);
  });
});

describe('write session contract additions', () => {
  runDb('the session names the destination identity the helper\'s own S3 provider reports', async () => {
    const t = await seedWriteTenant();
    const a = await mintFor(t, t.jobId);
    expect(a.envelope.storageIdentity).toBe(
      `s3|${WRITE_DESTINATION.endpoint}|${WRITE_DESTINATION.region}|${WRITE_DESTINATION.bucket}`,
    );
  });

  runDb('multipart:create reports the encryption storage confirmed, and a request storage ignored', async () => {
    const plain = await seedWriteTenant();
    const p = await mintFor(plain, plain.jobId);
    const created = await createWriteSessionMultipart(p.session, `snapshots/${p.snapshotId}/files/a.bin`, runFor(plain), fakeDeps());
    expect(created).toMatchObject({ status: 200, body: { appliedEncryption: null } });

    const kms = { ...WRITE_DESTINATION, serverSideEncryption: 'aws:kms', kmsKeyId: 'arn:aws:kms:us-east-1:000000000000:key/k1' };
    const encrypted = await seedWriteTenant({ destination: kms });
    await dbExec(sql`UPDATE backup_configs SET encryption = true WHERE id = ${encrypted.configId}`);
    const e = await mintFor(encrypted, encrypted.jobId, kms);
    let requested: unknown = null;
    const confirmedKms = await createWriteSessionMultipart(e.session, `snapshots/${e.snapshotId}/files/a.bin`, runFor(encrypted), fakeDeps({
      createMultipart: async (_cfg, _key, sse) => {
        requested = sse;
        return { uploadId: 'upload-sse', encryption: { algorithm: 'aws:kms', kmsKeyId: kms.kmsKeyId } };
      },
    }));
    expect(confirmedKms).toMatchObject({
      status: 200,
      body: {
        uploadId: 'upload-sse',
        appliedEncryption: {
          algorithm: 'aws:kms', kmsKeyId: kms.kmsKeyId, requested: { algorithm: 'aws:kms', kmsKeyId: kms.kmsKeyId }, matches: true,
        },
      },
    });
    expect(requested).toEqual({ mode: 's3-sse-kms', keyId: kms.kmsKeyId });

    // A backend that ignores the encryption headers confirms nothing.
    const ignored = await createWriteSessionMultipart(e.session, `snapshots/${e.snapshotId}/files/b.bin`, runFor(encrypted), fakeDeps({
      createMultipart: async () => ({ uploadId: 'upload-plain', encryption: { algorithm: null, kmsKeyId: null } }),
    }));
    expect(ignored).toMatchObject({
      status: 200,
      body: { appliedEncryption: { algorithm: null, requested: { algorithm: 'aws:kms' }, matches: false } },
    });
  });
});

describe('in-flight deletes and refused publication', () => {
  runDb('a takeover waits while a delete through an earlier session may still be running', async () => {
    const t = await seedWriteTenant();
    const { x, sessionA, jobA } = await unfinishedId(t, { abandon: false });
    await dbExec(sql`UPDATE backup_storage_sessions SET deleting_since = now() - interval '1 minute' WHERE id = ${sessionA}`);
    const b = await laterJob(t);
    const waiting = await resume(t, b.session, x);
    expect(waiting).toMatchObject({ status: 409, code: 'previous_writer_active' });
    const retry = (waiting as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0;
    expect(retry).toBeGreaterThan(3 * 60);
    expect(retry).toBeLessThanOrEqual(4 * 60 + 2);
    expect(await reservationRow(x)).toMatchObject({ current_job_id: jobA, write_generation: 1 });

    // A marker older than the settle window was left by a call that ended.
    await dbExec(sql`UPDATE backup_storage_sessions SET deleting_since = now() - interval '6 minutes' WHERE id = ${sessionA}`);
    const c = await laterJob(t);
    expect(await resume(t, c.session, x)).toMatchObject({ status: 200, body: { mode: 'write', takeover: true } });
  });

  runDb('a refused insert for an id another job holds is reported as such, not as another organization\'s claim', async () => {
    const t = await seedWriteTenant();
    const { x } = await unfinishedId(t);
    const b = await laterJob(t);
    expect((await resume(t, b.session, x)).status).toBe(200);
    // A job with no write session (an older helper) reports the id.
    const other = await seedBackupJob(t.orgId, t.configId, t.deviceId, 'running');
    const refused: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setBackupMetricsRecorder({ onSnapshotPublishRefused: (reason: string) => { refused.push(reason); } });
    try {
      expect((await report(t, other, x)).snapshotDbId).toBeNull();
      expect(refused).toEqual(['not_current_job']);
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes('held by another backup job'))).toBe(true);
      expect(messages.some((m) => m.includes("another organization's destination"))).toBe(false);
    } finally {
      setBackupMetricsRecorder(null);
      warn.mockRestore();
    }
  });
});

describe('storage reconcile after a takeover', () => {
  runDb('attributes a server-issued id to the job currently holding it, not the job that ranks first', async () => {
    const t = await seedWriteTenant();
    const root = mkdtempSync(join(tmpdir(), 'brokered-continuation-'));
    try {
      const destination = { path: root };
      const configId = randomUUID();
      await dbExec(sql`
        INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
        VALUES (${configId}, ${t.orgId}, 'Local', 'file', 'local', ${JSON.stringify(destination)}::jsonb)
      `);
      const identity = normalizeStorageIdentity('local', destination);
      const x = `snapshot-20261108T000000Z-${randomBytes(12).toString('hex')}`;
      mkdirSync(join(root, 'snapshots', x), { recursive: true });
      writeFileSync(join(root, 'snapshots', x, 'manifest.json'), JSON.stringify({ id: x, files: [] }));

      // The earlier job A left x unfinished; B took it over and then ended
      // without reporting. Both jobs recorded x; A would rank first (it is on
      // the same configuration and was created later).
      const jobB = await seedBackupJob(t.orgId, configId, t.deviceId, 'failed');
      const jobA = await seedBackupJob(t.orgId, configId, t.deviceId, 'failed');
      await dbExec(sql`UPDATE backup_jobs SET snapshot_id = ${x}, storage_identity = ${identity},
        created_at = now() - interval '2 hours' WHERE id = ${jobB}`);
      await dbExec(sql`UPDATE backup_jobs SET snapshot_id = ${x}, storage_identity = ${identity},
        created_at = now() - interval '1 hour' WHERE id = ${jobA}`);
      await dbExec(sql`
        INSERT INTO backup_snapshot_id_reservations
          (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, current_job_id, write_generation)
        VALUES (${x}, ${t.orgId}, ${t.deviceId}, ${configId}, ${identity}, 'server_minted', 'abandoned', ${jobB}, 2)
      `);

      const result = await reconcileOrphanedBackupSnapshots({
        orgId: t.orgId, configId, runInDbContext: runFor(t),
      });
      expect(result.candidates.find((c) => c.snapshotId === x)).toMatchObject({ jobId: jobB, adopted: true });
      const snap = await dbExec(sql`SELECT job_id FROM backup_snapshots WHERE snapshot_id = ${x}`);
      expect(snap[0]).toMatchObject({ job_id: jobB });
      expect(await reservationRow(x)).toMatchObject({ state: 'published', current_job_id: jobB });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
