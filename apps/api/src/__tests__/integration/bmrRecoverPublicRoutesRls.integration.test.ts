import './setup';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
  recoveryTokens,
} from '../../db/schema';
import { generateRecoveryToken, hashRecoveryToken } from '../../services/recoveryBootstrap';
import { bmrPublicRoutes } from '../../routes/backup/bmr';

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
    const crossOrgDownload = await app.request(
      `/bmr/recover/download?path=${encodeURIComponent(`snapshots/${orgB.providerSnapshotId}/manifest.json`)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const crossOrgBody = await crossOrgDownload.json();
    expect(crossOrgDownload.status).toBe(409);
    expect(crossOrgBody.error).toBe('Requested path is outside the allowed snapshot scope.');
  }
);
