/**
 * A snapshot's server-built file index is bound to its attestation, against
 * real Postgres:
 *
 *  - hydration refuses manifest bytes that differ from the attested ones, and
 *    re-checks under the snapshot row lock when it publishes (an attestation
 *    recorded while the manifest was being read counts);
 *  - the verifier's decision moves the index with it: a complete index built
 *    from other bytes goes back to 'none', a mismatch leaves no usable index;
 *  - hydration racing the verifier never leaves a complete index built from
 *    manifest bytes other than the attested ones (50 iterations);
 *  - readers see the same rule: the index state recovery negotiates on, the
 *    integrity expectation and the brokered read path;
 *  - the integrity expectation is resolved under RLS (another organization
 *    sees nothing).
 *
 * Storage is faked; every decision and lock runs in Postgres.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupIndexAttestationBinding.integration.test.ts
 */
import './setup';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { backupSnapshotFiles } from '../../db/schema/backup';
import { drizzleBrokeredReadStore } from '../../services/backupStorageSessionStore';
import { deliverRecoveryCommandIntegrity, defaultRecoveryCommandIntegrityDeps } from '../../services/backupRecoveryCommandIntegrity';
import { verifySnapshotAttestation } from '../../services/backupAttestationVerify';
import { verifyDepsFromBytes } from '../helpers/verifyDepsFromBytes';
import { hydrateSnapshotFileIndex, readSnapshotFileIndexState } from '../../services/backupSnapshotFileIndex';
import { resolveRestoreIntegrity } from '../../services/backupRestoreIntegrity';
import { listSnapshotDirectory, readableSnapshotSourcePaths } from '../../services/backupSnapshotBrowse';
import { readSnapshotIndexView } from '../../services/backupSnapshotIndexView';
import { deliverBrokeredReadCommand } from '../../services/backupStorageSessions';
import { backupReadCredentialPayload } from '../../services/backupCommandCredentials';
import { CommandDeliveryDeferredError } from '../../services/commandDeliveryRefusal';
import { WRITE_IDENTITY, insertSnapshotRow, orgContext, seedWriteDevice, seedWriteTenant, type WriteTenant } from './backupWriteFixtures';
import postgres from 'postgres';
import { getTestDb } from './setup';
import { markHelperChecksAttestations } from './restoreIntegrityFixture';

vi.mock('../../jobs/backupSnapshotFileIndexWorker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/backupSnapshotFileIndexWorker')>()),
  enqueueSnapshotFileIndexHydration: vi.fn(async () => 'queued'),
}));

const runDb = it.runIf(!!process.env.DATABASE_URL);
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

const previousPublicUrl = process.env.PUBLIC_API_URL;
beforeAll(() => {
  process.env.PUBLIC_API_URL = 'https://api.breeze.example';
});
afterAll(() => {
  if (previousPublicUrl === undefined) delete process.env.PUBLIC_API_URL;
  else process.env.PUBLIC_API_URL = previousPublicUrl;
});

function newId(): string {
  return `snapshot-20261112T120000Z-${randomBytes(12).toString('hex')}`;
}

function manifestFor(snapshotId: string, file = 'a'): Uint8Array {
  return Buffer.from(JSON.stringify({
    id: snapshotId,
    files: [{ sourcePath: `C:/${file}`, backupPath: `snapshots/${snapshotId}/files/${file}`, size: 1 }],
  }));
}

