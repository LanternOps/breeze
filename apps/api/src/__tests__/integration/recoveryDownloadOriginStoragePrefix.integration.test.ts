import './setup';

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { attestSnapshotForTest } from './restoreIntegrityFixture';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  backupConfigs,
  backupJobs,
  backupSnapshotOrigins,
  backupSnapshots,
  devices,
  recoveryTokens,
} from '../../db/schema';
import { runInRecoveryOrgContext } from '../../routes/backup/bmr';
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
import { fetchBackupObjectBytes } from '../../services/backupSnapshotStorage';
import { normalizeStorageIdentity } from '../../services/backupStorageIdentity';
import { generateRecoveryToken, hashRecoveryToken } from '../../services/recoveryBootstrap';
import { getAuthenticatedRecoveryDownloadTarget } from '../../services/recoveryDownloadService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// #8665: Hyper-V and MSSQL helpers (agent/cmd/breeze-backup/exec_hyperv.go)
// and reconcile adoption (backupSnapshotReconcile.ts manifestToCommandResult)
// record `metadata.storagePrefix` as the snapshot's FULL root,
// `snapshots/<id>`. Hydration copies that verbatim into
// backup_snapshot_origins.origin_storage_prefix, and an external reference's
// key already starts with `snapshots/<originId>/`. The recovery download path
// must therefore resolve the origin's recorded root the same way it resolves
// the token snapshot's own one, not prepend it to the key.

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Destination =
  | { provider: 'local'; storageRoot: string }
  | { provider: 's3'; bucket: string };

