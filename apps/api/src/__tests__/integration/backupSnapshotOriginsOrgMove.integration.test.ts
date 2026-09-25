/**
 * Live-Postgres coverage for #6488: `backup_snapshot_origins` pins
 * origin_org_id / origin_device_id at hydration time, so a device org-move
 * (which re-stamps backup_snapshots.org_id but cannot touch the origins table
 * — it has no org_id/device_id column) left every external-reference download
 * refused with "origin identity does not match the recovery token".
 *
 * The fix (migrations/2026-10-31-100700-backup-snapshot-file-index-org-move-reset.sql)
 * is a BEFORE UPDATE trigger on backup_snapshots: when org_id or device_id
 * changes, a 'complete' / 'hydrating' file index drops back to 'none', so the
 * next authenticate/exchange negotiation re-hydrates it against the snapshot's
 * CURRENT org/device. Downloads stay fail-closed in between (authorization
 * requires 'complete'), and the re-hydrated provenance authorizes again.
 *
 * WHY A REAL DATABASE: the org re-stamp happens on three paths — the move-org
 * route's denormalized-table loop, `breeze_cascade_device_org_id()` on a raw
 * `UPDATE devices`, and org merge — and only a trigger reaches all of them.
 * A mocked suite cannot prove the trigger fires, nor that the re-hydrated
 * provenance authorizes against the moved token.
 */
import './setup';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshotOrigins,
  backupSnapshots,
  devices,
} from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';
import { hydrateSnapshotFileIndex } from '../../services/backupSnapshotFileIndex';
import { authorizeExternalReference } from '../../services/recoveryDownloadService';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';

const MIGRATION = '2026-10-31-100700-backup-snapshot-file-index-org-move-reset.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');

const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', {
  max: 1,
  onnotice: (n) => { notices.push(String(n.message)); },
});
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