async function insertAttestation(
  t: WriteTenant,
  snapshotDbId: string,
  snapshotId: string,
  manifest: Uint8Array,
  status: 'pending' | 'verified' = 'pending',
): Promise<void> {
  const statement = JSON.stringify({ v: 1, snapshotId, jobId: t.jobId });
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshot_attestations (org_id, snapshot_db_id, job_id, device_id, provider_snapshot_id, storage_identity,
      key_layout, verification_mode, accepted_via, result_received_at, format_version, statement, statement_sha256,
      manifest_key, manifest_sha256, manifest_size, status)
    VALUES (${t.orgId}, ${snapshotDbId}, ${t.jobId}, ${t.deviceId}, ${snapshotId}, ${WRITE_IDENTITY},
      'legacy_flat', 'server_fetched', 'agent_result', now(), 1, ${statement}, ${sha(statement)},
      ${`snapshots/${snapshotId}/manifest.json`}, ${sha(manifest)}, ${manifest.byteLength}, 'pending')
  `);
  if (status === 'verified') {
    await getTestDb().execute(sql`
      UPDATE backup_snapshot_attestations SET status = 'verified', verified_at = now() WHERE snapshot_db_id = ${snapshotDbId}
    `);
    await getTestDb().execute(sql`UPDATE backup_snapshots SET integrity_status = 'attested' WHERE id = ${snapshotDbId}`);
  } else {
    await getTestDb().execute(sql`UPDATE backup_snapshots SET integrity_status = 'pending' WHERE id = ${snapshotDbId}`);
  }
}

async function setIndex(snapshotDbId: string, status: string, digest: string | null): Promise<void> {
  await getTestDb().execute(sql`
    UPDATE backup_snapshots SET file_index_status = ${status}, file_index_manifest_sha256 = ${digest} WHERE id = ${snapshotDbId}
  `);
}

async function indexRow(snapshotDbId: string): Promise<{ status: string; digest: string | null; error: string | null }> {
  const rows = (await getTestDb().execute(sql`
    SELECT file_index_status AS status, file_index_manifest_sha256 AS digest, file_index_error AS error
      FROM backup_snapshots WHERE id = ${snapshotDbId}
  `)) as unknown as Array<{ status: string; digest: string | null; error: string | null }>;
  return rows[0]!;
}

const verify = (snapshotDbId: string, bytes: Uint8Array) =>
  verifySnapshotAttestation(snapshotDbId, verifyDepsFromBytes(vi.fn(async () => bytes)));

// Wraps a bytes-returning stub as the stream-returning openManifest seam.
const hydrate = (snapshotDbId: string, fetchManifest: () => Promise<Uint8Array>, force = false) =>
  runOutsideDbContext(() => hydrateSnapshotFileIndex(snapshotDbId, {
    includeUnreferenced: true,
    force,
    deps: { openManifest: async () => Readable.from([Buffer.from(await fetchManifest())]) },
  }));

async function seedSnapshot(t: WriteTenant): Promise<{ snapshotId: string; snapshotDbId: string; manifest: Uint8Array }> {
  const snapshotId = newId();
  const snapshotDbId = await insertSnapshotRow(t, snapshotId);
  return { snapshotId, snapshotDbId, manifest: manifestFor(snapshotId) };
}

describe('hydration writes rows exactly as the manifest states them (#11026)', () => {
  runDb('paths, sizes and times survive the JSON batch, including what JSON and SQL treat specially', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const snapshotId = newId();
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    const key = (name: string) => `snapshots/${snapshotId}/files/${name}`;
    const nasty = [
      'C:\\Users\\zoë\\日本語\\😀 "quoted" \'single\'.txt',
      '/srv/line\nbreak\ttab.txt',
      '/srv/back\\slash/%_percent.txt',
      "/srv/o'; DROP TABLE backup_snapshot_files; --",
      '/srv/replacement-\uFFFD.txt',
      `/srv/${'long/'.repeat(800)}end.txt`,
    ];
    const files = [
      ...nasty.map((sourcePath, i) => ({ sourcePath, backupPath: key(`n${i}`), size: i, modTime: '2026-11-01T10:11:12.123456789Z' })),
      { sourcePath: '/srv/no-metadata', backupPath: key('none') },
      { sourcePath: '/srv/large', backupPath: key('large'), size: 2 ** 42, modTime: '2026-01-02T03:04:05+02:00' },
      { sourcePath: '/srv/zero-time', backupPath: key('zero'), size: 0, modTime: '0001-01-01T00:00:00Z' },
      { sourcePath: '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\vss', originalPath: 'C:\\vss', backupPath: key('vss'), size: 1 },
      { sourcePath: '/srv/a-dir', backupPath: '', kind: 'dir' },
    ];
    const manifest = Buffer.from(JSON.stringify({ id: snapshotId, files }));

    // The directory entry is a row too (#11235).
    expect(await hydrate(snapshotDbId, async () => manifest)).toMatchObject({ status: 'complete', entryCount: files.length });

    const rows = await withSystemDbAccessContext(() => db
      .select({
        id: backupSnapshotFiles.id,
        sourcePath: backupSnapshotFiles.sourcePath,
        backupPath: backupSnapshotFiles.backupPath,
        size: backupSnapshotFiles.size,
        modifiedAt: backupSnapshotFiles.modifiedAt,
        kind: backupSnapshotFiles.kind,
        createdAt: backupSnapshotFiles.createdAt,
      })
      .from(backupSnapshotFiles)
      .where(eq(backupSnapshotFiles.snapshotDbId, snapshotDbId)));
    const byKey = new Map(rows.map((r) => [r.backupPath, r]));
    expect(rows).toHaveLength(files.length);
    expect(byKey.get('')).toMatchObject({ sourcePath: '/srv/a-dir', kind: 'dir', size: null, modifiedAt: null });
    expect(rows.filter((r) => r.backupPath !== '').every((r) => r.kind === null)).toBe(true);

    nasty.forEach((sourcePath, i) => {
      const row = byKey.get(key(`n${i}`))!;
      expect(row.sourcePath).toBe(sourcePath);
      expect(row.size).toBe(i);
      expect(row.modifiedAt).toEqual(new Date('2026-11-01T10:11:12.123Z'));
    });
    expect(byKey.get(key('none'))).toMatchObject({ size: null, modifiedAt: null });
    expect(byKey.get(key('large'))).toMatchObject({ size: 2 ** 42, modifiedAt: new Date('2026-01-02T01:04:05.000Z') });
    // Go's zero time. Compared as stored: reading it back through a JS Date
    // turns year 0001 into 2001, whichever way it was written.
    const [zero] = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT modified_at::text AS stored FROM backup_snapshot_files
      WHERE snapshot_db_id = ${snapshotDbId} AND backup_path = ${key('zero')}
    `))) as unknown as Array<{ stored: string }>;
    expect(zero!.stored).toBe('0001-01-01 00:00:00');
    expect(byKey.get(key('vss'))!.sourcePath).toBe('C:\\vss');
    // Columns the statement leaves to their defaults.
    for (const row of rows) {
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.createdAt).toBeInstanceOf(Date);
    }
  });

  runDb('a database failure partway through leaves the previous rows and no complete index', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const snapshotId = newId();
    const snapshotDbId = await insertSnapshotRow(t, snapshotId);
    const good = Buffer.from(JSON.stringify({ id: snapshotId, files: [{ sourcePath: '/old', backupPath: `snapshots/${snapshotId}/files/old`, size: 1 }] }));
    await hydrate(snapshotDbId, async () => good);

    // 1,001 entries so the first batch commits to the transaction, and a second
    // batch that Postgres refuses: a NUL cannot be stored in text.
    const files = Array.from({ length: 1001 }, (_, i) => ({ sourcePath: `/new/${i}`, backupPath: `snapshots/${snapshotId}/files/${i}`, size: 1 }));
    files[1000] = { sourcePath: '/new/nul\u0000name', backupPath: `snapshots/${snapshotId}/files/x`, size: 1 };
    const bad = Buffer.from(JSON.stringify({ id: snapshotId, files }));
    await expect(hydrate(snapshotDbId, async () => bad, true)).rejects.toThrow();

    const paths = await withSystemDbAccessContext(() => db
      .select({ sourcePath: backupSnapshotFiles.sourcePath })
      .from(backupSnapshotFiles)
      .where(eq(backupSnapshotFiles.snapshotDbId, snapshotDbId)));
    expect(paths.map((p) => p.sourcePath)).toEqual(['/old']);
    expect((await indexRow(snapshotDbId)).status).toBe('failed');
  });
});

