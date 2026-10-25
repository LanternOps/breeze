/**
 * #7081 W03 — one destination, one org, one bucket, through the whole prefix
 * story: a legacy snapshot exists, the destination gains the prefix
 * `tenant-a`, a brokered write publishes a new snapshot under it, and every
 * consumer (read session, attestation verifier, dispatch base selection,
 * retention + storage GC) addresses the right PHYSICAL key for each snapshot:
 * legacy → `snapshots/<id>/...`, prefixed → `tenant-a/snapshots/<id>/...`.
 * Real Postgres; storage is the in-memory S3 behind the real get / list /
 * delete code. The mint root is the production one (no injected resolver).
 */
import './setup';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { cleanupExpiredSnapshots, normalizeStorageIdentity, sweepUnreferencedBackupObjects } from '../../jobs/backupRetention';
import { __testOnly } from '../../jobs/backupWorker';
import { runBackupWriteSessionJanitor } from '../../jobs/backupWriteSessionJanitor';
import { defaultVerifyDeps, verifySnapshotAttestation } from '../../services/backupAttestationVerify';
import { backupReadCredentialPayload } from '../../services/backupCommandCredentials';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import { __setBackupS3ClientFactoryForTests } from '../../services/backupSnapshotStorage';
import {
  authenticateStorageSession,
  deliverBrokeredReadCommand,
  resolveStorageSessionObjects,
  type BrokeredReadDeps,
  defaultBrokeredReadDeps,
} from '../../services/backupStorageSessions';
import {
  mintBackupWriteSession,
  resolveWriteSessionObjects,
  type WriteSessionDeps,
} from '../../services/backupStorageWriteSessions';
import { InMemoryS3 } from '../helpers/inMemoryS3';
import { WRITE_DESTINATION, orgContext, seedWriteDevice, seedWriteTenant } from './backupWriteFixtures';
import { markHelperChecksAttestations, attestSnapshotForTest } from './restoreIntegrityFixture';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const s3 = new InMemoryS3();
const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'tenant-a';

const prevPublicUrl = process.env.PUBLIC_API_URL;
beforeAll(() => {
  process.env.PUBLIC_API_URL = 'https://api.breeze.example';
  // The shared fake's GET body only offers transformToString; the verifier's
  // default fetch reads transformToByteArray, so adapt it here.
  const base = s3.client();
  __setBackupS3ClientFactoryForTests(() => ({
    send: async (command: unknown) => {
      const res = (await base.send(command)) as { Body?: { transformToString(): Promise<string>; transformToByteArray?: () => Promise<Uint8Array> } };
      if (res?.Body && !res.Body.transformToByteArray) {
        const body = res.Body;
        body.transformToByteArray = async () => new Uint8Array(Buffer.from(await body.transformToString(), 'utf8'));
      }
      return res;
    },
  }) as never);
});
afterAll(() => {
  __setBackupS3ClientFactoryForTests(null);
  if (prevPublicUrl === undefined) delete process.env.PUBLIC_API_URL;
  else process.env.PUBLIC_API_URL = prevPublicUrl;
});

const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const newSnapshotId = (tag: string) => `snapshot-20261101T000000Z-${tag}${randomBytes(11).toString('hex')}`.slice(0, 54);
const manifestOf = (id: string, files: string[]) =>
  JSON.stringify({ id, files: files.map((f) => ({ sourcePath: `C:/${f}`, backupPath: `snapshots/${id}/files/${f}`, size: 1 })) });

type Rows = Array<Record<string, unknown>>;
const q = async (query: ReturnType<typeof sql>) => (await getTestDb().execute(query)) as unknown as Rows;

