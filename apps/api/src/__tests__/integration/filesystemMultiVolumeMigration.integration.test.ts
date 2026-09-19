/**
 * Live-Postgres proof for 2026-10-20-170000-filesystem-multi-volume.sql and
 * 2026-10-20-170100-filesystem-cleanup-run-status-running.sql (spec §4).
 *
 * Prerequisites:
 *   pnpm test-stack up
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner, createSite } from './db-utils';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const MIGRATION = '2026-10-20-170000-filesystem-multi-volume.sql';
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedDevice(osType: 'windows' | 'linux') {
  const db = getTestDb();
  const partner = await createPartner({});
  const org = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  const rows = (await db.execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${org!.id}, ${site!.id}, ${randomUUID()}, ${`fs-${osType}-${randomUUID().slice(0, 8)}`},
            ${osType}, '1', 'amd64', '1.0.0')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { orgId: org!.id as string, deviceId: rows[0]!.id };
}

/**
 * Inserts a snapshot with scan_path NULL — the pre-migration shape, and also
 * exactly what an old API replica writes during a rolling deploy.
 */
async function seedPreMigrationSnapshot(
  deviceId: string,
  orgId: string,
  rawPath: string | null,
): Promise<string> {
  const db = getTestDb();
  const rows = (await db.execute(sql`
    INSERT INTO device_filesystem_snapshots (device_id, org_id, scan_path, raw_payload)
    VALUES (${deviceId}, ${orgId}, NULL,
            ${JSON.stringify(rawPath === null ? {} : { path: rawPath })}::jsonb)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

async function scanPathOf(snapshotId: string): Promise<string | null> {
  const rows = (await getTestDb().execute(sql`
    SELECT scan_path FROM device_filesystem_snapshots WHERE id = ${snapshotId}
  `)) as unknown as Array<{ scan_path: string | null }>;
  return rows[0]?.scan_path ?? null;
}

/**
 * W02 leaves both `scan_path` columns NULLABLE (expand/contract, spec §13 #7),
 * so a pre-migration row can be seeded directly — no constraint has to be
 * dropped and put back, and nothing this suite does is visible to another
 * suite even momentarily. When W03's contract migration lands, THIS is the
 * helper that has to come back.
 */
async function clearScanPaths(ids: string[]) {
  if (ids.length === 0) return;
  await getTestDb().execute(sql`
    UPDATE device_filesystem_snapshots SET scan_path = NULL
     WHERE id = ANY(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})
  `);
}

describe('2026-10-20-170000 — snapshot scan_path backfill', () => {
  runDb('normalises a Windows path: lower-case drive, mixed separators, repeats, trailing slash', async () => {
    const { deviceId, orgId } = await seedDevice('windows');
    const id = await seedPreMigrationSnapshot(deviceId, orgId, 'c:/Users//Todd/');

    await replayMigration(MIGRATION);

    // Drive letter upper-cased, separators converted and collapsed, trailing
    // separator dropped, and the case BELOW the drive preserved — byte for
    // byte what normalizeScanPath('windows', …) returns.
    expect(await scanPathOf(id)).toBe('C:\\Users\\Todd');
  });

  runDb('keeps the trailing separator on a Windows volume root', async () => {
    const { deviceId, orgId } = await seedDevice('windows');
    const root = await seedPreMigrationSnapshot(deviceId, orgId, 'c:\\');
    const second = await seedPreMigrationSnapshot(deviceId, orgId, 'd:/');

    await replayMigration(MIGRATION);

    expect(await scanPathOf(root)).toBe('C:\\');
    expect(await scanPathOf(second)).toBe('D:\\');
  });

  runDb('normalises a POSIX path and keeps / as /', async () => {
    const { deviceId, orgId } = await seedDevice('linux');
    const nested = await seedPreMigrationSnapshot(deviceId, orgId, '//var//tmp/');
    const root = await seedPreMigrationSnapshot(deviceId, orgId, '/');

    await replayMigration(MIGRATION);

    expect(await scanPathOf(nested)).toBe('/var/tmp');
    expect(await scanPathOf(root)).toBe('/');
  });

  runDb('falls back to the OS root when the snapshot recorded no path', async () => {
    const windows = await seedDevice('windows');
    const linux = await seedDevice('linux');
    const noKey = await seedPreMigrationSnapshot(windows.deviceId, windows.orgId, null);
    const empty = await seedPreMigrationSnapshot(linux.deviceId, linux.orgId, '');

    await replayMigration(MIGRATION);

    expect(await scanPathOf(noKey)).toBe('C:\\');
    expect(await scanPathOf(empty)).toBe('/');
  });

  runDb('stores a dot-segment path VERBATIM rather than re-keying it to the OS root', async () => {
    // Plan amendment 3. Such a row matches no normalised read, so it becomes
    // inert history. Re-keying it to '/' would fold another directory's
    // cleanup candidates into the root preview, which is the bug, not the fix.
    const { deviceId, orgId } = await seedDevice('linux');
    const dotted = await seedPreMigrationSnapshot(deviceId, orgId, '/opt/app/../data');

    await replayMigration(MIGRATION);

    expect(await scanPathOf(dotted)).toBe('/opt/app/../data');
    expect(await scanPathOf(dotted)).not.toBe('/');
  });

  runDb('leaves BOTH scan_path columns nullable — W02 is the expand half', async () => {
    // Spec §13 #7 / amendment 15. This assertion is the guard on the rollout
    // contract: a NOT NULL here rejects the snapshot INSERT of every old API
    // replica still draining during the deploy (23502) and loses a completed
    // scan. W03's contract migration flips it, and flips this expectation.
    const rows = (await getTestDb().execute(sql`
      SELECT table_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name = 'scan_path'
         AND table_name IN ('device_filesystem_snapshots', 'device_filesystem_scan_state')
       ORDER BY table_name
    `)) as unknown as Array<{ table_name: string; is_nullable: string }>;
    expect(rows).toEqual([
      { table_name: 'device_filesystem_scan_state', is_nullable: 'YES' },
      { table_name: 'device_filesystem_snapshots', is_nullable: 'YES' },
    ]);
  });

  runDb('accepts an old replica\u2019s snapshot insert with no scan_path at all', async () => {
    // The rollout case stated as a test rather than as prose.
    const { deviceId, orgId } = await seedDevice('windows');
    const id = await seedPreMigrationSnapshot(deviceId, orgId, null);
    expect(await scanPathOf(id)).toBeNull();
  });
});

describe('2026-10-20-170000 — scan-state key and the rest of the shape', () => {
  /** Seeds a legacy scan-state row: no scan_path, with resume state attached. */
  async function seedLegacyScanState(
    deviceId: string,
    orgId: string,
    checkpointPath: string,
  ) {
    await getTestDb().execute(sql`
      INSERT INTO device_filesystem_scan_state
        (device_id, org_id, scan_path, last_run_mode, last_baseline_completed_at,
         last_disk_used_percent, checkpoint, aggregate, hot_directories)
      VALUES (${deviceId}, ${orgId}, NULL, 'baseline', '2026-09-18T00:00:00Z', 71,
              ${JSON.stringify({ pendingDirs: [{ path: checkpointPath, depth: 1 }] })}::jsonb,
              ${JSON.stringify({ path: checkpointPath })}::jsonb,
              ${JSON.stringify([checkpointPath])}::jsonb)
    `);
  }

  async function scanStateOf(deviceId: string) {
    const rows = (await getTestDb().execute(sql`
      SELECT scan_path, checkpoint, aggregate, hot_directories,
             last_baseline_completed_at, last_disk_used_percent, scan_generation
        FROM device_filesystem_scan_state WHERE device_id = ${deviceId}
    `)) as unknown as Array<Record<string, unknown>>;
    return rows[0]!;
  }

  runDb('PASS A: adopts the volume of the device\u2019s newest snapshot when it still matches a disk', async () => {
    // Spec §13 #8. The row's checkpoint genuinely belongs to D:\, the device
    // still reports a D:\ disk, so the label is adopted and the resume state
    // is KEPT — no re-scan is imposed on a device we can place correctly.
    const { deviceId, orgId } = await seedDevice('windows');
    const db = getTestDb();
    await db.execute(sql`
      INSERT INTO device_disks (device_id, org_id, mount_point, fs_type, total_gb, used_gb, free_gb, used_percent)
      VALUES (${deviceId}, ${orgId}, 'd:/', 'NTFS', 2000, 100, 1900, 5)
    `);
    await seedPreMigrationSnapshot(deviceId, orgId, 'D:\\');
    await seedLegacyScanState(deviceId, orgId, 'D:\\media');

    await replayMigration(MIGRATION);

    const state = await scanStateOf(deviceId);
    expect(state.scan_path).toBe('D:\\');
    expect(state.checkpoint).toEqual({ pendingDirs: [{ path: 'D:\\media', depth: 1 }] });
    expect(state.hot_directories).toEqual(['D:\\media']);
  });

  runDb('PASS A: adopts the OS root when the newest snapshot names it, even with no disk rows', async () => {
    const { deviceId, orgId } = await seedDevice('linux');
    await seedPreMigrationSnapshot(deviceId, orgId, '/');
    await seedLegacyScanState(deviceId, orgId, '/var');

    await replayMigration(MIGRATION);

    const state = await scanStateOf(deviceId);
    expect(state.scan_path).toBe('/');
    expect(state.hot_directories).toEqual(['/var']);
  });

  runDb('PASS B: a D:\\ checkpoint under a device with no matching disk is CLEARED, not relabelled', async () => {
    // THE case spec §13 #8 is about. The device reports only C:, so the D:\
    // resume state cannot be placed. Relabelling the row C:\ and keeping the
    // checkpoint would make the next C:\ scan resume into D:\ paths and
    // inherit D:\ hot directories — defect 6, reintroduced by the migration
    // that fixes it. The label is applied; the resume state is dropped.
    const { deviceId, orgId } = await seedDevice('windows');
    const db = getTestDb();
    await db.execute(sql`
      INSERT INTO device_disks (device_id, org_id, mount_point, fs_type, total_gb, used_gb, free_gb, used_percent)
      VALUES (${deviceId}, ${orgId}, 'C:\\', 'NTFS', 500, 400, 100, 80)
    `);
    await seedPreMigrationSnapshot(deviceId, orgId, 'D:\\');
    await seedLegacyScanState(deviceId, orgId, 'D:\\media');

    await replayMigration(MIGRATION);

    const state = await scanStateOf(deviceId);
    expect(state.scan_path).toBe('C:\\');
    expect(state.checkpoint).toEqual({});
    expect(state.aggregate).toEqual({});
    expect(state.hot_directories).toEqual([]);
    // Kept: a stale percent costs at most one baseline, and the completion
    // timestamp is what stops the tab reading as "never scanned".
    expect(state.last_baseline_completed_at).not.toBeNull();
    expect(state.last_disk_used_percent).toBe(71);
  });

  runDb('PASS B: a device with no snapshots at all falls back to the OS root with state cleared', async () => {
    const { deviceId, orgId } = await seedDevice('linux');
    await seedLegacyScanState(deviceId, orgId, '/data');

    await replayMigration(MIGRATION);

    const state = await scanStateOf(deviceId);
    expect(state.scan_path).toBe('/');
    expect(state.hot_directories).toEqual([]);
  });

  runDb('adds scan_generation, nullable and initially unset', async () => {
    const { deviceId, orgId } = await seedDevice('linux');
    await seedLegacyScanState(deviceId, orgId, '/data');

    await replayMigration(MIGRATION);

    expect((await scanStateOf(deviceId)).scan_generation).toBeNull();
  });

  runDb('replaces the single-column primary key with a UNIQUE INDEX over (device_id, scan_path)', async () => {
    // Amendment 16: a primary key needs the NOT NULL W03 owns, but the old
    // single-column key cannot stay — it permits one row per device.
    const db = getTestDb();
    const pk = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'public.device_filesystem_scan_state'::regclass AND contype = 'p'
    `)) as unknown as Array<{ n: number }>;
    expect(pk[0]!.n).toBe(0);

    const idx = (await db.execute(sql`
      SELECT i.relname AS name, ix.indisunique AS uniq,
             (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum)
               AS cols
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
       WHERE ix.indrelid = 'public.device_filesystem_scan_state'::regclass
         AND i.relname = 'device_filesystem_scan_state_device_path_uidx'
    `)) as unknown as Array<{ name: string; uniq: boolean; cols: string[] }>;
    expect(idx).toHaveLength(1);
    expect(idx[0]!.uniq).toBe(true);
    expect(idx[0]!.cols).toEqual(['device_id', 'scan_path']);
  });

  runDb('the unique index is a usable ON CONFLICT target', async () => {
    // What `upsertFilesystemScanState` does. Postgres infers a plain unique
    // index from the column list exactly as it would a constraint; if this
    // fails, every scan-state upsert raises 42P10 in production.
    const { deviceId, orgId } = await seedDevice('windows');
    const db = getTestDb();
    for (const mode of ['baseline', 'incremental']) {
      await db.execute(sql`
        INSERT INTO device_filesystem_scan_state (device_id, org_id, scan_path, last_run_mode)
        VALUES (${deviceId}, ${orgId}, 'D:\\', ${mode})
        ON CONFLICT (device_id, scan_path) DO UPDATE SET last_run_mode = EXCLUDED.last_run_mode
      `);
    }
    const rows = (await db.execute(sql`
      SELECT last_run_mode FROM device_filesystem_scan_state WHERE device_id = ${deviceId}
    `)) as unknown as Array<{ last_run_mode: string }>;
    expect(rows).toEqual([{ last_run_mode: 'incremental' }]);
  });

  runDb('does NOT leave the migration-local normalisation helper behind', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM pg_proc
       WHERE proname = 'breeze_w02_normalize_scan_path'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });

  runDb('lets one device hold independent state for two volumes', async () => {
    // The whole point of the key swap: this INSERT used to be a PK violation.
    const { deviceId, orgId } = await seedDevice('windows');
    const db = getTestDb();
    // `'C:\\'` in TS source emits the SQL literal `'C:\'`, which with
    // standard_conforming_strings is one backslash. Writing `'C:\'` here would
    // escape the closing quote and break the template.
    await db.execute(sql`
      INSERT INTO device_filesystem_scan_state (device_id, org_id, scan_path, last_run_mode)
      VALUES (${deviceId}, ${orgId}, 'C:\\', 'baseline')
    `);
    await db.execute(sql`
      INSERT INTO device_filesystem_scan_state (device_id, org_id, scan_path, last_run_mode)
      VALUES (${deviceId}, ${orgId}, 'D:\\', 'incremental')
    `);

    const rows = (await db.execute(sql`
      SELECT scan_path, last_run_mode FROM device_filesystem_scan_state
       WHERE device_id = ${deviceId} ORDER BY scan_path
    `)) as unknown as Array<{ scan_path: string; last_run_mode: string }>;
    expect(rows).toEqual([
      { scan_path: 'C:\\', last_run_mode: 'baseline' },
      { scan_path: 'D:\\', last_run_mode: 'incremental' },
    ]);
  });

  runDb('swaps the snapshot index and drops the old one', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'device_filesystem_snapshots'
    `)) as unknown as Array<{ indexname: string }>;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('idx_device_filesystem_snapshots_device_path_captured');
    expect(names).not.toContain('idx_device_filesystem_snapshots_device_captured');
  });

  runDb('enforces the cleanup-run kind CHECK and defaults it to files', async () => {
    const { deviceId, orgId } = await seedDevice('linux');
    const db = getTestDb();
    const inserted = (await db.execute(sql`
      INSERT INTO device_filesystem_cleanup_runs (device_id, org_id)
      VALUES (${deviceId}, ${orgId}) RETURNING kind, scan_path, command_id
    `)) as unknown as Array<{ kind: string; scan_path: string | null; command_id: string | null }>;
    expect(inserted[0]).toEqual({ kind: 'files', scan_path: null, command_id: null });

    await expect(db.execute(sql`
      INSERT INTO device_filesystem_cleanup_runs (device_id, org_id, kind)
      VALUES (${deviceId}, ${orgId}, 'registry')
    `)).rejects.toThrow(/device_filesystem_cleanup_runs_kind_chk/);
  });

  runDb('carries the running cleanup-run status label', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'filesystem_cleanup_run_status'
       ORDER BY e.enumsortorder
    `)) as unknown as Array<{ enumlabel: string }>;
    expect(rows.map((r) => r.enumlabel)).toEqual(['previewed', 'executed', 'failed', 'running']);
  });

  runDb('is a true no-op on re-apply', async () => {
    const { deviceId, orgId } = await seedDevice('windows');
    const db = getTestDb();
    const id = await seedPreMigrationSnapshotOrExisting(deviceId, orgId);

    await replayMigration(MIGRATION);
    const afterFirst = await scanPathOf(id);
    await replayMigration(MIGRATION);
    const afterSecond = await scanPathOf(id);

    expect(afterSecond).toBe(afterFirst);

    // Still exactly one unique index over (device_id, scan_path) and still no
    // primary key — the DROP CONSTRAINT IF EXISTS / CREATE UNIQUE INDEX IF NOT
    // EXISTS pair has to be a true no-op, not an index rebuild per replay.
    const idx = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_class i
        JOIN pg_index ix ON ix.indexrelid = i.oid
       WHERE ix.indrelid = 'public.device_filesystem_scan_state'::regclass
         AND i.relname = 'device_filesystem_scan_state_device_path_uidx'
    `)) as unknown as Array<{ n: number }>;
    expect(idx[0]!.n).toBe(1);

    const pk = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'public.device_filesystem_scan_state'::regclass AND contype = 'p'
    `)) as unknown as Array<{ n: number }>;
    expect(pk[0]!.n).toBe(0);
  });
});

/** A normal (already-migrated) insert — the replay must leave it untouched. */
async function seedPreMigrationSnapshotOrExisting(deviceId: string, orgId: string): Promise<string> {
  const rows = (await getTestDb().execute(sql`
    INSERT INTO device_filesystem_snapshots (device_id, org_id, scan_path, raw_payload)
    VALUES (${deviceId}, ${orgId}, 'D:\\', '{"path":"D:\\\\"}'::jsonb)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}