describe('file index bound to the snapshot attestation', () => {
  runDb('hydration refuses manifest bytes that differ from the attestation, and never publishes them', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    await insertAttestation(t, snapshotDbId, snapshotId, manifest);

    const outcome = await hydrate(snapshotDbId, async () => manifestFor(snapshotId, 'differing'));
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_differs_from_attestation', retryable: false });
    const row = await indexRow(snapshotDbId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^manifest_differs_from_attestation: /);
  });

  runDb('hydration of the attested bytes publishes while the attestation is still pending', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    await insertAttestation(t, snapshotDbId, snapshotId, manifest);

    expect(await hydrate(snapshotDbId, async () => manifest)).toMatchObject({ status: 'complete', manifestSha256: sha(manifest) });
    expect(await withSystemDbAccessContext(() => readSnapshotFileIndexState(snapshotDbId)))
      .toMatchObject({ status: 'complete', manifestSha256: sha(manifest) });
  });

  runDb('an attestation recorded while the manifest was being read is checked when the index is published', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);

    const outcome = await hydrate(snapshotDbId, async () => {
      // Recorded after hydration claimed the snapshot (no attestation then),
      // before its index is published.
      await insertAttestation(t, snapshotDbId, snapshotId, manifest);
      return manifestFor(snapshotId, 'differing');
    });
    expect(outcome).toMatchObject({ status: 'failed', failure: 'manifest_differs_from_attestation' });
    expect((await indexRow(snapshotDbId)).status).toBe('failed');
  });

  runDb('verification sends a complete index built from other bytes back to none, and it is rebuilt on its next use', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    const differing = manifestFor(snapshotId, 'differing');
    // An index built before the attestation existed, from other bytes.
    await setIndex(snapshotDbId, 'complete', sha(differing));
    await insertAttestation(t, snapshotDbId, snapshotId, manifest);

    expect(await verify(snapshotDbId, manifest)).toEqual({ outcome: 'verified' });
    expect(await indexRow(snapshotDbId)).toMatchObject({ status: 'none', error: null });

    expect(await hydrate(snapshotDbId, async () => manifest)).toMatchObject({ status: 'complete', manifestSha256: sha(manifest) });
  });

  runDb('verification leaves a complete index built from the attested bytes alone', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    await setIndex(snapshotDbId, 'complete', sha(manifest));
    await insertAttestation(t, snapshotDbId, snapshotId, manifest);

    expect(await verify(snapshotDbId, manifest)).toEqual({ outcome: 'verified' });
    expect(await indexRow(snapshotDbId)).toMatchObject({ status: 'complete', digest: sha(manifest) });
  });

  runDb('a mismatch leaves no usable index, and hydration will not build one', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    await setIndex(snapshotDbId, 'complete', sha(manifest));
    await insertAttestation(t, snapshotDbId, snapshotId, manifest);

    expect(await verify(snapshotDbId, manifestFor(snapshotId, 'stored-bytes-differ'))).toMatchObject({ outcome: 'mismatch' });
    const row = await indexRow(snapshotDbId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^attestation_failed: /);

    const fetch = vi.fn(async () => manifest);
    expect(await hydrate(snapshotDbId, fetch)).toMatchObject({ status: 'failed', failure: 'attestation_failed' });
    expect(fetch).not.toHaveBeenCalled();
  });

  runDb('an attestation recorded while differing bytes are being read, verified concurrently, never leaves that index complete (50 runs)', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    for (let i = 0; i < 50; i++) {
      const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
      const differing = manifestFor(snapshotId, 'differing');
      // Half the runs start from an index built before the attestation existed.
      if (i % 2 === 0) await setIndex(snapshotDbId, 'complete', sha(differing));

      let verification: Promise<unknown> = Promise.resolve();
      await hydrate(snapshotDbId, async () => {
        // Hydration has claimed the snapshot with no attestation in sight; the
        // attestation is recorded now and verified concurrently with the rest
        // of hydration (row writes, publish under the snapshot row lock).
        await insertAttestation(t, snapshotDbId, snapshotId, manifest);
        verification = runOutsideDbContext(() => verify(snapshotDbId, manifest));
        return differing;
      }, true);
      await verification;

      const row = await indexRow(snapshotDbId);
      expect(row.status === 'complete' && row.digest === sha(differing), `run ${i}: ${JSON.stringify(row)}`).toBe(false);
    }
  }, 180_000);

  runDb('hydration of the attested bytes racing a verification that finds a mismatch never leaves a complete index (50 runs)', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    for (let i = 0; i < 50; i++) {
      const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
      await insertAttestation(t, snapshotDbId, snapshotId, manifest);

      let verification: Promise<unknown> = Promise.resolve();
      await hydrate(snapshotDbId, async () => {
        // The stored manifest matches the attestation, but another control
        // object does not: the verifier decides `mismatch` while hydration of
        // the manifest is still in flight.
        verification = runOutsideDbContext(() =>
          verifySnapshotAttestation(snapshotDbId, verifyDepsFromBytes(vi.fn(async () => manifestFor(snapshotId, 'stored-bytes-differ')))));
        return manifest;
      }).catch(() => null);
      await verification;

      const row = await indexRow(snapshotDbId);
      expect(row.status, `run ${i}: ${JSON.stringify(row)}`).not.toBe('complete');
    }
  }, 180_000);
});

