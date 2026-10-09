/**
 * Integration fixtures for restore integrity (services/backupRestoreGate.ts):
 * a privileged restore is delivered only to a helper that checks restored
 * bytes against the snapshot attestation, and only for an attested snapshot
 * (or with a confirmed authorization). Suites that exercise restore paths for
 * other reasons seed both, the way a current helper's backup would.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';

/** The device's backup helper reports integrity protocol 2 (checks restores against attestations). */
export async function markHelperChecksAttestations(deviceId: string): Promise<void> {
  await getTestDb().execute(sql`UPDATE devices SET backup_integrity_protocol_version = 2 WHERE id = ${deviceId}`);
}

/**
 * Records a verified attestation for a seeded snapshot, bound to the row as
 * it is (device, job, snapshot id, storage identity, key layout), and marks
 * the snapshot attested. The manifest digest defaults to the digest its file
 * index was built from, so an existing index stays bound.
 */
export async function attestSnapshotForTest(
  snapshotDbId: string,
  opts: { manifestSha256?: string; manifestSize?: number; status?: 'verified' | 'producer_only' } = {},
): Promise<void> {
  const db = getTestDb();
  const rows = (await db.execute(sql`
    SELECT org_id, job_id, device_id, snapshot_id, storage_identity, key_layout, file_index_manifest_sha256
      FROM backup_snapshots WHERE id = ${snapshotDbId}
  `)) as unknown as Array<{
    org_id: string; job_id: string; device_id: string; snapshot_id: string;
    storage_identity: string | null; key_layout: string; file_index_manifest_sha256: string | null;
  }>;
  const snap = rows[0];
  if (!snap) throw new Error(`attestSnapshotForTest: snapshot ${snapshotDbId} not found`);
  if (!snap.storage_identity) throw new Error('attestSnapshotForTest: the snapshot needs a storage identity to be attested');
  const statement = JSON.stringify({ v: 1, snapshotId: snap.snapshot_id, jobId: snap.job_id });
  const statementSha = createHash('sha256').update(statement, 'utf8').digest('hex');
  const manifestSha = opts.manifestSha256 ?? snap.file_index_manifest_sha256 ?? 'a'.repeat(64);
  const producerOnly = opts.status === 'producer_only';
  await db.execute(sql`
    INSERT INTO backup_snapshot_attestations (org_id, snapshot_db_id, job_id, device_id, provider_snapshot_id, storage_identity,
      key_layout, verification_mode, accepted_via, result_received_at, format_version, statement, statement_sha256,
      manifest_key, manifest_sha256, manifest_size, status)
    VALUES (${snap.org_id}, ${snapshotDbId}, ${snap.job_id}, ${snap.device_id}, ${snap.snapshot_id}, ${snap.storage_identity},
      ${snap.key_layout}, ${producerOnly ? 'producer_only' : 'server_fetched'}, 'agent_result', now(), 1, ${statement}, ${statementSha},
      ${`snapshots/${snap.snapshot_id}/manifest.json`}, ${manifestSha}, ${opts.manifestSize ?? 1}, ${producerOnly ? 'producer_only' : 'pending'})
  `);
  if (!producerOnly) {
    await db.execute(sql`
      UPDATE backup_snapshot_attestations SET status = 'verified', verified_at = now() WHERE snapshot_db_id = ${snapshotDbId}
    `);
  }
  await db.execute(sql`
    UPDATE backup_snapshots SET integrity_status = ${producerOnly ? 'producer_only' : 'attested'} WHERE id = ${snapshotDbId}
  `);
}
