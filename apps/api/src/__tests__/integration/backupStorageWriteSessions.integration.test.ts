/**
 * Write-scoped storage sessions against real Postgres, as the app role in
 * the agent's organization context (storage calls are faked):
 *
 *  - minting reserves a server-issued id to the job, records it on the job,
 *    reuses it on redelivery, and never mints for an incapable helper;
 *  - only keys under the reserved id resolve; base manifest via control key;
 *  - a multipart completion and the publication of the snapshot serialize on
 *    the reservation row: a completion either finishes before the seal or is
 *    refused after it, never after;
 *  - resume: exactly one of two concurrent resumes wins; another device or
 *    organization is refused; an unexpired URL of the previous writer
 *    refuses; a published id resumes read-only; a second resume is refused;
 *  - a result naming a snapshot other than the one the job was allowed to
 *    write is refused and audited; the right one publishes and seals.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupStorageWriteSessions.integration.test.ts
 */
import './setup';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { withDbAccessContext } from '../../db';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import { authenticateStorageSession, type StorageSessionRow } from '../../services/backupStorageSessions';
import {
  completeWriteSessionMultipart,
  createWriteSessionMultipart,
  ensureWriteSessionLive,
  mintBackupWriteSession,
  resolveWriteSessionObjects,
  resumeWriteSession,
  type WriteSessionDeps,
} from '../../services/backupStorageWriteSessions';
import {
  WRITE_DESTINATION,
  WRITE_IDENTITY,
  insertSnapshotRow,
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
        headers: { 'content-length': String(size), ...(opts.ifNoneMatch ? { 'if-none-match': '*' } : {}) },
        expiresAt: new Date(Date.now() + opts.expiresInSeconds * 1000),
      }),
      presignPart: async (_cfg, key, uploadId, partNumber, size, ttl) => ({
        url: `https://storage.example/${key}?uploadId=${uploadId}&partNumber=${partNumber}`,
        headers: { 'content-length': String(size) },
        expiresAt: new Date(Date.now() + ttl * 1000),
      }),
      presignGet: async (_cfg, key) => `https://storage.example/${key}?get`,
      createMultipart: async () => `upload-${randomUUID()}`,
      completeMultipart: async () => undefined,
      abortMultipart: async () => undefined,
      listMultipart: async () => [],
      listKeys: async () => ({ keys: [], nextToken: null }),
      deleteKeys: async (_cfg, keys) => ({ deleted: keys, failed: [] }),
      ...overrides,
    },
  };
}

async function mint(t: WriteTenant, jobId = t.jobId, deps = fakeDeps(), baseManifestKey: string | null = null) {
  return withDbAccessContext(orgContext(t.orgId), () =>
    mintBackupWriteSession({
      orgId: t.orgId,
      jobId,
      deviceId: t.deviceId,
      configId: t.configId,
      provider: 's3',
      providerConfig: WRITE_DESTINATION,
      baseManifestKey,
    }, deps),
  );
}

async function authed(t: { orgId: string; deviceId: string }, envelope: Record<string, unknown>): Promise<StorageSessionRow> {
  const auth = await withDbAccessContext(orgContext(t.orgId), () =>
    authenticateStorageSession({
      sessionId: envelope.sessionId as string,
      token: envelope.token as string,
      agent: { deviceId: t.deviceId, orgId: t.orgId },
    }),
  );
  if (!auth.ok) throw new Error(`authentication failed: ${auth.error}`);
  return auth.session;
}

/** Runs `fn` as the device's agent request would: org context, live check first. */
async function asAgent<T>(t: { orgId: string }, session: StorageSessionRow, fn: (reservation: NonNullable<Awaited<ReturnType<typeof ensureWriteSessionLive>> & { ok: true }>['reservation']) => Promise<T>) {
  return withDbAccessContext(orgContext(t.orgId), async () => {
    const live = await ensureWriteSessionLive(session);
    if (!live.ok) return { status: live.status, code: 'not_live' } as unknown as T;
    return fn(live.reservation);
  });
}

async function sessionRow(id: string) {
  const rows = await getTestDb().execute(sql`SELECT * FROM backup_storage_sessions WHERE id = ${id}`);
  return rows[0] as Record<string, unknown>;
}