describe('readers apply the binding', () => {
  runDb('the index state recovery negotiates on reports an unbound complete index as not built', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    await setIndex(snapshotDbId, 'complete', sha(manifestFor(snapshotId, 'differing')));
    await insertAttestation(t, snapshotDbId, snapshotId, manifest);

    const state = await withDbAccessContext(orgContext(t.orgId), () => readSnapshotFileIndexState(snapshotDbId));
    expect(state).toMatchObject({ status: 'none', manifestSha256: null });
  });

  runDb('the integrity expectation is resolved under RLS: attested in the owning organization, invisible elsewhere', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const other = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    await insertAttestation(t, snapshotDbId, snapshotId, manifest, 'verified');

    const own = await withDbAccessContext(orgContext(t.orgId), () => resolveRestoreIntegrity(snapshotDbId));
    expect(own).toEqual({
      mode: 'attested',
      trust: 'server_verified',
      snapshotId,
      sourceDeviceId: t.deviceId,
      objects: [{ role: 'manifest', key: `snapshots/${snapshotId}/manifest.json`, sha256: sha(manifest), size: manifest.byteLength }],
    });
    expect(await withDbAccessContext(orgContext(other.orgId), () => resolveRestoreIntegrity(snapshotDbId))).toBeNull();
  });

  runDb('a brokered restore carries the attested expectation, and is deferred while its index is unbound', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    await markHelperChecksAttestations(t.deviceId);
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    await insertAttestation(t, snapshotDbId, snapshotId, manifest, 'verified');
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path)
      VALUES (${snapshotDbId}, 'C:/a', ${`snapshots/${snapshotId}/files/a`})
    `);
    const payload = { snapshotId, targetPath: 'C:/restore', ...backupReadCredentialPayload(t.configId, t.orgId, 's3') };
    const deliver = async () => {
      const commandId = randomUUID();
      await getTestDb().execute(sql`
        INSERT INTO device_commands (id, device_id, type, status, payload, executed_at)
        VALUES (${commandId}, ${t.deviceId}, 'backup_restore', 'sent', ${JSON.stringify(payload)}::jsonb, now())
      `);
      return withDbAccessContext(orgContext(t.orgId), () =>
        deliverBrokeredReadCommand(payload, { commandId, deviceId: t.deviceId, type: 'backup_restore', claimedAt: new Date() }));
    };

    await setIndex(snapshotDbId, 'complete', sha(manifestFor(snapshotId, 'differing')));
    await expect(deliver()).rejects.toBeInstanceOf(CommandDeliveryDeferredError);

    await setIndex(snapshotDbId, 'complete', sha(manifest));
    const out = await deliver();
    expect(out.storageSession).toBeTruthy();
    expect(out.integrity).toEqual({
      v: 1,
      mode: 'attested',
      trust: 'server_verified',
      snapshotId,
      objects: [{ role: 'manifest', key: `snapshots/${snapshotId}/manifest.json`, sha256: sha(manifest), size: manifest.byteLength }],
    });
  });
});

describe('index membership is decided in one statement with the binding', () => {
  runDb('file keys count only while the index is complete, built from the approved bytes, and bound to the attestation', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    const key = `snapshots/${snapshotId}/files/a`;
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path) VALUES (${snapshotDbId}, 'C:/a', ${key})
    `);
    const members = (digest: string | null) =>
      withDbAccessContext(orgContext(t.orgId), () => drizzleBrokeredReadStore.filterIndexedKeys(snapshotDbId, [key], digest));

    // No attestation, complete index: the approved digest must be the stored one.
    await setIndex(snapshotDbId, 'complete', sha(manifest));
    expect([...(await members(sha(manifest)))]).toEqual([key]);
    expect([...(await members(sha(manifestFor(snapshotId, 'differing'))))]).toEqual([]);

    // Being rebuilt: nothing counts.
    await setIndex(snapshotDbId, 'hydrating', sha(manifest));
    expect([...(await members(sha(manifest)))]).toEqual([]);

    // An attestation naming other bytes: nothing counts.
    await setIndex(snapshotDbId, 'complete', sha(manifest));
    await insertAttestation(t, snapshotDbId, snapshotId, manifestFor(snapshotId, 'other'));
    expect([...(await members(sha(manifest)))]).toEqual([]);
  });

  runDb('a mismatched attestation, or a refused statement with no row, makes every key count for nothing', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    for (const variant of ['mismatch', 'refused'] as const) {
      const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
      const key = `snapshots/${snapshotId}/files/a`;
      await getTestDb().execute(sql`
        INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path) VALUES (${snapshotDbId}, 'C:/a', ${key})
      `);
      await setIndex(snapshotDbId, 'complete', sha(manifest));
      if (variant === 'mismatch') {
        await insertAttestation(t, snapshotDbId, snapshotId, manifest);
        await getTestDb().execute(sql`UPDATE backup_snapshot_attestations SET status = 'mismatch' WHERE snapshot_db_id = ${snapshotDbId}`);
      } else {
        await getTestDb().execute(sql`UPDATE backup_snapshots SET integrity_status = 'attestation_failed' WHERE id = ${snapshotDbId}`);
      }
      const got = await withDbAccessContext(orgContext(t.orgId), () =>
        drizzleBrokeredReadStore.filterIndexedKeys(snapshotDbId, [key], sha(manifest)));
      expect([...got], variant).toEqual([]);
    }
  });
});