runDb('legacy + prefixed snapshots on one destination resolve, read, verify, pin and retire under their own roots (#7081 W03)', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bucket = `prefix-roundtrip-${unique}`;
  const destination = { ...WRITE_DESTINATION, bucket };
  const identity = normalizeStorageIdentity('s3', destination);
  const old = new Date(Date.now() - 20 * DAY_MS);
  const t = await seedWriteTenant({ destination });
  await q(sql`UPDATE backup_jobs SET storage_identity = ${identity} WHERE id = ${t.jobId}`);
  // A current helper: without it GC defers the identity (legacy-helper capability gate) and roots every listed manifest.
  await q(sql`UPDATE devices SET backup_version = '0.112.0' WHERE id = ${t.deviceId}`);
  const executing = await seedWriteDevice(t.orgId, t.siteId, 1);
  await markHelperChecksAttestations(executing);

  // ── 1. A pre-existing legacy snapshot, objects at the bucket root ───────
  const L = newSnapshotId('l');
  const legacyFiles = ['x.dat', 'y.dat'];
  const legacyManifest = manifestOf(L, legacyFiles);
  s3.put(bucket, `snapshots/${L}/manifest.json`, legacyManifest, old);
  for (const f of legacyFiles) s3.put(bucket, `snapshots/${L}/files/${f}`, 'l', old);
  const legacyJobId = randomUUID();
  const legacyDbId = randomUUID();
  await q(sql`
    INSERT INTO backup_jobs (id, org_id, config_id, device_id, status, type, storage_identity, snapshot_id)
    VALUES (${legacyJobId}, ${t.orgId}, ${t.configId}, ${t.deviceId}, 'completed', 'scheduled', ${identity}, ${L})`);
  await q(sql`
    INSERT INTO backup_snapshots (id, org_id, job_id, device_id, config_id, snapshot_id, storage_identity, key_layout, key_prefix,
      file_index_status, file_index_manifest_sha256, timestamp)
    VALUES (${legacyDbId}, ${t.orgId}, ${legacyJobId}, ${t.deviceId}, ${t.configId}, ${L}, ${identity}, 'legacy_flat', NULL,
      'complete', ${sha(legacyManifest)}, now() - interval '3 days')`);
  for (const f of legacyFiles) {
    await q(sql`INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path) VALUES (${legacyDbId}, ${`C:/${f}`}, ${`snapshots/${L}/files/${f}`})`);
  }
  await attestSnapshotForTest(legacyDbId, { manifestSha256: sha(legacyManifest), manifestSize: legacyManifest.length });
  const legacyObjectsBefore = s3.keys(bucket);

  // ── 2. The destination gains the prefix ─────────────────────────────────
  const prefixedDestination = { ...destination, prefix: PREFIX };
  await q(sql`UPDATE backup_configs SET provider_config = ${JSON.stringify(prefixedDestination)}::jsonb WHERE id = ${t.configId}`);
  expect(normalizeStorageIdentity('s3', prefixedDestination)).toBe(identity); // the prefix is not identity

  // ── 3. Brokered write with the PRODUCTION mint root; upload + publish ───
  const signed: string[] = [];
  const deps: WriteSessionDeps = {
    now: () => new Date(),
    randomToken: () => randomBytes(32).toString('base64url'),
    random: (n) => randomBytes(n),
    publicOrigins: () => ['https://api.breeze.example'],
    scheduleProbe: () => undefined,
    // no resolveMintKeyRoot: mintBackupWriteSession uses the production resolver
    storage: {
      presignPut: async (_cfg, key, size, _sse, opts) => {
        signed.push(key);
        return { url: `https://storage.example/${key}?put`, headers: { 'content-length': String(size) }, expiresAt: new Date(Date.now() + opts.expiresInSeconds * 1000) };
      },
      presignPart: async () => { throw new Error('unused'); },
      presignGet: async (_cfg, key) => `https://storage.example/${key}?get`,
      createMultipart: async () => { throw new Error('unused'); },
      completeMultipart: async () => undefined,
      abortMultipart: async () => undefined,
      listMultipart: async () => [],
      listKeys: async () => ({ keys: [], nextToken: null }),
      deleteKeys: async (_cfg, keys) => ({ deleted: keys, failed: [] }),
    },
  };
  const minted = await withDbAccessContext(orgContext(t.orgId), () => mintBackupWriteSession({
    orgId: t.orgId, jobId: t.jobId, deviceId: t.deviceId, configId: t.configId,
    provider: 's3', providerConfig: prefixedDestination, baseManifestKey: null,
  }, deps));
  if (minted.mode !== 'brokered') throw new Error(`expected brokered, got ${minted.reason}`);
  const P = minted.snapshotId;
  const auth = await withDbAccessContext(orgContext(t.orgId), () => authenticateStorageSession({
    sessionId: minted.envelope.sessionId as string, token: minted.envelope.token as string,
    agent: { deviceId: t.deviceId, orgId: t.orgId },
  }));
  if (!auth.ok) throw new Error(`auth failed: ${auth.error}`);

  const prefixedFiles = ['a.dat', 'b.dat'];
  const logicalKeys = [`snapshots/${P}/manifest.json`, ...prefixedFiles.map((f) => `snapshots/${P}/files/${f}`)];
  const resolved = await withDbAccessContext(orgContext(t.orgId), async () => {
    const { ensureWriteSessionLive } = await import('../../services/backupStorageWriteSessions');
    const live = await ensureWriteSessionLive(auth.session);
    if (!live.ok) throw new Error(`session not live: ${live.status}`);
    return resolveWriteSessionObjects(auth.session, live.reservation, logicalKeys.map((key) => ({ method: 'PUT' as const, key, size: 1 })), deps);
  });
  expect(resolved.status).toBe(200);
  // The signer was asked for physical keys; "upload" at exactly those.
  expect(signed.sort()).toEqual(logicalKeys.map((k) => `${PREFIX}/${k}`).sort());
  const prefixedManifest = manifestOf(P, prefixedFiles);
  for (const key of signed) s3.put(bucket, key, key.endsWith('manifest.json') ? prefixedManifest : 'p', old);

  const outcome = await withDbAccessContext(orgContext(t.orgId), () => applyBackupCommandResultToJob({
    jobId: t.jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed',
    result: { snapshotId: P, filesBackedUp: 2, bytesBackedUp: 2 },
  }));
  expect(outcome.snapshotDbId).not.toBeNull();
  const prefixedDbId = outcome.snapshotDbId as string;

  // ── 4. Row root + physical object placement ─────────────────────────────
  expect(await q(sql`SELECT key_layout, key_prefix FROM backup_snapshots WHERE id = ${prefixedDbId}`))
    .toEqual([{ key_layout: 'prefixed_flat', key_prefix: PREFIX }]);
  expect(s3.keys(bucket)).toEqual([
    ...legacyObjectsBefore,
    ...logicalKeys.map((k) => `${PREFIX}/${k}`),
  ].sort());
  expect(legacyObjectsBefore.every((k) => k.startsWith(`snapshots/${L}/`))).toBe(true); // legacy untouched, still at the root

  // ── 6. Attestation verify reads the manifest under the snapshot's root ──
  const statement = JSON.stringify({ v: 1, snapshotId: P, jobId: t.jobId });
  await q(sql`
    INSERT INTO backup_snapshot_attestations (org_id, snapshot_db_id, job_id, device_id, provider_snapshot_id, storage_identity,
      key_layout, verification_mode, accepted_via, result_received_at, format_version, statement, statement_sha256,
      manifest_key, manifest_sha256, manifest_size, status)
    VALUES (${t.orgId}, ${prefixedDbId}, ${t.jobId}, ${t.deviceId}, ${P}, ${identity},
      'legacy_flat', 'server_fetched', 'agent_result', now(), 1, ${statement}, ${sha(statement)},
      ${`snapshots/${P}/manifest.json`}, ${sha(prefixedManifest)}, ${prefixedManifest.length}, 'pending')`);
  // Let the reservation seal lapse so the snapshot is "published" and readable.
  await q(sql`UPDATE backup_storage_sessions SET url_horizon_at = now() - interval '1 minute' WHERE reservation_snapshot_id = ${P}`);
  await q(sql`UPDATE backup_snapshot_id_reservations SET sealed_until = now() - interval '1 second' WHERE snapshot_id = ${P}`);
  await runBackupWriteSessionJanitor({ now: () => new Date(), storage: { abortMultipart: async () => undefined, listMultipart: async () => [] } });
  s3.calls.length = 0;
  expect(await verifySnapshotAttestation(prefixedDbId, defaultVerifyDeps)).toEqual({ outcome: 'verified' });
  const verifyGets = s3.callsFor(bucket).flatMap((c) => (c.op === 'get' ? [c.key] : []));
  expect(verifyGets).toEqual([`${PREFIX}/snapshots/${P}/manifest.json`]);

  // ── 5. Read sessions resolve every object of BOTH snapshots physically ──
  await q(sql`UPDATE backup_snapshots SET file_index_status = 'complete', file_index_manifest_sha256 = ${sha(prefixedManifest)} WHERE id = ${prefixedDbId}`);
  for (const f of prefixedFiles) {
    await q(sql`INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path) VALUES (${prefixedDbId}, ${`C:/${f}`}, ${`snapshots/${P}/files/${f}`})`);
  }
  const presigned: string[] = [];
  const readDeps: BrokeredReadDeps = {
    ...defaultBrokeredReadDeps,
    presignGet: async ({ key }) => { presigned.push(key); return `https://storage.example/${key}?get`; },
  };
  async function readAll(snapshotId: string, files: string[]) {
    const payload = { snapshotId, targetPath: '/restore', ...backupReadCredentialPayload(t.configId, t.orgId, 's3') };
    const commandId = randomUUID();
    await q(sql`INSERT INTO device_commands (id, device_id, type, status, payload, executed_at)
      VALUES (${commandId}, ${executing}, 'backup_restore', 'sent', ${JSON.stringify(payload)}::jsonb, now())`);
    const delivered = await runOutsideDbContext(() => deliverBrokeredReadCommand(payload, {
      commandId, deviceId: executing, type: 'backup_restore', claimedAt: new Date(),
    }));
    const s = delivered.storageSession as { sessionId: string; token: string } | undefined;
    if (!s) throw new Error(`no brokered session minted for ${snapshotId}: ${JSON.stringify(delivered).slice(0, 300)}`);
    const keys = [`snapshots/${snapshotId}/manifest.json`, ...files.map((f) => `snapshots/${snapshotId}/files/${f}`)];
    presigned.length = 0;
    const result = await runOutsideDbContext(() => withDbAccessContext(
      { scope: 'organization', orgId: t.orgId, accessibleOrgIds: [t.orgId], accessiblePartnerIds: [], userId: null },
      async () => {
        const a = await authenticateStorageSession({ sessionId: s.sessionId, token: s.token, agent: { deviceId: executing, orgId: t.orgId } });
        if (!a.ok) throw new Error(`read auth failed: ${a.status}`);
        return resolveStorageSessionObjects(a.session, keys, readDeps);
      }));
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.denied).toEqual([]);
    expect(result.body.objects.map((o) => o.key)).toEqual(keys); // the helper still sees logical keys
    return { keys, presigned: [...presigned] };
  }
  const readLegacy = await readAll(L, legacyFiles);
  expect(readLegacy?.presigned).toEqual(readLegacy?.keys); // bucket root
  const readPrefixed = await readAll(P, prefixedFiles);
  expect(readPrefixed?.presigned).toEqual(readPrefixed?.keys.map((k) => `${PREFIX}/${k}`));
  for (const k of readPrefixed!.presigned) expect(s3.keys(bucket)).toContain(k); // each resolves to a real object

  // ── 8. Dispatch base: pins the prefixed snapshot, passing over a NEWER legacy one ──
  await q(sql`UPDATE backup_snapshots SET timestamp = now() - interval '2 days' WHERE id = ${prefixedDbId}`);
  await q(sql`UPDATE backup_snapshots SET timestamp = now() - interval '1 hour' WHERE id = ${legacyDbId}`);
  const [dispatch] = await q(sql`
    INSERT INTO backup_jobs (org_id, config_id, device_id, status) VALUES (${t.orgId}, ${t.configId}, ${t.deviceId}, 'pending') RETURNING id`);
  const stamped = await withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
    deviceId: t.deviceId, configId: t.configId, jobId: dispatch!.id as string, mode: 'file', provider: 's3', providerConfig: prefixedDestination,
  }));
  expect(stamped.baseSnapshotId).toBe(P);

  // ── 7. Retention retires the legacy snapshot; GC deletes only its objects ──
  await q(sql`UPDATE backup_snapshots SET expires_at = now() - interval '1 minute' WHERE id = ${legacyDbId}`);
  const cleanup = await cleanupExpiredSnapshots(t.orgId);
  expect(cleanup.deleted).toBe(1);
  expect(await q(sql`SELECT key_layout, key_prefix FROM backup_snapshot_retirements WHERE snapshot_id = ${L}`))
    .toEqual([{ key_layout: 'legacy_flat', key_prefix: null }]);

  s3.calls.length = 0;
  await sweepUnreferencedBackupObjects();
  const deleted = s3.callsFor(bucket).flatMap((c) => (c.op === 'delete' ? c.keys : []));
  expect(deleted.sort()).toEqual([`snapshots/${L}/files/x.dat`, `snapshots/${L}/files/y.dat`, `snapshots/${L}/manifest.json`]);
  expect(deleted.some((k) => k.startsWith(`${PREFIX}/`))).toBe(false);
  expect(s3.keys(bucket)).toEqual(logicalKeys.map((k) => `${PREFIX}/${k}`).sort());
});
