/**
 * The brokered-write cleanup job against real Postgres (storage faked):
 *
 *  1. a recorded multipart upload whose session was revoked or whose job
 *     ended is aborted in storage and marked aborted;
 *  2. every stray multipart upload under a finished (sealing past its
 *     horizon, published, abandoned) prefix is aborted once — including one
 *     the database never recorded — except the completed ones;
 *  3. a sealing reservation is published once its horizon has passed;
 *  4. a reserved id whose job ended is abandoned once every issued URL has
 *     expired and no recorded upload is still open.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupWriteSessionJanitor.integration.test.ts
 */
import './setup';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { runBackupWriteSessionJanitor } from '../../jobs/backupWriteSessionJanitor';
import { WRITE_IDENTITY, reservationRow, seedWriteTenant, type WriteTenant } from './backupWriteFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function newId(): string {
  return `snapshot-20261108T120000Z-${randomBytes(12).toString('hex')}`;
}

async function reservation(t: WriteTenant, opts: { state: string; horizon?: Date | null; sealedUntil?: Date | null; revoked?: boolean }) {
  const id = newId();
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, current_job_id, sealed_until)
    VALUES (${id}, ${t.orgId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'server_minted', ${opts.state}, ${t.jobId},
            ${opts.sealedUntil ? opts.sealedUntil.toISOString() : null})
  `);
  const sessionId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_storage_sessions (id, org_id, device_id, source_device_id, config_id, storage_identity, scope,
      use_file_index, token_hash, generation, max_calls, max_resolved_objects, expires_at, deadline,
      rate_calls_available, rate_objects_available, rate_refilled_at, job_id, reservation_snapshot_id,
      reservation_generation, url_horizon_at, revoked_at)
    VALUES (${sessionId}, ${t.orgId}, ${t.deviceId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'snapshot_write', false,
      ${createHash('sha256').update(sessionId).digest('hex')}, (SELECT coalesce(max(generation), 0) + 1 FROM backup_storage_sessions WHERE job_id = ${t.jobId}),
      10, 10, now() + interval '5 minutes', now() + interval '1 hour', 1, 1, now(), ${t.jobId}, ${id}, 1,
      ${opts.horizon ? opts.horizon.toISOString() : null}, ${opts.revoked ? sql`now()` : null})
  `);
  return { id, sessionId };
}

async function upload(t: WriteTenant, r: { id: string; sessionId: string }, state: string, uploadId: string | null) {
  await getTestDb().execute(sql`
    INSERT INTO backup_storage_session_uploads (org_id, device_id, session_id, reservation_snapshot_id, reservation_generation, object_key, upload_id, state)
    VALUES (${t.orgId}, ${t.deviceId}, ${r.sessionId}, ${r.id}, 1, ${`snapshots/${r.id}/files/${randomUUID()}.bin`}, ${uploadId}, ${state})
  `);
}

async function uploadStates(reservationId: string): Promise<string[]> {
  const rows = (await getTestDb().execute(sql`
    SELECT state FROM backup_storage_session_uploads WHERE reservation_snapshot_id = ${reservationId} ORDER BY upload_id
  `)) as unknown as Array<{ state: string }>;
  return rows.map((r) => r.state);
}

function storage(listed: Record<string, Array<{ key: string; uploadId: string }>> = {}) {
  return {
    abortMultipart: vi.fn(async () => undefined),
    listMultipart: vi.fn(async (_cfg: unknown, prefix: string) => listed[prefix] ?? []),
  };
}

describe('brokered write cleanup job', () => {
  runDb('aborts a recorded upload whose session was revoked (rule 1)', async () => {
    const t = await seedWriteTenant();
    const r = await reservation(t, { state: 'reserved', revoked: true });
    await upload(t, r, 'open', 'u-open');
    const s = storage();
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: s });
    expect(s.abortMultipart).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(`snapshots/${r.id}/`), 'u-open');
    expect(await uploadStates(r.id)).toEqual(['aborted']);
  });

  runDb('abandons a reserved id of an ended job only after its URLs expire (rule 4)', async () => {
    const t = await seedWriteTenant({ jobStatus: 'running' });
    const expired = await reservation(t, { state: 'reserved', horizon: new Date(Date.now() - 60_000) });
    const live = await reservation(t, { state: 'reserved', horizon: new Date(Date.now() + 120_000) });
    await upload(t, expired, 'open', 'u-e');
    await getTestDb().execute(sql`UPDATE backup_jobs SET status = 'failed' WHERE id = ${t.jobId}`);
    const s = storage();
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: s });
    expect(await uploadStates(expired.id)).toEqual(['aborted']);
    expect((await reservationRow(expired.id))?.state).toBe('abandoned');
    expect((await reservationRow(live.id))?.state).toBe('reserved');
  });

  runDb('publishes a sealing reservation once its horizon has passed (rule 3)', async () => {
    const t = await seedWriteTenant();
    const due = await reservation(t, { state: 'sealing', sealedUntil: new Date(Date.now() - 1000), revoked: true });
    const notYet = await reservation(t, { state: 'sealing', sealedUntil: new Date(Date.now() + 120_000), revoked: true });
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: storage() });
    expect((await reservationRow(due.id))?.state).toBe('published');
    expect((await reservationRow(notYet.id))?.state).toBe('sealing');
  });

  runDb('sweeps stray uploads under a finished prefix once, sparing completed ones (rule 2)', async () => {
    const t = await seedWriteTenant();
    const r = await reservation(t, { state: 'abandoned', revoked: true });
    await upload(t, r, 'completed', 'u-done');
    const prefix = `snapshots/${r.id}/`;
    const doneKey = ((await getTestDb().execute(sql`
      SELECT object_key FROM backup_storage_session_uploads WHERE upload_id = 'u-done'
    `)) as unknown as Array<{ object_key: string }>)[0]!.object_key;
    const s = storage({ [prefix]: [{ key: doneKey, uploadId: 'u-done' }, { key: `${prefix}files/stray.bin`, uploadId: 'u-stray' }] });
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: s });
    expect(s.listMultipart).toHaveBeenCalledWith(expect.anything(), prefix);
    expect(s.abortMultipart).toHaveBeenCalledTimes(1);
    expect(s.abortMultipart).toHaveBeenCalledWith(expect.anything(), `${prefix}files/stray.bin`, 'u-stray');
    expect((await reservationRow(r.id))?.uploads_swept_at).not.toBeNull();

    s.listMultipart.mockClear();
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: s });
    expect(s.listMultipart).not.toHaveBeenCalledWith(expect.anything(), prefix);
  });
});