describe('a failed integrity lookup is never delivered, and never aborts the delivery transaction', () => {
  // Delivery runs each refresher in a savepoint (commandDelivery.ts
  // runRefresher); a lookup that fails releases the row for a later attempt.
  runDb('a VM command: not delivered, and the caller\'s transaction stays usable', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    await getTestDb().execute(sql`UPDATE devices SET backup_read_protocol_version = 0 WHERE id = ${t.deviceId}`);
    await markHelperChecksAttestations(t.deviceId);
    const { snapshotId } = await seedSnapshot(t);
    const spy = vi.spyOn(drizzleBrokeredReadStore, 'findSnapshots').mockImplementation(async () => {
      await db.execute(sql`SELECT 1 / 0`);
      return [];
    });
    try {
      const after = await withDbAccessContext(orgContext(t.orgId), async () => {
        await expect(withDbTransaction(() => deliverBrokeredReadCommand(
          { restoreJobId: 'r1', snapshotId, vmName: 'vm1' },
          { commandId: randomUUID(), deviceId: t.deviceId, type: 'vm_instant_boot', claimedAt: new Date() },
        ))).rejects.toThrow();
        // Same transaction: still usable after the failed statement.
        return db.execute(sql`SELECT count(*)::int AS n FROM devices WHERE id = ${t.deviceId}`);
      });
      expect((after as unknown as Array<{ n: number }>)[0]!.n).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  runDb('a bare-metal recovery command: not delivered, and the caller\'s transaction stays usable', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    await markHelperChecksAttestations(t.deviceId);
    const { snapshotId } = await seedSnapshot(t);
    const deps = {
      ...defaultRecoveryCommandIntegrityDeps,
      resolve: async () => {
        await db.execute(sql`SELECT 1 / 0`);
        return null;
      },
    };
    const after = await withDbAccessContext(orgContext(t.orgId), async () => {
      await expect(withDbTransaction(() => deliverRecoveryCommandIntegrity(
        { snapshotId, recoveryToken: 'enc', serverUrl: 'https://api.example' },
        { commandId: randomUUID(), deviceId: t.deviceId, type: 'bmr_recover', claimedAt: new Date() },
        deps,
      ))).rejects.toThrow();
      return db.execute(sql`SELECT count(*)::int AS n FROM devices WHERE id = ${t.deviceId}`);
    });
    expect((after as unknown as Array<{ n: number }>)[0]!.n).toBe(1);
  });
});

// #11026: the reader gate and the index view under the caller's own RLS
// context, where the attestation must be visible for the gate to apply.
describe('reader gate under RLS', () => {
  runDb('an org user sees a mismatched snapshot as unavailable and lists nothing; another org sees nothing at all', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const other = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path)
      VALUES (${snapshotDbId}, 'C:/a', ${`snapshots/${snapshotId}/files/a`})
    `);
    await setIndex(snapshotDbId, 'agent', null);
    await insertAttestation(t, snapshotDbId, snapshotId, manifest);

    const asOwner = () => withDbAccessContext(orgContext(t.orgId), async () => ({
      view: await readSnapshotIndexView(snapshotDbId, t.orgId),
      listed: (await listSnapshotDirectory({ snapshotDbId, segments: [], limit: 50 })).entries.map((e) => e.name),
    }));

    expect(await asOwner()).toMatchObject({ view: { view: { state: 'ready' } }, listed: ['C:'] });

    await getTestDb().execute(sql`UPDATE backup_snapshot_attestations SET status = 'mismatch', verified_at = now() WHERE snapshot_db_id = ${snapshotDbId}`);
    expect(await asOwner()).toMatchObject({
      view: { view: { state: 'unavailable', failure: 'attestation_failed', retryable: false }, shouldRequestHydration: false },
      listed: [],
    });

    const asOther = await withDbAccessContext(orgContext(other.orgId), async () => ({
      view: await readSnapshotIndexView(snapshotDbId, other.orgId),
      listed: (await listSnapshotDirectory({ snapshotDbId, segments: [], limit: 50 })).entries,
      paths: await readableSnapshotSourcePaths(snapshotDbId),
    }));
    expect(asOther).toEqual({ view: null, listed: [], paths: [] });
  });
});

// #11026 D5: the publish transaction locks the snapshot row first and re-checks
// the claim, so a superseded run never publishes, and readers keep the old rows
// until the new index commits.
describe('publish fence', () => {
  const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
  afterAll(async () => { await adminSql.end({ timeout: 5 }); });

  const sourcePaths = async (snapshotDbId: string) =>
    ((await getTestDb().execute(sql`
      SELECT source_path FROM backup_snapshot_files WHERE snapshot_db_id = ${snapshotDbId} ORDER BY source_path
    `)) as unknown as Array<{ source_path: string }>).map((r) => r.source_path);

  runDb('a device move while the manifest is read (the tenancy trigger resets the index) is superseded, and publishes nothing', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    const otherDevice = await seedWriteDevice(t.orgId, t.siteId);

    const outcome = await hydrate(snapshotDbId, async () => {
      await getTestDb().execute(sql`UPDATE backup_snapshots SET device_id = ${otherDevice} WHERE id = ${snapshotDbId}`);
      return manifest;
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'superseded' });
    expect(await indexRow(snapshotDbId)).toMatchObject({ status: 'none', digest: null });
    expect(await sourcePaths(snapshotDbId)).toEqual([]);
    void snapshotId;
  });

  runDb('a run whose claim was taken over by another worker publishes nothing, and its failure does not overwrite the newer claim', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId } = await seedSnapshot(t);
    const newerClaim = new Date(Date.now() + 60_000);

    const superseded = await hydrate(snapshotDbId, async () => {
      await getTestDb().execute(sql`UPDATE backup_snapshots SET file_index_hydrated_at = ${newerClaim.toISOString()} WHERE id = ${snapshotDbId}`);
      return manifestFor(snapshotId);
    });
    expect(superseded).toEqual({ status: 'skipped', reason: 'superseded' });
    expect(await sourcePaths(snapshotDbId)).toEqual([]);

    await setIndex(snapshotDbId, 'none', null);
    const failedLate = await hydrate(snapshotDbId, async () => {
      await getTestDb().execute(sql`UPDATE backup_snapshots SET file_index_hydrated_at = ${new Date(Date.now() + 120_000).toISOString()} WHERE id = ${snapshotDbId}`);
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    }, true);
    expect(failedLate).toEqual({ status: 'skipped', reason: 'superseded' });
    expect((await indexRow(snapshotDbId)).status).toBe('hydrating');
  });

  runDb('a concurrent reader sees the old rows until the new index commits', async () => {
    const t = await seedWriteTenant({ jobStatus: 'completed' });
    const { snapshotId, snapshotDbId, manifest } = await seedSnapshot(t);
    await getTestDb().execute(sql`
      INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path)
      VALUES (${snapshotDbId}, 'C:/old', ${`snapshots/${snapshotId}/files/old`})
    `);
    await setIndex(snapshotDbId, 'agent', null);

    // Hold the publish at its origin rewrite, after the file rows were replaced
    // inside its (still open) transaction.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const tableLocked = new Promise<void>((r) => { locked = r; });
    const lockTx = adminSql.begin(async (tx) => {
      await tx`LOCK TABLE backup_snapshot_origins IN ACCESS EXCLUSIVE MODE`;
      locked();
      await held;
    });
    await tableLocked;

    const hydration = hydrate(snapshotDbId, async () => manifest);
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const rows = (await getTestDb().execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
             AND query ILIKE 'delete from "backup_snapshot_origins"%'
        `)) as unknown as Array<{ n: number }>;
        if ((rows[0]?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error('the publish never reached the origin rewrite');
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await sourcePaths(snapshotDbId)).toEqual(['C:/old']);
      expect((await indexRow(snapshotDbId)).status).toBe('hydrating');
    } finally {
      release();
      await lockTx;
    }

    expect(await hydration).toMatchObject({ status: 'complete', manifestSha256: sha(manifest) });
    expect(await sourcePaths(snapshotDbId)).toEqual(['C:/a']);
    expect((await indexRow(snapshotDbId)).status).toBe('complete');
  });
});

