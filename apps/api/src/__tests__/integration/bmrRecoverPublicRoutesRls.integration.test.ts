import './setup';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  backupSnapshotRetirements,
  bareMetalRecoveries,
  devices,
  recoveryTokens,
} from '../../db/schema';
import { generateRecoveryToken, hashRecoveryToken } from '../../services/recoveryBootstrap';
import { bmrPublicRoutes } from '../../routes/backup/bmr';
import { bmrRecoveryPublicRoutes } from '../../routes/backup/bmrRecoveries';
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
import { fetchBackupObjectBytes } from '../../services/backupSnapshotStorage';
import {
  generateRecoveryCode,
  hashRecoveryCode,
  hashRecoveryNonce,
  generateRecoveryNonce,
  formatRecoveryCode,
} from '../../services/bareMetalRecoveryCodes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// D9 — the three public, token-authenticated recovery routes
// (`bmrPublicRoutes`, mounted BEFORE authMiddleware in routes/backup/index.ts)
// query on the bare `db` with no RLS access context. `recovery_tokens` has
// FORCED RLS (breeze_has_org_access(org_id)), so as `breeze_app` with no
// `breeze.scope` GUC set, EVERY select returns zero rows and a freshly
// minted, active, unexpired token is rejected as "Invalid recovery token".
//
// This test mounts `bmrPublicRoutes` STANDALONE — no auth middleware, no
// ambient DB access context of any kind — which is exactly the shape of a
// real unauthenticated HTTP client hitting these routes in production. It
// must NOT wrap the request in withSystemDbAccessContext (unlike
// resilienceRouteCoverage.integration.test.ts, which deliberately fakes an
// authenticated context for a different purpose): doing so would hide the
// defect instead of proving the fix.

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeApp(): Hono {
  const app = new Hono();
  app.route('/', bmrPublicRoutes);
  return app;
}

function makeExchangeApp(): Hono {
  const app = new Hono();
  app.route('/', bmrRecoveryPublicRoutes);
  return app;
}

