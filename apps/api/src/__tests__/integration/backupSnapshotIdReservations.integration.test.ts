/**
 * Snapshot id ownership against real Postgres, as the unprivileged app role:
 *
 *  - an id is owned once across organizations and endpoint spellings: a
 *    second organization's snapshot row with an owned id is refused, whatever
 *    storage identity it names;
 *  - the migration backfill tombstones ids carried by several rows and reserves
 *    every other id (published rows, in-flight jobs);
 *  - deleting a reservation (device deletion, org erasure) tombstones its id,
 *    and a tombstoned id can never be reserved again;
 *  - a reservation (and a storage session, and an upload row) can only name
 *    parents in its own organization;
 *  - RLS: an organization cannot read another's reservations; tombstones are
 *    system-only and append-only for the app role;
 *  - write-session shape: read rows need a command + snapshot, write rows a
 *    job + reservation; a finished job revokes its own write sessions only;
 *  - a device move restamps reservations, write sessions and upload rows.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotIdReservations.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import {
  WRITE_DESTINATION_ALIAS,
  WRITE_IDENTITY,
  expectSqlState,
  insertSnapshotRow,
  orgContext,
  reservationRow,
  seedBackupJob,
  seedWriteTenant,
  tombstoneReason,
} from './backupWriteFixtures';
import { createUser } from './db-utils';
import { getTestDb } from './setup';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION = resolve(__dirname, '../../../migrations/2026-11-08-120000-backup-snapshot-id-reservations.sql');

/** The migration's backfill statements only (re-running the whole file would
 *  replace trigger functions that a later migration redefines). */
function backfillSection(): string {
  const text = readFileSync(MIGRATION, 'utf8');
  const start = text.indexOf('-- ── Backfill');
  const end = text.indexOf('-- The insert trigger is created AFTER the backfill');
  if (start < 0 || end < 0) throw new Error('backfill markers not found in migration');
  return text.slice(start, end);
}

function sid(label: string): string {
  return `snapshot-20261108T120000Z-${createHash('sha256').update(label + randomUUID()).digest('hex').slice(0, 24)}`;
}

async function reserveAs(orgId: string, values: Record<string, unknown>) {
  return withDbAccessContext(orgContext(orgId), () =>
    db.execute(sql`
      INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, device_id, config_id, source, state, current_job_id)
      VALUES (${values.snapshotId as string}, ${orgId}, ${(values.deviceId as string) ?? null}, ${(values.configId as string) ?? null},
              'server_minted', 'reserved', ${(values.jobId as string) ?? null})
    `),
  );
}