describe('write-scoped storage sessions', () => {
  runDb('mints a session bound to a server-issued id reserved to the job; redelivery reuses it', async () => {
    const t = await seedWriteTenant();
    const first = await mint(t);
    expect(first.mode).toBe('brokered');
    if (first.mode !== 'brokered') return;
    expect(first.snapshotId).toMatch(/^snapshot-\d{8}T\d{6}Z-[0-9a-f]{24}$/);
    expect(first.envelope).toMatchObject({ scope: 'snapshot_write', snapshotId: first.snapshotId, version: 1 });
    expect(await reservationRow(first.snapshotId)).toMatchObject({
      org_id: t.orgId, device_id: t.deviceId, source: 'server_minted', state: 'reserved', current_job_id: t.jobId,
    });
    const row = await sessionRow(first.sessionId);
    expect(row).toMatchObject({ scope: 'snapshot_write', job_id: t.jobId, reservation_snapshot_id: first.snapshotId, command_id: null, generation: 1 });
    expect(row.token_hash).not.toBe(first.envelope.token);
    const job = await getTestDb().execute(sql`SELECT snapshot_id FROM backup_jobs WHERE id = ${t.jobId}`);
    expect(job[0]).toMatchObject({ snapshot_id: first.snapshotId });

    const again = await mint(t);
    expect(again.mode === 'brokered' && again.snapshotId).toBe(first.snapshotId);
    expect(again.mode === 'brokered' && (await sessionRow(again.sessionId)).generation).toBe(2);
  });

  runDb('does not mint for a helper that has not reported brokered writes', async () => {
    const t = await seedWriteTenant({ writeProtocol: 0 });
    await expect(mint(t)).resolves.toEqual({ mode: 'unbrokered', reason: 'helper_unsupported' });
    const rows = await getTestDb().execute(sql`SELECT 1 FROM backup_storage_sessions WHERE job_id = ${t.jobId}`);
    expect(rows.length).toBe(0);
  });

  runDb('resolves only keys under the reserved id (plus the server-selected base manifest)', async () => {
    const t = await seedWriteTenant();
    const base = 'snapshot-20261101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa';
    const minted = await mint(t, t.jobId, fakeDeps(), `snapshots/${base}/manifest.json`);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    const session = await authed(t, minted.envelope);
    const id = minted.snapshotId;
    const result = await asAgent(t, session, (reservation) =>
      resolveWriteSessionObjects(session, reservation, [
        { method: 'PUT', key: `snapshots/${id}/files/a.bin`, size: 10 },
        { method: 'PUT', key: `snapshots/${base}/files/a.bin`, size: 10 },
        { method: 'GET', key: `snapshots/${base}/manifest.json` },
        { method: 'GET', key: `snapshots/${base}/files/b.bin` },
        { method: 'UPLOAD_PART', key: `snapshots/${id}/files/big.bin`, uploadId: 'never-created', partNumber: 1, size: 10 },
      ], fakeDeps()),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.objects.map((o) => `${o.method} ${o.key}`)).toEqual([
      `PUT snapshots/${id}/files/a.bin`,
      `GET snapshots/${base}/manifest.json`,
    ]);
    expect(result.body.denied.map((d) => d.code)).toEqual(['outside_reservation', 'outside_reservation', 'unknown_upload']);
    expect((await sessionRow(session.id)).url_horizon_at).not.toBeNull();
  });

  runDb('a multipart completion and the snapshot publication serialize on the reservation', async () => {
    const t = await seedWriteTenant();
    const minted = await mint(t);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    const session = await authed(t, minted.envelope);
    const key = `snapshots/${minted.snapshotId}/files/big.bin`;
    const created = await asAgent(t, session, () => createWriteSessionMultipart(session, key, fakeDeps()));
    expect(created.status).toBe(200);
    const uploadId = (created as { body: { uploadId: string } }).body.uploadId;

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const storageEntered = new Promise<void>((r) => { entered = r; });
    const completing = asAgent(t, session, () =>
      completeWriteSessionMultipart(session, key, uploadId, [{ partNumber: 1, etag: '"e"' }], fakeDeps({
        completeMultipart: async () => { entered(); await gate; },
      })),
    );
    await storageEntered;
    let published = false;
    const publishing = insertSnapshotRow(t, minted.snapshotId).then(() => { published = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(published).toBe(false); // blocked on the reservation row lock
    release();
    await expect(completing).resolves.toMatchObject({ status: 200 });
    await publishing;
    expect(published).toBe(true);
    expect(['sealing', 'published']).toContain((await reservationRow(minted.snapshotId))?.state);

    // After publication a completion is refused, never applied.
    const after = await withDbAccessContext(orgContext(t.orgId), () =>
      completeWriteSessionMultipart(session, key, uploadId, [{ partNumber: 1, etag: '"e"' }], fakeDeps()),
    );
    // The seal revoked the session (410); a session revoked some other way
    // still meets the reservation lock (409). Either way nothing is applied.
    expect([409, 410]).toContain(after.status);
    const live = await withDbAccessContext(orgContext(t.orgId), () => ensureWriteSessionLive(session));
    expect(live.ok).toBe(false);
  });
});

describe('resuming a journaled snapshot id', () => {
  async function journaledId(t: WriteTenant, opts: { horizon?: Date | null; state?: string } = {}) {
    // A previous job of the same device reserved J and has ended.
    const prevJob = await seedBackupJob(t.orgId, t.configId, t.deviceId, 'failed');
    const j = `snapshot-20261107T000000Z-${randomBytes(12).toString('hex')}`;
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, current_job_id)
      VALUES (${j}, ${t.orgId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'server_minted', ${opts.state ?? 'reserved'}, ${prevJob})
    `);
    await getTestDb().execute(sql`
      INSERT INTO backup_storage_sessions (org_id, device_id, source_device_id, config_id, storage_identity, scope,
        use_file_index, token_hash, generation, max_calls, max_resolved_objects, expires_at, deadline,
        rate_calls_available, rate_objects_available, rate_refilled_at, job_id, reservation_snapshot_id,
        reservation_generation, url_horizon_at, revoked_at)
      VALUES (${t.orgId}, ${t.deviceId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'snapshot_write', false,
        ${randomBytes(32).toString('hex')}, 1, 10, 10, now() + interval '1 minute', now() + interval '1 hour', 1, 1, now(),
        ${prevJob}, ${j}, 1, ${(opts.horizon === undefined ? new Date(Date.now() - 60_000) : opts.horizon)?.toISOString() ?? null}, now())
    `);
    return j;
  }

  async function freshSession(t: WriteTenant) {
    const job = await seedBackupJob(t.orgId, t.configId, t.deviceId, 'running');
    const minted = await mint(t, job);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    return { job, minted, session: await authed(t, minted.envelope) };
  }

  const resume = (t: { orgId: string }, session: StorageSessionRow, j: string) =>
    withDbAccessContext(orgContext(t.orgId), () => resumeWriteSession(session, j, fakeDeps()));

  runDb('exactly one of two concurrent resumes wins; the loser is refused', async () => {
    const t = await seedWriteTenant();
    const j = await journaledId(t);
    const a = await freshSession(t);
    const b = await freshSession(t);
    const results = await Promise.all([resume(t, a.session, j), resume(t, b.session, j)]);
    const wins = results.filter((r) => r.status === 200);
    expect(wins).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    const winner = results[0]!.status === 200 ? a : b;
    expect(await reservationRow(j)).toMatchObject({ current_job_id: winner.job, write_generation: 2, state: 'reserved' });
    expect((await reservationRow(winner.minted.snapshotId))?.state).toBe('abandoned');
  });

  runDb('refuses another device, another organization, a live previous URL and a second resume', async () => {
    const t = await seedWriteTenant();
    const j = await journaledId(t);

    const siblingDevice = await seedWriteDevice(t.orgId, t.siteId, 1);
    const siblingJob = await seedBackupJob(t.orgId, t.configId, siblingDevice, 'running');
    const sibling = await withDbAccessContext(orgContext(t.orgId), () => mintBackupWriteSession({
      orgId: t.orgId, jobId: siblingJob, deviceId: siblingDevice, configId: t.configId, provider: 's3',
      providerConfig: WRITE_DESTINATION, baseManifestKey: null,
    }, fakeDeps()));
    if (sibling.mode !== 'brokered') throw new Error('expected brokered');
    const siblingSession = await authed({ orgId: t.orgId, deviceId: siblingDevice }, sibling.envelope);
    expect(await resume(t, siblingSession, j)).toMatchObject({ status: 409, code: 'not_resumable' });

    const other = await seedWriteTenant();
    const otherSession = (await freshSession(other)).session;
    expect(await resume(other, otherSession, j)).toMatchObject({ status: 409, code: 'not_resumable' });

    const busy = await journaledId(t, { horizon: new Date(Date.now() + 120_000) });
    const s1 = (await freshSession(t)).session;
    expect(await resume(t, s1, busy)).toMatchObject({ status: 409, code: 'previous_writer_active' });

    const s2 = (await freshSession(t)).session;
    expect(await resume(t, s2, j)).toMatchObject({ status: 200, body: { mode: 'write', snapshotId: j } });
    const row = await sessionRow(s2.id);
    expect(row.resumed_at).not.toBeNull();
    const second = await resume(t, { ...s2, resumedAt: row.resumed_at as Date, reservationSnapshotId: j, reservationGeneration: 2 }, await journaledId(t));
    expect(second).toMatchObject({ status: 409, code: 'not_resumable' });
  });

  runDb('a published id resumes read-only', async () => {
    const t = await seedWriteTenant();
    const j = await journaledId(t, { state: 'published' });
    const { session } = await freshSession(t);
    expect(await resume(t, session, j)).toMatchObject({ status: 200, body: { mode: 'read_only_completion', snapshotId: j } });
    const row = await sessionRow(session.id);
    expect(row).toMatchObject({ read_only: true, reservation_snapshot_id: j });
    const reloaded = { ...session, readOnly: true, reservationSnapshotId: j, reservationGeneration: 1, resumedAt: new Date() };
    const result = await asAgent(t, reloaded, (reservation) =>
      resolveWriteSessionObjects(reloaded, reservation, [
        { method: 'GET', key: `snapshots/${j}/manifest.json` },
        { method: 'PUT', key: `snapshots/${j}/manifest.json`, size: 1 },
      ], fakeDeps()),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.objects.map((o) => o.method)).toEqual(['GET']);
    expect(result.body.denied[0]).toMatchObject({ method: 'PUT', code: 'read_only' });
  });
});

describe('publishing a brokered snapshot', () => {
  runDb('refuses a result naming a snapshot the job was not allowed to write, and audits it', async () => {
    const t = await seedWriteTenant();
    const minted = await mint(t);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    const wrong = `snapshot-20261108T000000Z-${randomBytes(12).toString('hex')}`;
    const outcome = await withDbAccessContext(orgContext(t.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: t.jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed',
        result: { snapshotId: wrong, filesBackedUp: 1, bytesBackedUp: 1 },
      }),
    );
    expect(outcome).toMatchObject({ applied: true, snapshotDbId: null });
    const job = await getTestDb().execute(sql`SELECT status, error_log FROM backup_jobs WHERE id = ${t.jobId}`);
    expect(job[0]).toMatchObject({ status: 'failed' });
    expect(String((job[0] as { error_log: string }).error_log)).toContain('different snapshot');
    expect((await getTestDb().execute(sql`SELECT 1 FROM backup_snapshots WHERE snapshot_id = ${wrong}`)).length).toBe(0);
    const audit = await getTestDb().execute(sql`
      SELECT 1 FROM audit_logs WHERE action = 'backup.result.reservation_mismatch' AND resource_id = ${t.jobId}
    `);
    expect(audit.length).toBe(1);
  });

  runDb('publishing the issued id seals the reservation and ends the job\'s write sessions', async () => {
    const t = await seedWriteTenant();
    const minted = await mint(t);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    const outcome = await withDbAccessContext(orgContext(t.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: t.jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed',
        result: { snapshotId: minted.snapshotId, filesBackedUp: 1, bytesBackedUp: 1 },
      }),
    );
    expect(outcome.snapshotDbId).not.toBeNull();
    expect((await reservationRow(minted.snapshotId))?.state).toBe('published');
    expect((await sessionRow(minted.sessionId)).revoked_at).not.toBeNull();
  });
});