async function seedIncrementalOverRecordedRootOrigin(destination: Destination, originStoragePrefix: (originId: string) => string) {
  const testDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id, name: '8665 site' });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [device] = await testDb.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `8665-agent-${suffix}`, hostname: `8665-host-${suffix}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: 'test', status: 'offline',
  }).returning({ id: devices.id });
  if (!device) throw new Error('device fixture insert failed');

  const providerConfig: Record<string, unknown> = destination.provider === 'local'
    ? { path: destination.storageRoot }
    : { bucket: destination.bucket, region: 'us-east-1', accessKey: 'AKIAEXAMPLE8665', secretKey: 'secret-8665' };
  const storageIdentity = normalizeStorageIdentity(destination.provider, providerConfig);

  const [config] = await testDb.insert(backupConfigs).values({
    orgId: org.id, name: `8665 config ${suffix}`, type: 'file', provider: destination.provider, providerConfig,
  }).returning({ id: backupConfigs.id });
  if (!config) throw new Error('config fixture insert failed');

  const originId = `origin-${suffix}`;
  const currentId = `current-${suffix}`;
  const originFileKey = `snapshots/${originId}/files/a.bin`;
  const ownFileKey = `snapshots/${currentId}/files/b.bin`;

  async function insertSnapshot(snapshotId: string, referencedFiles: number, metadata: Record<string, unknown>) {
    const [job] = await testDb.insert(backupJobs).values({
      orgId: org.id, configId: config!.id, deviceId: device!.id, status: 'completed', referencedFiles, storageIdentity,
    }).returning({ id: backupJobs.id });
    if (!job) throw new Error('job fixture insert failed');
    const [snapshot] = await testDb.insert(backupSnapshots).values({
      orgId: org.id, jobId: job.id, deviceId: device!.id, configId: config!.id, snapshotId,
      storageIdentity, bareMetalRestorable: true, metadata,
    }).returning({ id: backupSnapshots.id });
    if (!snapshot) throw new Error('snapshot fixture insert failed');
    return snapshot.id as string;
  }

  // The origin is LIVE and carries the recorded full root, exactly as the
  // Hyper-V/MSSQL helper and reconcile adoption write it.
  const originDbId = await insertSnapshot(originId, 0, { storagePrefix: originStoragePrefix(originId) });
  const currentDbId = await insertSnapshot(currentId, 1, {});

  const manifestBytes = JSON.stringify({
    id: currentId,
    files: [
      { sourcePath: '/a', backupPath: originFileKey, size: 10 },
      { sourcePath: '/b', backupPath: ownFileKey, size: 20 },
    ],
  });
  if (destination.provider === 'local') {
    for (const key of [originFileKey, ownFileKey]) {
      const abs = join(destination.storageRoot, key);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, `content for ${key}`, 'utf8');
    }
    await writeFile(join(destination.storageRoot, 'snapshots', currentId, 'manifest.json'), manifestBytes, 'utf8');
  }
  await attestSnapshotForTest(currentDbId, {
    manifestSha256: createHash('sha256').update(manifestBytes, 'utf8').digest('hex'),
    manifestSize: Buffer.byteLength(manifestBytes),
  });

  const outcome = await hydrateSnapshotFileIndex(currentDbId, {
    deps: {
      fetchManifestBytes: destination.provider === 'local'
        ? (args) => fetchBackupObjectBytes(args)
        : async ({ key }) => {
          if (key !== `snapshots/${currentId}/manifest.json`) throw new Error(`unexpected manifest key ${key}`);
          return Buffer.from(manifestBytes, 'utf8');
        },
    },
  });
  expect(outcome).toMatchObject({ status: 'complete', externalCount: 1, entryCount: 2 });

  const token = generateRecoveryToken();
  const [tokenRow] = await testDb.insert(recoveryTokens).values({
    orgId: org.id, deviceId: device.id, snapshotId: currentDbId, tokenHash: hashRecoveryToken(token),
    restoreType: 'bare_metal', status: 'authenticated', authenticatedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000), negotiatedCapabilities: ['snapshot-file-membership-v1'],
  }).returning();
  if (!tokenRow) throw new Error('recovery token fixture insert failed');

  return { orgId: org.id as string, originId, originDbId, currentDbId, originFileKey, ownFileKey, tokenRow };
}

function presignedKeyOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('recovery download of an external reference whose origin recorded its full root (#8665)', () => {
  runDb('S3: presigns snapshots/<origin>/files/... — not snapshots/<origin>/snapshots/<origin>/...', async () => {
    const fixture = await seedIncrementalOverRecordedRootOrigin(
      { provider: 's3', bucket: `bucket-8665-${Date.now()}` },
      (originId) => `snapshots/${originId}`,
    );

    // The writer side, as hydration records it today.
    const [origin] = await getTestDb()
      .select({ originStoragePrefix: backupSnapshotOrigins.originStoragePrefix })
      .from(backupSnapshotOrigins)
      .where(and(
        eq(backupSnapshotOrigins.snapshotDbId, fixture.currentDbId),
        eq(backupSnapshotOrigins.originSnapshotId, fixture.originId),
      ));
    expect(origin?.originStoragePrefix).toBe(`snapshots/${fixture.originId}`);

    const external = await runInRecoveryOrgContext(fixture.orgId, () =>
      getAuthenticatedRecoveryDownloadTarget(fixture.tokenRow, fixture.originFileKey));
    expect(external.unavailable).toBe(false);
    if (external.unavailable || external.type !== 'redirect') throw new Error(`expected a redirect, got ${JSON.stringify(external)}`);
    expect(presignedKeyOf(external.url)).toBe(fixture.originFileKey);

    const own = await runInRecoveryOrgContext(fixture.orgId, () =>
      getAuthenticatedRecoveryDownloadTarget(fixture.tokenRow, fixture.ownFileKey));
    if (own.unavailable || own.type !== 'redirect') throw new Error(`expected a redirect, got ${JSON.stringify(own)}`);
    expect(presignedKeyOf(own.url)).toBe(fixture.ownFileKey);
  });

  runDb('S3: an origin root recorded under a base prefix keeps that base, once', async () => {
    const fixture = await seedIncrementalOverRecordedRootOrigin(
      { provider: 's3', bucket: `bucket-8665-${Date.now()}` },
      (originId) => `legacy/snapshots/${originId}`,
    );

    const external = await runInRecoveryOrgContext(fixture.orgId, () =>
      getAuthenticatedRecoveryDownloadTarget(fixture.tokenRow, fixture.originFileKey));
    if (external.unavailable || external.type !== 'redirect') throw new Error(`expected a redirect, got ${JSON.stringify(external)}`);
    expect(presignedKeyOf(external.url)).toBe(`legacy/${fixture.originFileKey}`);
  });

  runDb('local: streams the origin object from <root>/snapshots/<origin>/files/...', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'recovery-8665-'));
    tempDirs.push(storageRoot);
    const fixture = await seedIncrementalOverRecordedRootOrigin(
      { provider: 'local', storageRoot },
      (originId) => `snapshots/${originId}`,
    );

    const external = await runInRecoveryOrgContext(fixture.orgId, () =>
      getAuthenticatedRecoveryDownloadTarget(fixture.tokenRow, fixture.originFileKey));
    expect(external.unavailable).toBe(false);
    if (external.unavailable || external.type !== 'stream') throw new Error(`expected a stream, got ${JSON.stringify(external)}`);
    expect((await readStream(external.stream)).toString('utf8')).toBe(`content for ${fixture.originFileKey}`);
  });
});
