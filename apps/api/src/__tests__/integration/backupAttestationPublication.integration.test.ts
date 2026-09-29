/**
 * A brokered snapshot's attestation against real Postgres, across the
 * sealing -> published transition of its id reservation:
 *
 *  1. while the reservation is sealing, verification is deferred to the time
 *     the cleanup job is expected to publish it (sealed_until plus one
 *     cleanup period), not to the storage-failure backoff;
 *  2. the cleanup job hands every snapshot it publishes to verification at
 *     once, and only a snapshot with a pending server-fetched attestation is
 *     queued;
 *  3. verification then decides the row: the snapshot is attested.
 *
 * Storage is faked; the reservation trigger, the retry schedule and the
 * janitor's publication all run in Postgres.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupAttestationPublication.integration.test.ts
 */
import './setup';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { runBackupWriteSessionJanitor } from '../../jobs/backupWriteSessionJanitor';
import { findPendingServerFetchedAttestations } from '../../jobs/backupSnapshotAttestationWorker';
import { defaultVerifyDeps, verifySnapshotAttestation } from '../../services/backupAttestationVerify';
import { RESERVATION_CLEANUP_EVERY_MS } from '../../services/backupSnapshotIdReservations';
import { WRITE_IDENTITY, insertSnapshotRow, reservationRow, seedWriteTenant, type WriteTenant } from './backupWriteFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

function newId(): string {
  return `snapshot-20261108T120000Z-${randomBytes(12).toString('hex')}`;
}

/** A server-issued id reserved to the tenant's job, with one write session whose last URL expired `horizonAgoMs` ago. */
async function reservedWithSession(t: WriteTenant, horizonAgoMs: number): Promise<string> {
  const id = newId();
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshot_id_reservations (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, current_job_id)
    VALUES (${id}, ${t.orgId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'server_minted', 'reserved', ${t.jobId})
  `);
  const sessionId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_storage_sessions (id, org_id, device_id, source_device_id, config_id, storage_identity, scope,
      use_file_index, token_hash, generation, max_calls, max_resolved_objects, expires_at, deadline,
      rate_calls_available, rate_objects_available, rate_refilled_at, job_id, reservation_snapshot_id,
      reservation_generation, url_horizon_at)
    VALUES (${sessionId}, ${t.orgId}, ${t.deviceId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'snapshot_write', false,
      ${sha(sessionId)}, (SELECT coalesce(max(generation), 0) + 1 FROM backup_storage_sessions WHERE job_id = ${t.jobId}),
      10, 10, now() + interval '5 minutes', now() + interval '1 hour', 1, 1, now(), ${t.jobId}, ${id}, 1,
      ${new Date(Date.now() - horizonAgoMs).toISOString()})
  `);
  return id;
}

function manifestFor(snapshotId: string): Uint8Array {
  return Buffer.from(JSON.stringify({ id: snapshotId, files: [{ sourcePath: 'C:/a', backupPath: `snapshots/${snapshotId}/files/a`, size: 1 }] }));
}