const PROVIDER_CONFIG = { path: '/tmp/breeze-6488-backups' };
const STORAGE_IDENTITY = normalizeStorageIdentity('local', PROVIDER_CONFIG);

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed() {
  const testDb = getTestDb();
  const sfx = uid();

  const { partner, organization: sourceOrg, site: sourceSite, user, role } = await setupTestEnvironment({
    scope: 'partner',
  });
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const targetSite = await createSite({ orgId: targetOrg.id });

  async function makeDevice(tag: string) {
    const [d] = await testDb.insert(devices).values({
      orgId: sourceOrg.id,
      siteId: sourceSite.id,
      agentId: `origins-${tag}-${sfx}`,
      hostname: `origins-${tag}-${sfx}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    }).returning({ id: devices.id });
    return d!.id;
  }
  const deviceId = await makeDevice('moved');
  const otherDeviceId = await makeDevice('stays');

  // Snapshot metadata pins the provider (no config_id), so provider
  // resolution does not depend on a source-org backup_configs row.
  const metadata = { provider: 'local', providerConfig: PROVIDER_CONFIG };

  async function makeJob(forDevice: string, referencedFiles: number) {
    const [cfg] = await testDb.insert(backupConfigs).values({
      orgId: sourceOrg.id,
      name: `origins-${sfx}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'file',
      provider: 'local',
      providerConfig: PROVIDER_CONFIG,
    }).returning({ id: backupConfigs.id });
    const [job] = await testDb.insert(backupJobs).values({
      orgId: sourceOrg.id,
      configId: cfg!.id,
      deviceId: forDevice,
      status: 'completed',
      referencedFiles,
    } as never).returning({ id: backupJobs.id });
    return job!.id;
  }

  async function makeSnapshot(forDevice: string, snapshotId: string, jobId: string, status: string) {
    const [s] = await testDb.insert(backupSnapshots).values({
      orgId: sourceOrg.id,
      jobId,
      deviceId: forDevice,
      snapshotId,
      timestamp: new Date(),
      storageIdentity: STORAGE_IDENTITY,
      metadata,
      fileIndexStatus: status,
    } as never).returning({ id: backupSnapshots.id });
    return s!.id;
  }

  // Moved device: an older FULL snapshot (the origin) and an incremental
  // whose manifest references one of the full snapshot's objects.
  const baseSnapshotId = `base-${sfx}`;
  const incrSnapshotId = `incr-${sfx}`;
  await makeSnapshot(deviceId, baseSnapshotId, await makeJob(deviceId, 0), 'none');
  const incrDbId = await makeSnapshot(deviceId, incrSnapshotId, await makeJob(deviceId, 1), 'none');
  const agentDbId = await makeSnapshot(deviceId, `agent-${sfx}`, await makeJob(deviceId, 0), 'agent');

  // Unrelated device that never moves: its complete index must survive.
  const otherBaseId = `obase-${sfx}`;
  const otherIncrId = `oincr-${sfx}`;
  await makeSnapshot(otherDeviceId, otherBaseId, await makeJob(otherDeviceId, 0), 'none');
  const otherIncrDbId = await makeSnapshot(otherDeviceId, otherIncrId, await makeJob(otherDeviceId, 1), 'none');

  const externalKey = `snapshots/${baseSnapshotId}/files/etc/hosts`;
  const otherExternalKey = `snapshots/${otherBaseId}/files/etc/hosts`;
  const manifests = new Map<string, unknown>([
    [incrSnapshotId, {
      id: incrSnapshotId,
      files: [
        { sourcePath: '/etc/hosts', backupPath: externalKey, size: 10 },
        { sourcePath: '/etc/new', backupPath: `snapshots/${incrSnapshotId}/files/etc/new`, size: 5 },
      ],
    }],
    [otherIncrId, {
      id: otherIncrId,
      files: [{ sourcePath: '/etc/hosts', backupPath: otherExternalKey, size: 10 }],
    }],
  ]);
  const deps = {
    fetchManifestBytes: async ({ key }: { key: string }) => {
      const id = key.split('/')[1]!;
      const manifest = manifests.get(id);
      if (!manifest) throw new Error(`no manifest for ${key}`);
      return new TextEncoder().encode(JSON.stringify(manifest));
    },
  };

  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });
  const app = new Hono();
  app.route('/devices', moveOrgRoutes);
  const postMove = async () =>
    app.request(`/devices/${deviceId}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        await withMoveOrgStepUpGrant(token, deviceId, { orgId: targetOrg.id, siteId: targetSite.id }),
      ),
    });

  return {
    sourceOrgId: sourceOrg.id,
    targetOrgId: targetOrg.id,
    targetSiteId: targetSite.id,
    deviceId,
    otherDeviceId,
    baseSnapshotId,
    incrDbId,
    agentDbId,
    otherBaseId,
    otherIncrDbId,
    externalKey,
    otherExternalKey,
    deps,
    postMove,
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function status(snapshotDbId: string) {
  const [row] = await getTestDb()
    .select({ status: backupSnapshots.fileIndexStatus, orgId: backupSnapshots.orgId })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, snapshotDbId));
  return row;
}

function authorize(f: Fixture, args: { snapshotDbId: string; key: string; originSnapshotId: string; orgId: string; deviceId: string }) {
  return authorizeExternalReference(getTestDb() as never, {
    tokenId: 'it-token',
    pinnedStorageIdentity: STORAGE_IDENTITY,
    ...args,
  });
}

async function hydrateBoth(f: Fixture) {
  const a = await hydrateSnapshotFileIndex(f.incrDbId, { deps: f.deps });
  const b = await hydrateSnapshotFileIndex(f.otherIncrDbId, { deps: f.deps });
  expect(a.status, JSON.stringify(a)).toBe('complete');
  expect(b.status, JSON.stringify(b)).toBe('complete');
}

async function assertMovedAndRecovers(f: Fixture) {
  // Moved: the index is no longer 'complete', so the stale provenance can no
  // longer produce a baffling "origin identity" refusal — the download is
  // refused as "not complete" and negotiation will re-hydrate it.
  const moved = await status(f.incrDbId);
  expect(moved?.orgId).toBe(f.targetOrgId);
  expect(moved?.status, 'org-move must reset a complete file index').toBe('none');
  const refused = await authorize(f, {
    snapshotDbId: f.incrDbId, key: f.externalKey, originSnapshotId: f.baseSnapshotId,
    orgId: f.targetOrgId, deviceId: f.deviceId,
  });
  expect(refused).toEqual({ ok: false, reason: 'file index not complete' });

  // 'agent' is not a verified index; the trigger leaves it alone (it already
  // re-hydrates on the next negotiation).
  expect((await status(f.agentDbId))?.status).toBe('agent');

  // Unrelated device: untouched.
  const other = await status(f.otherIncrDbId);
  expect(other?.orgId).toBe(f.sourceOrgId);
  expect(other?.status).toBe('complete');
  expect(await authorize(f, {
    snapshotDbId: f.otherIncrDbId, key: f.otherExternalKey, originSnapshotId: f.otherBaseId,
    orgId: f.sourceOrgId, deviceId: f.otherDeviceId,
  })).toMatchObject({ ok: true });

  // Re-hydration against the snapshot's CURRENT org authorizes again...
  const rehydrated = await hydrateSnapshotFileIndex(f.incrDbId, { deps: f.deps });
  expect(rehydrated.status, JSON.stringify(rehydrated)).toBe('complete');
  const [origin] = await getTestDb()
    .select({ orgId: backupSnapshotOrigins.originOrgId })
    .from(backupSnapshotOrigins)
    .where(eq(backupSnapshotOrigins.snapshotDbId, f.incrDbId));
  expect(origin?.orgId).toBe(f.targetOrgId);
  expect(await authorize(f, {
    snapshotDbId: f.incrDbId, key: f.externalKey, originSnapshotId: f.baseSnapshotId,
    orgId: f.targetOrgId, deviceId: f.deviceId,
  })).toMatchObject({ ok: true });

  // ...and stays fail-closed for a token still naming the SOURCE org.
  expect(await authorize(f, {
    snapshotDbId: f.incrDbId, key: f.externalKey, originSnapshotId: f.baseSnapshotId,
    orgId: f.sourceOrgId, deviceId: f.deviceId,
  })).toEqual({ ok: false, reason: 'origin identity does not match the recovery token' });
}

describe('backup_snapshot_origins provenance after a device org-move (#6488)', () => {
  it('POST /devices/:id/move-org resets the moved file index; re-hydration authorizes under the new org', async () => {
    const f = await seed();
    await hydrateBoth(f);
    expect(await authorize(f, {
      snapshotDbId: f.incrDbId, key: f.externalKey, originSnapshotId: f.baseSnapshotId,
      orgId: f.sourceOrgId, deviceId: f.deviceId,
    })).toMatchObject({ ok: true });

    const res = await f.postMove();
    const body = (await res.json()) as { success?: boolean };
    expect(res.status, JSON.stringify(body)).toBe(200);

    await assertMovedAndRecovers(f);
  });

  it('a raw UPDATE devices under breeze_app (breeze_cascade_device_org_id) resets it too', async () => {
    const f = await seed();
    await hydrateBoth(f);

    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
         WHERE id = ${f.deviceId}::uuid
      `);
    });

    await assertMovedAndRecovers(f);
  });

  it('updates that do not change org_id/device_id leave a complete index alone', async () => {
    const f = await seed();
    await hydrateBoth(f);
    await getTestDb().update(backupSnapshots).set({ label: 'relabelled' }).where(eq(backupSnapshots.id, f.incrDbId));
    await getTestDb().update(backupSnapshots).set({ orgId: f.sourceOrgId }).where(eq(backupSnapshots.id, f.incrDbId));
    expect((await status(f.incrDbId))?.status).toBe('complete');
  });

  it('a hydration that read the snapshot before a concurrent org-move committed publishes the NEW org, not its stale read', async () => {
    const f = await seed();
    // hydrateSnapshotFileIndex runs in ONE transaction, so a move can never
    // land between its claim and its publish — the claim's row lock blocks
    // the move. The window is the other way round: the move holds the
    // backup_snapshots row lock uncommitted, hydration reads the snapshot
    // (READ COMMITTED: still the source org), then blocks on its claim
    // UPDATE until the move commits. What it publishes must describe the
    // snapshot's post-move identity, not the stale pre-claim read.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const moveLocked = new Promise<void>((r) => { locked = r; });
    const moveTx = adminSql.begin(async (tx) => {
      await tx`UPDATE devices SET org_id = ${f.targetOrgId}, site_id = ${f.targetSiteId} WHERE id = ${f.deviceId}`;
      locked();
      await held;
    });
    await moveLocked;

    const hydration = hydrateSnapshotFileIndex(f.incrDbId, { deps: f.deps });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const rows = await getTestDb().execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query ILIKE '%file_index_status%'
      `);
      if ((rows[0]?.n ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error('hydration never blocked on the move lock');
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await moveTx;

    const outcome = await hydration;
    expect((await status(f.incrDbId))?.orgId).toBe(f.targetOrgId);
    const origins = await getTestDb()
      .select({ orgId: backupSnapshotOrigins.originOrgId })
      .from(backupSnapshotOrigins)
      .where(eq(backupSnapshotOrigins.snapshotDbId, f.incrDbId));
    expect(
      origins.every((o) => o.orgId === f.targetOrgId),
      `no source-org provenance may be published for the moved snapshot: ${JSON.stringify({ outcome, origins })}`,
    ).toBe(true);
    expect(outcome.status, JSON.stringify(outcome)).toBe('complete');
    expect(await authorize(f, {
      snapshotDbId: f.incrDbId, key: f.externalKey, originSnapshotId: f.baseSnapshotId,
      orgId: f.targetOrgId, deviceId: f.deviceId,
    })).toMatchObject({ ok: true });
  });
});

describe(`migration ${MIGRATION} backfill`, () => {
  it('resets complete indexes whose recorded provenance no longer matches the snapshot org/device, and is idempotent', async () => {
    const f = await seed();
    await hydrateBoth(f);

    // Simulate a pre-fix org-move: re-stamp the snapshot with the trigger
    // bypassed (session_replication_role=replica skips ordinary triggers),
    // leaving 'complete' + source-org origins behind.
    await adminSql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL session_replication_role = replica`);
      await tx`UPDATE backup_snapshots SET org_id = ${f.targetOrgId} WHERE id = ${f.incrDbId}`;
    });
    expect((await status(f.incrDbId))?.status).toBe('complete');

    notices.length = 0;
    await adminSql.unsafe(migrationSql);
    expect((await status(f.incrDbId))?.status).toBe('none');
    expect((await status(f.otherIncrDbId))?.status, 'matching provenance is left alone').toBe('complete');
    expect(notices.some((n) => /reset file_index_status on 1 /.test(n)), notices.join('\n')).toBe(true);

    notices.length = 0;
    await adminSql.unsafe(migrationSql);
    expect(notices.filter((n) => /reset file_index_status/.test(n))).toEqual([]);
  });
});