async function seedOrgWithLocalSnapshot(label: string) {
  const testDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id, name: `${label} site` });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [device] = await testDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `${label}-agent-${suffix}`,
      hostname: `${label}-host-${suffix}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: 'test',
      status: 'offline',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('device fixture insert failed');

  const storageRoot = await mkdtemp(join(tmpdir(), 'bmr-recover-rls-'));
  tempDirs.push(storageRoot);

  const [config] = await testDb
    .insert(backupConfigs)
    .values({
      orgId: org.id,
      name: `${label} config ${suffix}`,
      type: 'file',
      provider: 'local',
      providerConfig: { path: storageRoot },
    })
    .returning({ id: backupConfigs.id });
  if (!config) throw new Error('config fixture insert failed');

  const [job] = await testDb
    .insert(backupJobs)
    .values({
      orgId: org.id,
      configId: config.id,
      deviceId: device.id,
      status: 'completed',
    })
    .returning({ id: backupJobs.id });
  if (!job) throw new Error('job fixture insert failed');

  const providerSnapshotId = `snap-${suffix}`;
  const [snapshot] = await testDb
    .insert(backupSnapshots)
    .values({
      orgId: org.id,
      jobId: job.id,
      deviceId: device.id,
      configId: config.id,
      snapshotId: providerSnapshotId,
      metadata: { platform: 'windows' },
    })
    .returning({ id: backupSnapshots.id });
  if (!snapshot) throw new Error('snapshot fixture insert failed');

  const snapshotDir = join(storageRoot, 'snapshots', providerSnapshotId);
  await mkdir(snapshotDir, { recursive: true });
  const manifestContent = `manifest for ${label} ${suffix}`;
  await writeFile(join(snapshotDir, 'manifest.json'), manifestContent, 'utf8');

  return {
    orgId: org.id as string,
    deviceId: device.id as string,
    configId: config.id as string,
    snapshotDbId: snapshot.id as string,
    providerSnapshotId,
    manifestContent,
  };
}

async function insertActiveRecoveryToken(fixture: {
  orgId: string;
  deviceId: string;
  snapshotDbId: string;
}) {
  const testDb = getTestDb();
  const token = generateRecoveryToken();
  const tokenHash = hashRecoveryToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  const [row] = await testDb
    .insert(recoveryTokens)
    .values({
      orgId: fixture.orgId,
      deviceId: fixture.deviceId,
      snapshotId: fixture.snapshotDbId,
      tokenHash,
      restoreType: 'bare_metal',
      status: 'active',
      expiresAt,
    })
    .returning({ id: recoveryTokens.id });
  if (!row) throw new Error('recovery token fixture insert failed');

  return { id: row.id as string, token };
}

async function seedThreeGenerationChain() {
  const testDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id, name: 'w09 chain site' });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [device] = await testDb.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `w09-agent-${suffix}`, hostname: `w09-host-${suffix}`,
    osType: 'linux', osVersion: '24.04', architecture: 'x86_64', agentVersion: 'test', status: 'offline',
  }).returning({ id: devices.id });
  if (!device) throw new Error('device fixture insert failed');

  const storageRoot = await mkdtemp(join(tmpdir(), 'bmr-w09-chain-'));
  tempDirs.push(storageRoot);
  const storageIdentity = `local::${storageRoot}`;

  const [config] = await testDb.insert(backupConfigs).values({
    orgId: org.id, name: `w09 chain config ${suffix}`, type: 'file', provider: 'local', providerConfig: { path: storageRoot },
  }).returning({ id: backupConfigs.id });
  if (!config) throw new Error('config fixture insert failed');

  async function writeSnapshot(label: string, referencedFiles: number, files: Array<{ sourcePath: string; backupPath: string; size: number }>) {
    const snapshotId = `${label}-${suffix}`;
    const [job] = await testDb.insert(backupJobs).values({
      orgId: org.id, configId: config.id, deviceId: device.id, status: 'completed', referencedFiles, storageIdentity,
    }).returning({ id: backupJobs.id });
    if (!job) throw new Error('job fixture insert failed');
    const [snapshot] = await testDb.insert(backupSnapshots).values({
      orgId: org.id, jobId: job.id, deviceId: device.id, configId: config.id, snapshotId,
      storageIdentity, bareMetalRestorable: true, metadata: {},
    }).returning({ id: backupSnapshots.id });
    if (!snapshot) throw new Error('snapshot fixture insert failed');

    const dir = join(storageRoot, 'snapshots', snapshotId);
    await mkdir(join(dir, 'files'), { recursive: true });
    for (const file of files) {
      const abs = join(storageRoot, file.backupPath);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, `content for ${file.backupPath}`, 'utf8');
    }
    const manifest = { id: snapshotId, files };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    return { snapshotDbId: snapshot.id as string, snapshotId, jobId: job.id as string };
  }

  // g1: full backup, self-contained (own files only).
  const g1 = await writeSnapshot('g1', 0, [
    { sourcePath: '/a', backupPath: `snapshots/g1-${suffix}/files/a.gz`, size: 10 },
    { sourcePath: '/zzz', backupPath: `snapshots/g1-${suffix}/files/zzz.gz`, size: 5 }, // exists on disk, NEVER referenced by g3
  ]);
  // g2: incremental, references g1's a.gz for one file, adds its own b.gz.
  const g2 = await writeSnapshot('g2', 1, [
    { sourcePath: '/a', backupPath: `snapshots/g1-${suffix}/files/a.gz`, size: 10 },
    { sourcePath: '/b', backupPath: `snapshots/g2-${suffix}/files/b.gz`, size: 20 },
  ]);
  // g3: incremental, references g1's a.gz AND g2's b.gz, adds its own c.gz.
  const g3 = await writeSnapshot('g3', 2, [
    { sourcePath: '/a', backupPath: `snapshots/g1-${suffix}/files/a.gz`, size: 10 },
    { sourcePath: '/b', backupPath: `snapshots/g2-${suffix}/files/b.gz`, size: 20 },
    { sourcePath: '/c', backupPath: `snapshots/g3-${suffix}/files/c.gz`, size: 30 },
  ]);

  return { orgId: org.id as string, deviceId: device.id as string, storageRoot, storageIdentity, g1, g2, g3, suffix };
}

async function retireSnapshotRow(fixture: Awaited<ReturnType<typeof seedThreeGenerationChain>>, gen: { snapshotDbId: string; snapshotId: string }) {
  const testDb = getTestDb();
  await testDb.insert(backupSnapshotRetirements).values({
    orgId: fixture.orgId, deviceId: fixture.deviceId, snapshotId: gen.snapshotId,
    storageIdentity: fixture.storageIdentity, reason: 'manual',
  });
  await testDb.delete(backupSnapshots).where(eq(backupSnapshots.id, gen.snapshotDbId));
}

runDb(
  'authenticates a freshly minted, active, unexpired token through the UNAUTHENTICATED public route (D9)',
  async () => {
    const orgA = await seedOrgWithLocalSnapshot('legit');
    const { token } = await insertActiveRecoveryToken(orgA);

    const app = makeApp();
    // Deliberately NO auth header and NO ambient DB access context wrapper —
    // this is the real production shape for these three routes.
    const response = await app.request('/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    const body = await response.json();
    // BEFORE the fix this is 401 { error: 'Invalid recovery token' } — the
    // bare `db` SELECT on recovery_tokens runs with no breeze.scope GUC, so
    // forced RLS (breeze_has_org_access(org_id)) returns zero rows for a
    // token that genuinely exists and is genuinely valid.
    expect(response.status).toBe(200);
    expect(body.deviceId).toBe(orgA.deviceId);
    expect(body.snapshotId).toBe(orgA.snapshotDbId);
    expect(body.snapshot?.orgId).toBe(orgA.orgId);
    expect(body.device?.id).toBe(orgA.deviceId);
  }
);

runDb(
  'downloads the token org\'s own snapshot but cannot reach a second org\'s snapshot through the same token',
  async () => {
    const orgA = await seedOrgWithLocalSnapshot('owner');
    const orgB = await seedOrgWithLocalSnapshot('victim');
    const { token } = await insertActiveRecoveryToken(orgA);

    const app = makeApp();

    // Authenticate first — download requires 'authenticated' status.
    const authRes = await app.request('/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(authRes.status).toBe(200);

    // Own-org download succeeds and streams the real file — proves the
    // org-scoped context threads through resolveSnapshotProviderConfig /
    // getAuthenticatedRecoveryDownloadTarget, not just the token lookup.
    const ownDownload = await app.request(
      `/bmr/recover/download?path=${encodeURIComponent(`snapshots/${orgA.providerSnapshotId}/manifest.json`)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(ownDownload.status).toBe(200);
    const ownBody = await ownDownload.text();
    expect(ownBody).toBe(orgA.manifestContent);

    // Cross-org: the SAME token cannot be used to reach org B's snapshot.
    // resolveSnapshotProviderConfig always resolves off the TOKEN's own
    // snapshotId, so the download's allowed path prefix is pinned to org A's
    // snapshot regardless of what `path` claims — org B's snapshot id must
    // not be reachable through org A's token.
    // W09a Task 6: `snapshots/<other-snapshot-id>/...` is a well-formed
    // external-reference key shape, so it now classifies as `external`
    // (not `invalid`) and is refused by the exact-membership check with the
    // "not authorized to read" message — the "outside the allowed snapshot
    // scope" message is reserved for keys that fail the object-key contract
    // itself (see classifyBackupObjectKey in backupObjectKey.ts).
    const crossOrgDownload = await app.request(
      `/bmr/recover/download?path=${encodeURIComponent(`snapshots/${orgB.providerSnapshotId}/manifest.json`)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const crossOrgBody = await crossOrgDownload.json();
    expect(crossOrgDownload.status).toBe(409);
    expect(crossOrgBody.error).toBe('Requested path references an object this recovery is not authorized to read.');
  }
);

runDb('R6/R7/R9/R19: hydrates a three-generation chain, authorizes exact references after the origin row is retired, refuses everything else', async () => {
  const fixture = await seedThreeGenerationChain();
  await retireSnapshotRow(fixture, fixture.g1); // g1 retired BEFORE hydration — provenance must come from the retirement record

  const outcome = await hydrateSnapshotFileIndex(fixture.g3.snapshotDbId, {
    deps: { fetchManifestBytes: (args) => fetchBackupObjectBytes(args) },
  });
  expect(outcome).toMatchObject({ status: 'complete', externalCount: 2, entryCount: 3 });

  // Create a bare-metal recovery + exchange its code, WITH the capability.
  const code = generateRecoveryCode();
  const [rec] = await getTestDb().insert(bareMetalRecoveries).values({
    orgId: fixture.orgId, deviceId: fixture.deviceId, snapshotId: fixture.g3.snapshotDbId, identity: 'original',
    codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 900_000),
    nonceHash: hashRecoveryNonce(generateRecoveryNonce()), status: 'created',
  }).returning();
  if (!rec) throw new Error('recovery fixture insert failed');

  const exchangeApp = makeExchangeApp();
  const withCap = await exchangeApp.request('/bmr/recover/exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: formatRecoveryCode(code), capabilities: ['snapshot-file-membership-v1'] }),
  });
  expect(withCap.status).toBe(200);
  const withCapBody = await withCap.json();
  expect(withCapBody.bootstrap.snapshot.fileIndex.status).toBe('complete');
  const token = withCapBody.token as string;

  const downloadApp = makeApp();
  const authorize = async (path: string) =>
    downloadApp.request(`/bmr/recover/download?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` } });

  const ownFile = await authorize(`snapshots/${fixture.g3.snapshotId}/files/c.gz`);
  expect(ownFile.status).toBe(200);

  const g1Referenced = await authorize(`snapshots/${fixture.g1.snapshotId}/files/a.gz`);
  expect(g1Referenced.status).toBe(200); // R6 + R9: retired origin, still authorized

  const g1SiblingNotReferenced = await authorize(`snapshots/${fixture.g1.snapshotId}/files/zzz.gz`);
  expect(g1SiblingNotReferenced.status).toBe(409); // R7: on disk, not in g3's index

  const g2Manifest = await authorize(`snapshots/${fixture.g2.snapshotId}/manifest.json`);
  expect(g2Manifest.status).toBe(409); // R7: an ancestor's manifest itself is not a content reference
});

runDb('exchange without capabilities on a referenced snapshot is refused before the code is consumed', async () => {
  const fixture = await seedThreeGenerationChain();
  await hydrateSnapshotFileIndex(fixture.g3.snapshotDbId, { deps: { fetchManifestBytes: (args) => fetchBackupObjectBytes(args) } });

  const code = generateRecoveryCode();
  const [rec] = await getTestDb().insert(bareMetalRecoveries).values({
    orgId: fixture.orgId, deviceId: fixture.deviceId, snapshotId: fixture.g3.snapshotDbId, identity: 'original',
    codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 900_000),
    nonceHash: hashRecoveryNonce(generateRecoveryNonce()), status: 'created',
  }).returning();
  if (!rec) throw new Error('recovery fixture insert failed');

  const exchangeApp = makeExchangeApp();
  const res = await exchangeApp.request('/bmr/recover/exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: formatRecoveryCode(code) }), // no capabilities — legacy client
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe('client_capability_required');

  const [reread] = await getTestDb().select().from(bareMetalRecoveries).where(eq(bareMetalRecoveries.id, rec.id));
  expect(reread?.codeUsedAt).toBeNull();
  expect(reread?.status).toBe('created');
});

runDb('org B\'s snapshot key is refused through org A\'s token, even for an authorized external reference shape', async () => {
  const fixtureA = await seedThreeGenerationChain();
  const fixtureB = await seedThreeGenerationChain();
  await hydrateSnapshotFileIndex(fixtureA.g3.snapshotDbId, { deps: { fetchManifestBytes: (args) => fetchBackupObjectBytes(args) } });

  const token = generateRecoveryToken();
  await getTestDb().insert(recoveryTokens).values({
    orgId: fixtureA.orgId, deviceId: fixtureA.deviceId, snapshotId: fixtureA.g3.snapshotDbId,
    tokenHash: hashRecoveryToken(token), restoreType: 'bare_metal', status: 'active', expiresAt: new Date(Date.now() + 3_600_000),
  });
  const authApp = makeApp();
  const authRes = await authApp.request('/bmr/recover/authenticate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, capabilities: ['snapshot-file-membership-v1'] }),
  });
  expect(authRes.status).toBe(200);

  const crossOrg = await authApp.request(
    `/bmr/recover/download?path=${encodeURIComponent(`snapshots/${fixtureB.g1.snapshotId}/files/a.gz`)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(crossOrg.status).toBe(409);
});

runDb('R19: a 100,000-entry manifest with an empty agent-reported index hydrates to complete in one pass', async () => {
  const fixture = await seedThreeGenerationChain();
  const testDb = getTestDb();
  const g4Id = `g4-${fixture.suffix}`;
  const [job] = await testDb.insert(backupJobs).values({
    orgId: fixture.orgId, configId: (await testDb.select({ id: backupConfigs.id }).from(backupConfigs).limit(1))[0]!.id,
    deviceId: fixture.deviceId, status: 'completed', referencedFiles: 100_000, storageIdentity: fixture.storageIdentity,
  }).returning({ id: backupJobs.id });
  const [g4] = await testDb.insert(backupSnapshots).values({
    orgId: fixture.orgId, jobId: job!.id, deviceId: fixture.deviceId, snapshotId: g4Id,
    storageIdentity: fixture.storageIdentity, bareMetalRestorable: true, metadata: {},
  }).returning({ id: backupSnapshots.id });

  const dir = join(fixture.storageRoot, 'snapshots', g4Id);
  await mkdir(dir, { recursive: true });
  const files = Array.from({ length: 100_000 }, (_, i) => ({
    sourcePath: `/f${i}`, backupPath: `snapshots/${fixture.g1.snapshotId}/files/f${i}.gz`, size: 1,
  }));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: g4Id, files }), 'utf8');
  // NOTE: this test does NOT physically write 100,000 files to disk — only
  // the manifest. hydrateSnapshotFileIndex never reads the referenced content
  // objects themselves, only the manifest — proven by this test passing
  // without those files existing.

  const start = Date.now();
  const outcome = await hydrateSnapshotFileIndex(g4!.id, { deps: { fetchManifestBytes: (args) => fetchBackupObjectBytes(args) } });
  const elapsedMs = Date.now() - start;

  expect(outcome).toMatchObject({ status: 'complete', entryCount: 100_000, externalCount: 100_000 });
  expect(elapsedMs).toBeLessThan(60_000);
  const [{ count }] = await testDb.execute(sql`SELECT COUNT(*)::int AS count FROM backup_snapshot_files WHERE snapshot_db_id = ${g4!.id}`) as any;
  expect(Number(count)).toBe(100_000);
}, 90_000);