async function insertPendingAttestation(t: WriteTenant, snapshotDbId: string, snapshotId: string, manifest: Uint8Array): Promise<void> {
  const statement = JSON.stringify({ v: 1, snapshotId, jobId: t.jobId });
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshot_attestations (org_id, snapshot_db_id, job_id, device_id, provider_snapshot_id, storage_identity,
      key_layout, verification_mode, accepted_via, result_received_at, format_version, statement, statement_sha256,
      manifest_key, manifest_sha256, manifest_size, status)
    VALUES (${t.orgId}, ${snapshotDbId}, ${t.jobId}, ${t.deviceId}, ${snapshotId}, ${WRITE_IDENTITY},
      'legacy_flat', 'server_fetched', 'agent_result', now(), 1, ${statement}, ${sha(statement)},
      ${`snapshots/${snapshotId}/manifest.json`}, ${sha(manifest)}, ${manifest.byteLength}, 'pending')
  `);
}

async function attestationRow(snapshotDbId: string) {
  const rows = (await getTestDb().execute(sql`
    SELECT status, attempt_count, next_attempt_at, verify_error FROM backup_snapshot_attestations WHERE snapshot_db_id = ${snapshotDbId}
  `)) as unknown as Array<{ status: string; attempt_count: number; next_attempt_at: Date | string | null; verify_error: string | null }>;
  return rows[0]!;
}

async function integrityStatus(snapshotDbId: string): Promise<string> {
  const rows = (await getTestDb().execute(sql`
    SELECT integrity_status FROM backup_snapshots WHERE id = ${snapshotDbId}
  `)) as unknown as Array<{ integrity_status: string }>;
  return rows[0]!.integrity_status;
}

const noStorage = { abortMultipart: async () => undefined, listMultipart: async () => [] };

describe('brokered snapshot attestation across publication', () => {
  runDb('is deferred to the expected publication, handed to verification when published, and then attested', async () => {
    const t = await seedWriteTenant();
    // The last upload URL expired 10 minutes ago: sealing waits out a
    // further 15-minute transfer margin plus 60 s, about 6 minutes from now.
    const snapshotId = await reservedWithSession(t, 10 * 60_000);
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    const sealing = await reservationRow(snapshotId);
    expect(sealing?.state).toBe('sealing');
    const sealedUntil = new Date(sealing!.sealed_until as string | Date);
    expect(sealedUntil.getTime()).toBeGreaterThan(Date.now());

    const manifest = manifestFor(snapshotId);
    await insertPendingAttestation(t, snapshotDbId, snapshotId, manifest);
    const fetchObject = vi.fn(async ({ key }: { key: string }) => {
      if (key !== `snapshots/${snapshotId}/manifest.json`) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return manifest;
    });
    const deps = { ...defaultVerifyDeps, fetchObject };

    // 1. Sealing: never read, retried when publication is due.
    expect(await verifySnapshotAttestation(snapshotDbId, deps)).toEqual({ outcome: 'retry', reason: 'snapshot_sealing' });
    expect(fetchObject).not.toHaveBeenCalled();
    let row = await attestationRow(snapshotDbId);
    expect(row).toMatchObject({ status: 'pending', attempt_count: 1, verify_error: 'snapshot_sealing' });
    const expectedRetry = sealedUntil.getTime() + RESERVATION_CLEANUP_EVERY_MS;
    expect(Math.abs(new Date(row.next_attempt_at!).getTime() - expectedRetry)).toBeLessThan(1000);
    expect(await findPendingServerFetchedAttestations([snapshotDbId, randomUUID()])).toEqual([snapshotDbId]);

    // 2. The seal lapses; the cleanup job publishes and hands the snapshot over at once.
    await getTestDb().execute(sql`
      UPDATE backup_snapshot_id_reservations SET sealed_until = now() - interval '1 second' WHERE snapshot_id = ${snapshotId}
    `);
    const onPublished = vi.fn(async (_ids: string[]) => undefined);
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: noStorage, onPublished });
    expect((await reservationRow(snapshotId))?.state).toBe('published');
    expect(onPublished.mock.calls.flatMap(([ids]) => ids)).toContain(snapshotDbId);

    // 3. The kicked verification reads storage and attests the snapshot.
    expect(await verifySnapshotAttestation(snapshotDbId, deps)).toEqual({ outcome: 'verified' });
    row = await attestationRow(snapshotDbId);
    expect(row.status).toBe('verified');
    expect(await integrityStatus(snapshotDbId)).toBe('attested');
    expect(await findPendingServerFetchedAttestations([snapshotDbId])).toEqual([]);
  });

  runDb('a sealing snapshot held past its bound backs off instead of retrying at once', async () => {
    const t = await seedWriteTenant();
    const snapshotId = await reservedWithSession(t, 10 * 60_000);
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    // Past sealed_until, but still sealing (a completion or delete in flight).
    await getTestDb().execute(sql`
      UPDATE backup_snapshot_id_reservations SET sealed_until = now() - interval '10 minutes' WHERE snapshot_id = ${snapshotId}
    `);
    expect((await reservationRow(snapshotId))?.state).toBe('sealing');
    const manifest = manifestFor(snapshotId);
    await insertPendingAttestation(t, snapshotDbId, snapshotId, manifest);

    const before = Date.now();
    expect(await verifySnapshotAttestation(snapshotDbId, { ...defaultVerifyDeps, fetchObject: vi.fn() }))
      .toEqual({ outcome: 'retry', reason: 'snapshot_sealing' });
    const delay = new Date((await attestationRow(snapshotDbId)).next_attempt_at!).getTime() - before;
    expect(delay).toBeGreaterThan(14 * 60_000);
    expect(delay).toBeLessThan(16 * 60_000);
  });

  runDb('publishing a snapshot without a pending server-fetched attestation queues no verification', async () => {
    const t = await seedWriteTenant();
    const snapshotId = await reservedWithSession(t, 10 * 60_000);
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    await getTestDb().execute(sql`
      UPDATE backup_snapshot_id_reservations SET sealed_until = now() - interval '1 second' WHERE snapshot_id = ${snapshotId}
    `);
    const onPublished = vi.fn(async (_ids: string[]) => undefined);
    await runBackupWriteSessionJanitor({ now: () => new Date(), storage: noStorage, onPublished });
    expect((await reservationRow(snapshotId))?.state).toBe('published');
    // Handed over (the janitor does not know about attestations) ...
    expect(onPublished.mock.calls.flatMap(([ids]) => ids)).toContain(snapshotDbId);
    // ... but nothing is pending for it, so nothing would be queued.
    expect(await findPendingServerFetchedAttestations([snapshotDbId])).toEqual([]);
  });
});
