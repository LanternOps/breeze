/**
 * #11736 step 2 (W5 measurement, #12741): every reader of the snapshot file
 * index turns JIT off in its own transaction before it reads.
 *
 * Measured on Postgres 16 with JIT available (the shipped compose image) and
 * the default jit_above_cost: once backup_tree_checkpoint_entries has
 * statistics with rows, every statement built on snapshotIndexEntries is
 * estimated at about 470,000 to 510,000 (the checkpoint leg's runtime
 * checkpoint id gets a generic row estimate, times a per-row tombstone probe)
 * while it runs in a few milliseconds. So each was JIT-compiled: a 5,000-row
 * selection page took about 110 ms, 95 ms of it compiling, instead of 3.4 ms,
 * and past jit_optimize_above_cost about 900 ms. A 1.1M-entry selection walk
 * went from 6 s to 28 s. The statement shape does not depend on the format, so
 * rows-format snapshots paid it too as soon as any checkpoint existed.
 *
 * The setting is transaction-local (set_config(..., true)): it lasts until the
 * reader's transaction ends, or its savepoint rolls back.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupSnapshotIndexJit.integration.test.ts
 */
import './setup';

import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { listSnapshotDirectory, resolveSelectedSnapshotPathsInDb, searchSnapshotFiles } from '../../services/backupSnapshotBrowse';
import { readSnapshotIndexView } from '../../services/backupSnapshotIndexView';
import { drizzleBrokeredReadStore } from '../../services/backupStorageSessionStore';
import { authorizeExternalReference } from '../../services/recoveryDownloadService';
import { WRITE_IDENTITY, insertSnapshotRow, orgContext, seedWriteTenant } from './backupWriteFixtures';
import { seedCheckpoint, seedDeltaIndex, seedRowsIndex, type IndexEntry } from './helpers/backupIndexFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function tree(snapshotId: string, files = 200): IndexEntry[] {
  return Array.from({ length: files }, (_, i) => ({
    sourcePath: `C:/Data/d${String(Math.floor(i / 20)).padStart(2, '0')}/f${String(i).padStart(4, '0')}.dat`,
    backupPath: `snapshots/${snapshotId}/files/f${i}`,
    size: 100 + i,
    modifiedAt: '2026-11-01T00:00:00.000Z',
    kind: null,
  }));
}

async function seed() {
  const t = await seedWriteTenant({ jobStatus: 'completed' });
  const run = randomBytes(4).toString('hex');
  const baseId = `snapshot-20261101T000001Z-${run}`;
  const deltaId = `snapshot-20261101T000002Z-${run}`;
  const rowsId = `snapshot-20261101T000003Z-${run}`;
  const base = tree(baseId);
  const changed = base.map((e, i) => (i % 10 === 0 ? { ...e, size: (e.size ?? 0) + 1, backupPath: e.backupPath.replace(baseId, deltaId) } : e));
  const checkpointId = await seedCheckpoint({ orgId: t.orgId, deviceId: t.deviceId, configId: t.configId, storageIdentity: WRITE_IDENTITY }, base);
  const delta = await insertSnapshotRow(t, deltaId);
  await seedDeltaIndex(delta, checkpointId, base, changed, sha(deltaId));
  const rows = await insertSnapshotRow(t, rowsId);
  await seedRowsIndex(rows, tree(rowsId), sha(rowsId));
  return { t, snapshots: { delta: { id: delta, key: changed[1]!.backupPath, digest: sha(deltaId) }, rows: { id: rows, key: tree(rowsId)[1]!.backupPath, digest: sha(rowsId) } } };
}

/** `read`'s transaction-local jit setting, before and after it ran, in the org's request transaction. */
async function jitAround(orgId: string, read: () => Promise<unknown>): Promise<{ before: string; after: string; result: unknown }> {
  const show = async () => ((await db.execute(sql`SELECT current_setting('jit') AS jit`)) as unknown as Array<{ jit: string }>)[0]!.jit;
  return runOutsideDbContext(() => withDbAccessContext(orgContext(orgId), async () => {
    // As the server has it (jit is on by default where Postgres has JIT support).
    await db.execute(sql`SELECT set_config('jit', 'on', true)`);
    const before = await show();
    const result = await read();
    return { before, after: await show(), result };
  }));
}

describe('readers of the snapshot file index run with JIT off (#12741)', () => {
  for (const format of ['delta', 'rows'] as const) {
    runDb(`every reader, ${format} format`, async () => {
      const { t, snapshots } = await seed();
      const s = snapshots[format];
      const readers: Record<string, () => Promise<unknown>> = {
        listSnapshotDirectory: () => listSnapshotDirectory({ snapshotDbId: s.id, segments: ['C:', 'Data'], limit: 50 }),
        searchSnapshotFiles: () => searchSnapshotFiles({ snapshotDbId: s.id, query: 'f0001', limit: 10, after: null }),
        resolveSelectedSnapshotPathsInDb: () => resolveSelectedSnapshotPathsInDb(s.id, ['/C:/Data/d00']),
        countIndexedFiles: () => drizzleBrokeredReadStore.countIndexedFiles(s.id),
        filterIndexedKeys: () => drizzleBrokeredReadStore.filterIndexedKeys(s.id, [s.key], s.digest),
        readSnapshotIndexView: () => readSnapshotIndexView(s.id, t.orgId),
        // An unknown key: refused at the membership read, after the gates before it.
        authorizeExternalReference: () => authorizeExternalReference(db, {
          tokenId: 'jit-test', snapshotDbId: s.id, key: 'snapshots/none/files/missing', originSnapshotId: 'none',
          orgId: t.orgId, deviceId: t.deviceId, pinnedStorageIdentity: WRITE_IDENTITY,
        }),
      };
      const seen: Record<string, { before: string; after: string }> = {};
      for (const [name, read] of Object.entries(readers)) {
        const { before, after } = await jitAround(t.orgId, read);
        seen[name] = { before, after };
      }
      expect(seen).toEqual(Object.fromEntries(Object.keys(readers).map((name) => [name, { before: 'on', after: 'off' }])));

      // The readers still answer correctly with it.
      const { result: refused } = await jitAround(t.orgId, readers.authorizeExternalReference!);
      expect(refused).toEqual({ ok: false, reason: 'key is not a member of the snapshot file index' });
      const { result: counted } = await jitAround(t.orgId, readers.countIndexedFiles!);
      expect(counted).toBe(200);
    }, 120_000);
  }
});
