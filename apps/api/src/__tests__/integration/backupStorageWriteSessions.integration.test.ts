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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runOutsideDbContext, withDbAccessContext } from '../../db';
import { runBackupWriteSessionJanitor } from '../../jobs/backupWriteSessionJanitor';
import { backupWriteCredentialPayload } from '../../services/backupCommandCredentials';
import { prepareClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import { defaultVerifyDeps, verifySnapshotAttestation } from '../../services/backupAttestationVerify';
import { authenticateStorageSession, type StorageSessionRow } from '../../services/backupStorageSessions';
import {
  completeWriteSessionMultipart,
  createWriteSessionMultipart,
  deleteWriteSessionKeys,
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

/** The agent route's per-phase runner: a short org context per database phase. */
function runFor(t: { orgId: string }) {
  return <T,>(fn: () => Promise<T>) => withDbAccessContext(orgContext(t.orgId), fn);
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

    const firstSession = await authed(t, first.envelope);
    const again = await mint(t);
    expect(again.mode === 'brokered' && again.snapshotId).toBe(first.snapshotId);
    expect(again.mode === 'brokered' && (await sessionRow(again.sessionId)).generation).toBe(2);
    // The redelivered session is the only writer: the earlier one is revoked
    // and the reservation moved to a new write generation.
    expect((await sessionRow(first.sessionId)).revoked_reason).toBe('superseded_by_redelivery');
    expect((await reservationRow(first.snapshotId))?.write_generation).toBe(2);
    const stale = await withDbAccessContext(orgContext(t.orgId), () => ensureWriteSessionLive(firstSession));
    expect(stale.ok).toBe(false);
  });

  runDb('a redelivered session may not upload until every URL the earlier session issued has expired', async () => {
    const t = await seedWriteTenant();
    const first = await mint(t);
    if (first.mode !== 'brokered') throw new Error('expected brokered');
    const s1 = await authed(t, first.envelope);
    const key = `snapshots/${first.snapshotId}/files/a.bin`;
    const issued = await asAgent(t, s1, (r) => resolveWriteSessionObjects(s1, r, [{ method: 'PUT', key, size: 1 }], fakeDeps()));
    expect(issued.status).toBe(200);

    const second = await mint(t);
    if (second.mode !== 'brokered') throw new Error('expected brokered');
    const s2 = await authed(t, second.envelope);
    const put = await asAgent(t, s2, (r) => resolveWriteSessionObjects(s2, r, [{ method: 'PUT', key, size: 1 }], fakeDeps()));
    expect(put).toMatchObject({ status: 409, code: 'previous_writer_active' });
    expect((put as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
    const create = await createWriteSessionMultipart(s2, key, runFor(t), fakeDeps());
    expect(create).toMatchObject({ status: 409, code: 'previous_writer_active' });
    const get = await asAgent(t, s2, (r) => resolveWriteSessionObjects(s2, r, [{ method: 'GET', key }], fakeDeps()));
    expect(get.status).toBe(200);

    await getTestDb().execute(sql`UPDATE backup_storage_sessions SET url_horizon_at = now() - interval '1 second' WHERE id = ${s1.id}`);
    const later = await asAgent(t, s2, (r) => resolveWriteSessionObjects(s2, r, [{ method: 'PUT', key, size: 1 }], fakeDeps()));
    expect(later.status).toBe(200);
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

  runDb('a completion in flight keeps a published snapshot sealing until it settles; none starts after publication', async () => {
    const t = await seedWriteTenant();
    const minted = await mint(t);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    const session = await authed(t, minted.envelope);
    const key = `snapshots/${minted.snapshotId}/files/big.bin`;
    const created = await createWriteSessionMultipart(session, key, runFor(t), fakeDeps());
    expect(created.status).toBe(200);
    const uploadId = (created as { body: { uploadId: string } }).body.uploadId;

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const storageEntered = new Promise<void>((r) => { entered = r; });
    const completing = completeWriteSessionMultipart(session, key, uploadId, [{ partNumber: 1, etag: '"e"' }], runFor(t), fakeDeps({
      completeMultipart: async () => { entered(); await gate; },
    }));
    await storageEntered;
    // No transaction is held across the storage call: publication proceeds,
    // but cannot publish while the completion is in flight.
    await insertSnapshotRow(t, minted.snapshotId);
    expect((await reservationRow(minted.snapshotId))?.state).toBe('sealing');
    release();
    await expect(completing).resolves.toMatchObject({ status: 200 });
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: { abortMultipart: async () => undefined, listMultipart: async () => [] } });
    expect((await reservationRow(minted.snapshotId))?.state).toBe('published');

    // After publication a completion never starts.
    const after = await completeWriteSessionMultipart(session, key, uploadId, [{ partNumber: 1, etag: '"e"' }], runFor(t), fakeDeps());
    expect([409, 410]).toContain(after.status);
    const live = await withDbAccessContext(orgContext(t.orgId), () => ensureWriteSessionLive(session));
    expect(live.ok).toBe(false);
  });
});

describe('verifying the attestation of a brokered snapshot', () => {
  runDb('stays pending while the snapshot is sealing, and is verified once it is published', async () => {
    const t = await seedWriteTenant();
    const minted = await mint(t);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    const session = await authed(t, minted.envelope);
    const manifestKey = `snapshots/${minted.snapshotId}/manifest.json`;
    // An upload URL still usable keeps the published snapshot sealing.
    await asAgent(t, session, (r) => resolveWriteSessionObjects(session, r, [{ method: 'PUT', key: manifestKey, size: 8 }], fakeDeps()));
    const snapshotDbId = await insertSnapshotRow(t, minted.snapshotId);
    expect((await reservationRow(minted.snapshotId))?.state).toBe('sealing');

    const manifest = Buffer.from('{"files":[]}');
    const statement = `{"v":1,"snapshotId":"${minted.snapshotId}"}`;
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_attestations (org_id, snapshot_db_id, job_id, device_id, provider_snapshot_id, storage_identity,
        key_layout, verification_mode, accepted_via, result_received_at, format_version, statement, statement_sha256,
        manifest_key, manifest_sha256, manifest_size, status)
      VALUES (${t.orgId}, ${snapshotDbId}, ${t.jobId}, ${t.deviceId}, ${minted.snapshotId}, ${WRITE_IDENTITY},
        'legacy_flat', 'server_fetched', 'agent_result', now(), 1, ${statement},
        ${createHash('sha256').update(statement).digest('hex')}, ${manifestKey},
        ${createHash('sha256').update(manifest).digest('hex')}, ${manifest.byteLength}, 'pending')
    `);
    const fetchObject = vi.fn(async () => new Uint8Array(manifest));
    const deps = { ...defaultVerifyDeps, fetchObject };

    const whileSealing = await verifySnapshotAttestation(snapshotDbId, deps);
    expect(whileSealing).toEqual({ outcome: 'retry', reason: 'snapshot_sealing' });
    expect(fetchObject).not.toHaveBeenCalled();
    const pending = await getTestDb().execute(sql`SELECT status FROM backup_snapshot_attestations WHERE snapshot_db_id = ${snapshotDbId}`);
    expect(pending[0]).toMatchObject({ status: 'pending' });

    await getTestDb().execute(sql`
      UPDATE backup_storage_sessions SET url_horizon_at = now() - interval '1 minute' WHERE reservation_snapshot_id = ${minted.snapshotId}
    `);
    await getTestDb().execute(sql`
      UPDATE backup_snapshot_id_reservations SET sealed_until = now() - interval '1 second' WHERE snapshot_id = ${minted.snapshotId}
    `);
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: { abortMultipart: async () => undefined, listMultipart: async () => [] } });
    expect((await reservationRow(minted.snapshotId))?.state).toBe('published');
    await expect(verifySnapshotAttestation(snapshotDbId, deps)).resolves.toEqual({ outcome: 'verified' });
  });
});

describe('deleting under a write session', () => {
  const janitorStorage = { abortMultipart: async () => undefined, listMultipart: async () => [] };

  runDb('holds no transaction across the storage delete; publication meanwhile stays sealing until it settles', async () => {
    const t = await seedWriteTenant();
    const minted = await mint(t);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    const session = await authed(t, minted.envelope);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const storageEntered = new Promise<void>((r) => { entered = r; });
    const deleting = deleteWriteSessionKeys(session, [`snapshots/${minted.snapshotId}/files/tmp.bin`], runFor(t), fakeDeps({
      deleteKeys: async (_cfg, keys) => { entered(); await gate; return { deleted: keys, failed: [] }; },
    }));
    await storageEntered;
    // Not blocked by the delete: no reservation lock is held across it.
    await insertSnapshotRow(t, minted.snapshotId);
    expect((await reservationRow(minted.snapshotId))?.state).toBe('sealing');
    release();
    await expect(deleting).resolves.toMatchObject({ status: 200 });
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: janitorStorage });
    expect((await reservationRow(minted.snapshotId))?.state).toBe('published');
  });

  runDb('the cleanup job settles a delete that never finished', async () => {
    const t = await seedWriteTenant();
    const minted = await mint(t);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    await getTestDb().execute(sql`
      UPDATE backup_storage_sessions SET deleting_since = now() - interval '10 minutes' WHERE id = ${minted.sessionId}
    `);
    await insertSnapshotRow(t, minted.snapshotId);
    expect((await reservationRow(minted.snapshotId))?.state).toBe('sealing');
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: janitorStorage });
    expect((await sessionRow(minted.sessionId)).deleting_since).toBeNull();
    expect((await reservationRow(minted.snapshotId))?.state).toBe('published');
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
    resumeWriteSession(session, j, runFor(t), fakeDeps());

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

  runDb('refuses to resume an id recorded for an older helper\'s job', async () => {
    const t = await seedWriteTenant();
    const j = await journaledId(t);
    await getTestDb().execute(sql`UPDATE backup_snapshot_id_reservations SET source = 'legacy_job' WHERE snapshot_id = ${j}`);
    const { session } = await freshSession(t);
    expect(await resume(t, session, j)).toMatchObject({ status: 409, code: 'not_resumable' });
  });

  runDb('aborts the previous writer\'s open uploads before ownership moves', async () => {
    const t = await seedWriteTenant();
    const j = await journaledId(t);
    const prevSession = ((await getTestDb().execute(sql`
      SELECT id FROM backup_storage_sessions WHERE reservation_snapshot_id = ${j}
    `)) as unknown as Array<{ id: string }>)[0]!.id;
    await getTestDb().execute(sql`
      INSERT INTO backup_storage_session_uploads (org_id, device_id, session_id, reservation_snapshot_id, reservation_generation, object_key, upload_id, state)
      VALUES (${t.orgId}, ${t.deviceId}, ${prevSession}, ${j}, 1, ${`snapshots/${j}/files/big.bin`}, 'u-prev', 'open')
    `);
    const aborted: string[] = [];
    const { session } = await freshSession(t);
    const result = await resumeWriteSession(session, j, runFor(t), fakeDeps({
      abortMultipart: async (_cfg, _key, uploadId) => { aborted.push(uploadId); },
    }));
    expect(result).toMatchObject({ status: 200, body: { mode: 'write' } });
    expect(aborted).toEqual(['u-prev']);
    const states = await getTestDb().execute(sql`SELECT state FROM backup_storage_session_uploads WHERE upload_id = 'u-prev'`);
    expect(states[0]).toMatchObject({ state: 'aborted' });

    // A failed abort refuses the resume and moves nothing.
    const j2 = await journaledId(t);
    const prev2 = ((await getTestDb().execute(sql`
      SELECT id FROM backup_storage_sessions WHERE reservation_snapshot_id = ${j2}
    `)) as unknown as Array<{ id: string }>)[0]!.id;
    await getTestDb().execute(sql`
      INSERT INTO backup_storage_session_uploads (org_id, device_id, session_id, reservation_snapshot_id, reservation_generation, object_key, upload_id, state)
      VALUES (${t.orgId}, ${t.deviceId}, ${prev2}, ${j2}, 1, ${`snapshots/${j2}/files/big.bin`}, 'u-prev-2', 'open')
    `);
    const other = await freshSession(t);
    const refused = await resumeWriteSession(other.session, j2, runFor(t), fakeDeps({
      abortMultipart: async () => { throw new Error('storage unavailable'); },
    }));
    expect(refused).toMatchObject({ status: 409, code: 'previous_writer_active' });
    expect((await reservationRow(j2))?.write_generation).toBe(1);
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

  runDb('a lost result is still adopted after the cleanup job abandoned the id of the ended job', async () => {
    const t = await seedWriteTenant();
    const minted = await mint(t);
    if (minted.mode !== 'brokered') throw new Error('expected brokered');
    await getTestDb().execute(sql`UPDATE backup_jobs SET status = 'failed' WHERE id = ${t.jobId}`);
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: { abortMultipart: async () => undefined, listMultipart: async () => [] } });
    expect((await reservationRow(minted.snapshotId))?.state).toBe('abandoned');

    const outcome = await withDbAccessContext(orgContext(t.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: t.jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed', source: 'reconcile',
        result: { snapshotId: minted.snapshotId, filesBackedUp: 1, bytesBackedUp: 1 },
      }),
    );
    expect(outcome.snapshotDbId).not.toBeNull();
    expect((await reservationRow(minted.snapshotId))?.state).toBe('published');
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

describe('delivering a queued database backup', () => {
  const previous = process.env.PUBLIC_API_URL;
  beforeAll(() => { process.env.PUBLIC_API_URL = 'https://api.breeze.example'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = previous;
  });

  async function deliver(t: WriteTenant, reported: number) {
    const commandId = randomUUID();
    const payload = {
      jobId: t.jobId,
      configId: t.configId,
      ...backupWriteCredentialPayload(t.configId, t.orgId, { provider: 's3', storageEncryption: { required: false, mode: 'disabled' } }),
      instance: 'MSSQLSERVER',
      database: 'db1',
    };
    await getTestDb().execute(sql`
      INSERT INTO device_commands (id, device_id, type, status, payload, executed_at)
      VALUES (${commandId}, ${t.deviceId}, 'mssql_backup', 'sent', ${JSON.stringify(payload)}::jsonb, now())
    `);
    const [out] = await runOutsideDbContext(() =>
      withDbAccessContext(orgContext(t.orgId), () =>
        prepareClaimedCommandsForDelivery(
          [{ id: commandId, type: 'mssql_backup', deviceId: t.deviceId, payload, executedAt: new Date() }],
          { reportedBackupWriteProtocolVersion: reported },
        ),
      ),
    );
    return (out as unknown as { payload: Record<string, unknown> }).payload;
  }

  runDb('a helper reporting brokered writes gets a write session and no storage destination', async () => {
    const t = await seedWriteTenant({ jobStatus: 'pending' });
    const payload = await deliver(t, 1);
    expect(payload).not.toHaveProperty('providerConfig');
    expect(payload).not.toHaveProperty('providerConfigRef');
    expect(payload.storageSession).toMatchObject({ scope: 'snapshot_write', baseUrl: 'https://api.breeze.example' });
    const id = (payload.storageSession as { snapshotId: string }).snapshotId;
    expect(await reservationRow(id)).toMatchObject({ org_id: t.orgId, current_job_id: t.jobId, state: 'reserved' });
  });

  runDb('any other helper is delivered exactly as before', async () => {
    const t = await seedWriteTenant({ jobStatus: 'pending', writeProtocol: 0 });
    const payload = await deliver(t, 0);
    expect(payload.providerConfig).toMatchObject({ bucket: WRITE_DESTINATION.bucket });
    expect(payload).not.toHaveProperty('storageSession');
  });
});