async function insertWriteSession(
  t: { orgId: string; deviceId: string; configId: string; jobId: string },
  reservationSnapshotId: string,
  extra: { horizon?: Date | null; conditional?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_storage_sessions (
      id, org_id, device_id, source_device_id, config_id, storage_identity, scope, use_file_index, token_hash,
      generation, max_calls, max_resolved_objects, expires_at, deadline, rate_calls_available,
      rate_objects_available, rate_refilled_at, job_id, reservation_snapshot_id, reservation_generation,
      url_horizon_at, conditional_writes)
    VALUES (${id}, ${t.orgId}, ${t.deviceId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'snapshot_write', false,
            ${createHash('sha256').update(id).digest('hex')}, 1, 100, 100, now() + interval '10 minutes',
            now() + interval '1 hour', 10, 10, now(), ${t.jobId}, ${reservationSnapshotId}, 1,
            ${extra.horizon ? extra.horizon.toISOString() : null}, ${extra.conditional ?? false})
  `);
  return id;
}

describe('backup snapshot id reservations', () => {
  runDb('refuses a second organization\'s snapshot row for an owned id, under any endpoint spelling', async () => {
    const a = await seedWriteTenant();
    const b = await seedWriteTenant({ destination: WRITE_DESTINATION_ALIAS });
    const id = sid('cross-org');
    await reserveAs(a.orgId, { snapshotId: id, deviceId: a.deviceId, configId: a.configId, jobId: a.jobId });

    const aliasIdentity = normalizeStorageIdentity('s3', WRITE_DESTINATION_ALIAS);
    expect(aliasIdentity).not.toBe(WRITE_IDENTITY);
    const code = await expectSqlState(() =>
      withDbAccessContext(orgContext(b.orgId), () =>
        db.execute(sql`
          INSERT INTO backup_snapshots (org_id, job_id, device_id, config_id, snapshot_id, storage_identity)
          VALUES (${b.orgId}, ${b.jobId}, ${b.deviceId}, ${b.configId}, ${id}, ${aliasIdentity})
        `),
      ),
    );
    expect(code).toBe('23505');
    const rows = await getTestDb().execute(sql`SELECT 1 FROM backup_snapshots WHERE snapshot_id = ${id}`);
    expect(rows.length).toBe(0);
    expect((await reservationRow(id))?.org_id).toBe(a.orgId);
  });

  runDb('an agent result naming an id owned by another organization records the job but no snapshot row', async () => {
    const a = await seedWriteTenant();
    const b = await seedWriteTenant({ destination: WRITE_DESTINATION_ALIAS });
    await getTestDb().execute(sql`UPDATE backup_jobs SET storage_identity = ${normalizeStorageIdentity('s3', WRITE_DESTINATION_ALIAS)} WHERE id = ${b.jobId}`);
    const id = sid('result-cross-org');
    await reserveAs(a.orgId, { snapshotId: id, deviceId: a.deviceId, configId: a.configId, jobId: a.jobId });

    const outcome = await withDbAccessContext(orgContext(b.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: b.jobId,
        orgId: b.orgId,
        deviceId: b.deviceId,
        resultStatus: 'completed',
        result: { snapshotId: id, filesBackedUp: 1, bytesBackedUp: 10 },
      }),
    );
    expect(outcome).toMatchObject({ applied: true, snapshotDbId: null });
    const rows = await getTestDb().execute(sql`SELECT 1 FROM backup_snapshots WHERE snapshot_id = ${id}`);
    expect(rows.length).toBe(0);
  });

  runDb('a legacy writer\'s first snapshot row reserves its id; the owner may publish it again', async () => {
    const a = await seedWriteTenant();
    const id = sid('legacy');
    await withDbAccessContext(orgContext(a.orgId), () =>
      db.execute(sql`
        INSERT INTO backup_snapshots (org_id, job_id, device_id, config_id, snapshot_id, storage_identity)
        VALUES (${a.orgId}, ${a.jobId}, ${a.deviceId}, ${a.configId}, ${id}, ${WRITE_IDENTITY})
      `),
    );
    const r = await reservationRow(id);
    expect(r).toMatchObject({ org_id: a.orgId, device_id: a.deviceId, source: 'legacy_published', state: 'published' });

    // Same org + device under another identity: matched, not refused.
    await insertSnapshotRow(a, id, 'other-identity');
    // Another device of the same org: refused.
    const sibling = await seedWriteTenant();
    const code = await expectSqlState(() => insertSnapshotRow({ ...a, deviceId: sibling.deviceId }, id, 'third-identity'));
    expect(code).toBe('23505');
  });

  runDb('backfill tombstones ambiguous ids and reserves published and in-flight ids', async () => {
    const a = await seedWriteTenant();
    const b = await seedWriteTenant();
    const dup = sid('dup');
    const single = sid('single');
    const inflight = sid('inflight');
    const retired = sid('retired');
    const tx = getTestDb();
    await tx.execute(sql`ALTER TABLE backup_snapshots DISABLE TRIGGER backup_snapshots_reserve_id`);
    try {
      await insertSnapshotRow(a, dup, 'identity-one');
      await insertSnapshotRow(b, dup, 'identity-two');
      await insertSnapshotRow(a, single);
      await tx.execute(sql`UPDATE backup_jobs SET snapshot_id = ${inflight} WHERE id = ${b.jobId}`);
      await tx.execute(sql`
        INSERT INTO backup_snapshot_retirements (org_id, config_id, device_id, snapshot_id, storage_identity, reason)
        VALUES (${a.orgId}, ${a.configId}, ${a.deviceId}, ${retired}, ${WRITE_IDENTITY}, 'expired')
      `);
      await getTestDb().execute(sql.raw(backfillSection()));
    } finally {
      await tx.execute(sql`ALTER TABLE backup_snapshots ENABLE TRIGGER backup_snapshots_reserve_id`);
    }

    expect(await tombstoneReason(dup)).toBe('legacy_duplicate');
    expect(await reservationRow(dup)).toBeNull();
    expect(await reservationRow(single)).toMatchObject({ org_id: a.orgId, state: 'published', source: 'legacy_published' });
    expect(await reservationRow(inflight)).toMatchObject({
      org_id: b.orgId, state: 'reserved', source: 'legacy_job', current_job_id: b.jobId,
    });
    expect(await tombstoneReason(retired)).toBe('retired');

    // A tombstoned id is refused to every writer, including its old owner.
    const code = await expectSqlState(() => insertSnapshotRow(a, dup, 'identity-three'));
    expect(code).toBe('23505');
  });

  runDb('deleting a reservation leaves a tombstone; the id is never reserved again', async () => {
    const a = await seedWriteTenant();
    const id = sid('device-delete');
    await reserveAs(a.orgId, { snapshotId: id, deviceId: a.deviceId, configId: a.configId, jobId: a.jobId });
    await getTestDb().execute(sql`DELETE FROM backup_snapshot_id_reservations WHERE device_id = ${a.deviceId}`);
    expect(await tombstoneReason(id)).toBe('reservation_deleted');

    const b = await seedWriteTenant();
    const code = await expectSqlState(() => reserveAs(b.orgId, { snapshotId: id, deviceId: b.deviceId }));
    expect(code).toBe('23505');
  });

  runDb('refuses a reservation that names another organization\'s job, device or configuration', async () => {
    const a = await seedWriteTenant();
    const b = await seedWriteTenant();
    for (const values of [
      { jobId: b.jobId, deviceId: a.deviceId },
      { deviceId: b.deviceId },
      { deviceId: a.deviceId, configId: b.configId },
    ]) {
      const code = await expectSqlState(() => reserveAs(a.orgId, { snapshotId: sid('guard'), ...values }));
      expect(code).toBe('42501');
    }
    // As the superuser too (the guard does not depend on RLS visibility).
    const code = await expectSqlState(() =>
      getTestDb().execute(sql`
        INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, source, state, current_job_id)
        VALUES (${sid('guard-su')}, ${a.orgId}, 'server_minted', 'reserved', ${b.jobId})
      `),
    );
    expect(code).toBe('42501');
  });

  runDb('RLS: reservations are org-isolated; tombstones are system-only and append-only', async () => {
    const a = await seedWriteTenant();
    const b = await seedWriteTenant();
    const id = sid('rls');
    await reserveAs(b.orgId, { snapshotId: id, deviceId: b.deviceId });
    const visible = await withDbAccessContext(orgContext(a.orgId), () =>
      db.execute(sql`SELECT snapshot_id FROM backup_snapshot_id_reservations WHERE snapshot_id = ${id}`),
    );
    expect(visible.length).toBe(0);
    const updated = await withDbAccessContext(orgContext(a.orgId), () =>
      db.execute(sql`UPDATE backup_snapshot_id_reservations SET state = 'abandoned' WHERE snapshot_id = ${id} RETURNING 1`),
    );
    expect(updated.length).toBe(0);

    await getTestDb().execute(sql`INSERT INTO backup_snapshot_id_tombstones (snapshot_id, reason) VALUES (${id + '-t'}, 'retired')`);
    const tenantRead = await withDbAccessContext(orgContext(a.orgId), () =>
      db.execute(sql`SELECT 1 FROM backup_snapshot_id_tombstones`),
    );
    expect(tenantRead.length).toBe(0);
    const systemRead = await withSystemDbAccessContext(() =>
      db.execute(sql`SELECT 1 FROM backup_snapshot_id_tombstones WHERE snapshot_id = ${id + '-t'}`),
    );
    expect(systemRead.length).toBe(1);
    for (const stmt of [
      sql`UPDATE backup_snapshot_id_tombstones SET reason = 'retired' WHERE snapshot_id = ${id + '-t'}`,
      sql`DELETE FROM backup_snapshot_id_tombstones WHERE snapshot_id = ${id + '-t'}`,
    ]) {
      const code = await expectSqlState(() => withSystemDbAccessContext(() => db.execute(stmt)));
      expect(code).toBe('42501');
    }
  });

  runDb('org erasure removes reservations and write rows and leaves tombstones', async () => {
    const a = await seedWriteTenant();
    const id = sid('erasure');
    await reserveAs(a.orgId, { snapshotId: id, deviceId: a.deviceId, configId: a.configId, jobId: a.jobId });
    const sessionId = await insertWriteSession(a, id);
    await getTestDb().execute(sql`
      INSERT INTO backup_storage_session_uploads (org_id, device_id, session_id, reservation_snapshot_id, reservation_generation, object_key, upload_id, state)
      VALUES (${a.orgId}, ${a.deviceId}, ${sessionId}, ${id}, 1, ${`snapshots/${id}/files/big.bin`}, 'upload-1', 'open')
    `);
    const user = await createUser({ email: `erasure-${randomUUID()}@example.test`, partnerId: a.partnerId });
    await cascadeDeleteOrg(a.orgId, user.id);

    expect(await reservationRow(id)).toBeNull();
    expect(await tombstoneReason(id)).toBe('reservation_deleted');
    const left = await getTestDb().execute(sql`
      SELECT (SELECT count(*) FROM backup_storage_sessions WHERE org_id = ${a.orgId})::int AS sessions,
             (SELECT count(*) FROM backup_storage_session_uploads WHERE org_id = ${a.orgId})::int AS uploads
    `);
    expect(left[0]).toMatchObject({ sessions: 0, uploads: 0 });
  });
});

describe('write-scoped storage sessions: schema', () => {
  runDb('enforces the read/write row shape', async () => {
    const a = await seedWriteTenant();
    const id = sid('shape');
    await reserveAs(a.orgId, { snapshotId: id, deviceId: a.deviceId, configId: a.configId, jobId: a.jobId });
    // A write row without a reservation.
    const noReservation = await expectSqlState(() =>
      getTestDb().execute(sql`
        INSERT INTO backup_storage_sessions (org_id, device_id, source_device_id, config_id, storage_identity, scope,
          use_file_index, token_hash, generation, max_calls, max_resolved_objects, expires_at, deadline,
          rate_calls_available, rate_objects_available, rate_refilled_at, job_id)
        VALUES (${a.orgId}, ${a.deviceId}, ${a.deviceId}, ${a.configId}, ${WRITE_IDENTITY}, 'snapshot_write', false,
          ${'a'.repeat(64)}, 1, 1, 1, now() + interval '1 minute', now() + interval '1 hour', 1, 1, now(), ${a.jobId})
      `),
    );
    expect(noReservation).toBe('23514');
    // A read row without a command.
    const noCommand = await expectSqlState(() =>
      getTestDb().execute(sql`
        INSERT INTO backup_storage_sessions (org_id, device_id, source_device_id, config_id, storage_identity, scope,
          use_file_index, token_hash, generation, max_calls, max_resolved_objects, expires_at, deadline,
          rate_calls_available, rate_objects_available, rate_refilled_at)
        VALUES (${a.orgId}, ${a.deviceId}, ${a.deviceId}, ${a.configId}, ${WRITE_IDENTITY}, 'snapshot_read', false,
          ${'b'.repeat(64)}, 1, 1, 1, now() + interval '1 minute', now() + interval '1 hour', 1, 1, now())
      `),
    );
    expect(noCommand).toBe('23514');
  });

  runDb('refuses a write session naming another organization\'s job or reservation', async () => {
    const a = await seedWriteTenant();
    const b = await seedWriteTenant();
    const idB = sid('b-res');
    await reserveAs(b.orgId, { snapshotId: idB, deviceId: b.deviceId, jobId: b.jobId });
    const idA = sid('a-res');
    await reserveAs(a.orgId, { snapshotId: idA, deviceId: a.deviceId, jobId: a.jobId });
    expect(await expectSqlState(() => insertWriteSession({ ...a, jobId: b.jobId }, idA))).toBe('42501');
    expect(await expectSqlState(() => insertWriteSession(a, idB))).toBe('42501');
    // An upload row must name a write session of its own device and org.
    const sessionA = await insertWriteSession(a, idA);
    const crossOrgUpload = await expectSqlState(() =>
      getTestDb().execute(sql`
        INSERT INTO backup_storage_session_uploads (org_id, device_id, session_id, reservation_snapshot_id, reservation_generation, object_key)
        VALUES (${b.orgId}, ${b.deviceId}, ${sessionA}, ${idA}, 1, ${`snapshots/${idA}/files/x`})
      `),
    );
    expect(crossOrgUpload).toBe('42501');
  });

  runDb('a finished job revokes its own write sessions only', async () => {
    const a = await seedWriteTenant();
    const other = await seedBackupJob(a.orgId, a.configId, a.deviceId, 'running');
    const id1 = sid('job-end-1');
    const id2 = sid('job-end-2');
    await reserveAs(a.orgId, { snapshotId: id1, deviceId: a.deviceId, jobId: a.jobId });
    await reserveAs(a.orgId, { snapshotId: id2, deviceId: a.deviceId, jobId: other });
    const s1 = await insertWriteSession(a, id1);
    const s2 = await insertWriteSession({ ...a, jobId: other }, id2);
    await withDbAccessContext(orgContext(a.orgId), () =>
      db.execute(sql`UPDATE backup_jobs SET status = 'failed' WHERE id = ${a.jobId}`),
    );
    const rows = (await getTestDb().execute(sql`
      SELECT id, revoked_at, revoked_reason FROM backup_storage_sessions WHERE id IN (${s1}, ${s2})
    `)) as unknown as Array<{ id: string; revoked_at: Date | null; revoked_reason: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(s1)?.revoked_reason).toBe('job_failed');
    expect(byId.get(s2)?.revoked_at).toBeNull();
  });

  runDb('inserting the snapshot row seals the reservation and revokes its write sessions', async () => {
    const a = await seedWriteTenant();
    // No unconditional URL outstanding → published at once.
    const quiet = sid('seal-quiet');
    await reserveAs(a.orgId, { snapshotId: quiet, deviceId: a.deviceId, configId: a.configId, jobId: a.jobId });
    const s1 = await insertWriteSession(a, quiet, { horizon: new Date(Date.now() + 200_000), conditional: true });
    await insertSnapshotRow(a, quiet);
    expect(await reservationRow(quiet)).toMatchObject({ state: 'published' });
    const s1Row = await getTestDb().execute(sql`SELECT revoked_reason FROM backup_storage_sessions WHERE id = ${s1}`);
    expect(s1Row[0]).toMatchObject({ revoked_reason: 'sealed' });

    // An unconditional URL still usable → sealing until its expiry (+ skew).
    const job2 = await seedBackupJob(a.orgId, a.configId, a.deviceId, 'running');
    const busy = sid('seal-busy');
    await reserveAs(a.orgId, { snapshotId: busy, deviceId: a.deviceId, configId: a.configId, jobId: job2 });
    const horizon = new Date(Date.now() + 200_000);
    await insertWriteSession({ ...a, jobId: job2 }, busy, { horizon, conditional: false });
    await insertSnapshotRow({ ...a, jobId: job2 }, busy);
    const r = await reservationRow(busy);
    expect(r?.state).toBe('sealing');
    expect(new Date(r!.sealed_until as string).getTime()).toBeGreaterThanOrEqual(horizon.getTime() + 59_000);
  });

  runDb('a device move restamps reservations, write sessions and upload rows', async () => {
    const a = await seedWriteTenant();
    const b = await seedWriteTenant();
    const id = sid('move');
    await reserveAs(a.orgId, { snapshotId: id, deviceId: a.deviceId, configId: a.configId, jobId: a.jobId });
    const sessionId = await insertWriteSession(a, id);
    await getTestDb().execute(sql`
      INSERT INTO backup_storage_session_uploads (org_id, device_id, session_id, reservation_snapshot_id, reservation_generation, object_key, upload_id, state)
      VALUES (${a.orgId}, ${a.deviceId}, ${sessionId}, ${id}, 1, ${`snapshots/${id}/files/big.bin`}, 'upload-move', 'open')
    `);
    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE devices SET org_id = ${b.orgId}::uuid, site_id = ${b.siteId}::uuid WHERE id = ${a.deviceId}`),
    );
    const rows = await getTestDb().execute(sql`
      SELECT (SELECT org_id FROM backup_snapshot_id_reservations WHERE snapshot_id = ${id}) AS reservation_org,
             (SELECT org_id FROM backup_storage_sessions WHERE id = ${sessionId}) AS session_org,
             (SELECT org_id FROM backup_storage_session_uploads WHERE session_id = ${sessionId}) AS upload_org
    `);
    expect(rows[0]).toMatchObject({ reservation_org: b.orgId, session_org: b.orgId, upload_org: b.orgId });
  });
});
