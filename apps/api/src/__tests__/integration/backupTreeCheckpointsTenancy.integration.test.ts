/**
 * Tenancy contract for the snapshot file index checkpoint tables (#11736 step 2, W2).
 *
 * `backup_tree_checkpoints` is RLS shape 1 (direct org_id). `backup_tree_checkpoint_entries`
 * is parent-join through its header. A `delta` snapshot names its checkpoint through the
 * composite FK (file_index_checkpoint_id, org_id, device_id), so it can only ever reference,
 * and pin, a checkpoint of its own org and device. The catalog contract tests cannot see a
 * cross-tenant row, so the forged references are tested here directly.
 *
 * On a device org move the checkpoint is deleted (it names a source-org backup config) and
 * the moved `delta` snapshots fall back to `rows` with no rows, so they re-hydrate. The
 * tenancy trigger on backup_snapshots does that reset; these cases run the moves as
 * breeze_app in a request context, not on the admin connection.
 *
 * Nothing writes these tables yet; every row here is seeded by the test.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { FOREIGN_KEY_VIOLATION_SQLSTATES, isPgForeignKeyViolation } from '@breeze/shared/pgErrors';
import { closeDb, db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { backupConfigs, backupJobs } from '../../db/schema';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { executeOrgMerge } from '../../services/orgMerge';

afterAll(() => closeDb());

const PERFORMED_BY = '00000000-0000-0000-0000-0000000000ab';

const admin = <T extends Record<string, unknown>>(query: SQL) =>
  getTestDb().execute(query) as unknown as Promise<T[]>;

const orgContext = (orgId: string): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null,
});
const partnerContext = (partnerId: string, orgIds: string[]): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null,
});

/** Run `query` and return the error it raised, or fail if it succeeded. */
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error('expected the statement to be refused, but it succeeded');
}

function sqlstate(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; cur && typeof cur === 'object' && i < 5; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && typeof cur === 'object' && i < 5; i++) {
    parts.push(String((cur as { message?: unknown }).message ?? ''));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

async function makeConfig(orgId: string): Promise<string> {
  const [cfg] = await getTestDb().insert(backupConfigs).values({
    orgId,
    name: `ckpt-${randomUUID().slice(0, 8)}`,
    type: 'file',
    provider: 'local',
    providerConfig: { path: '/tmp/breeze-11736-ckpt' },
  }).returning({ id: backupConfigs.id });
  return cfg!.id;
}

async function makeJob(orgId: string, configId: string, deviceId: string): Promise<string> {
  const [job] = await getTestDb().insert(backupJobs).values({
    orgId, configId, deviceId, status: 'completed',
  } as never).returning({ id: backupJobs.id });
  return job!.id;
}

async function makeHeader(orgId: string, deviceId: string, configId: string, entries = 3): Promise<string> {
  const [row] = await admin<{ id: string }>(sql`
    INSERT INTO backup_tree_checkpoints
      (org_id, device_id, config_id, storage_identity, backup_type, key_layout, entry_count, source_manifest_sha256)
    VALUES (${orgId}::uuid, ${deviceId}::uuid, ${configId}::uuid, 'local:/tmp/breeze-11736-ckpt', 'file',
            'legacy_flat', ${entries}, ${'a'.repeat(64)})
    RETURNING id`);
  for (let n = 1; n <= entries; n++) {
    await admin(sql`
      INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path, size)
      VALUES (${row!.id}::uuid, ${n}, ${`/data/file-${n}`}, ${`snapshots/base/files/data/file-${n}`}, ${n * 10})`);
  }
  return row!.id;
}

async function makeSnapshot(opts: {
  orgId: string;
  deviceId: string;
  configId: string;
  checkpointId?: string | null;
  status?: string;
}): Promise<string> {
  const jobId = await makeJob(opts.orgId, opts.configId, opts.deviceId);
  const format = opts.checkpointId ? 'delta' : 'rows';
  const [row] = await admin<{ id: string }>(sql`
    INSERT INTO backup_snapshots
      (org_id, job_id, device_id, config_id, snapshot_id, storage_identity, backup_type,
       file_index_status, file_index_format, file_index_checkpoint_id)
    VALUES (${opts.orgId}::uuid, ${jobId}::uuid, ${opts.deviceId}::uuid, ${opts.configId}::uuid,
            ${`snap-${randomUUID()}`}, 'local:/tmp/breeze-11736-ckpt', 'file',
            ${opts.status ?? 'complete'}, ${format}, ${opts.checkpointId ?? null}::uuid)
    RETURNING id`);
  return row!.id;
}

/** One add and one tombstone (of checkpoint entry 2), the shape a delta publish writes. */
async function addDeltaRows(snapshotDbId: string): Promise<void> {
  await admin(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size, checkpoint_entry_no)
    VALUES (${snapshotDbId}::uuid, '/data/new', 'snapshots/next/files/data/new', 5, NULL),
           (${snapshotDbId}::uuid, '/data/file-2', '', NULL, 2)`);
}

async function addRows(snapshotDbId: string): Promise<void> {
  await admin(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path, size)
    VALUES (${snapshotDbId}::uuid, '/data/a', 'snapshots/x/files/data/a', 1),
           (${snapshotDbId}::uuid, '/data/b', 'snapshots/x/files/data/b', 2)`);
}

async function snapshotState(snapshotDbId: string) {
  const [row] = await admin<{
    org_id: string; device_id: string; file_index_format: string;
    file_index_checkpoint_id: string | null; file_index_status: string; files: number;
  }>(sql`
    SELECT s.org_id, s.device_id, s.file_index_format, s.file_index_checkpoint_id, s.file_index_status,
           (SELECT count(*)::int FROM backup_snapshot_files f WHERE f.snapshot_db_id = s.id) AS files
      FROM backup_snapshots s WHERE s.id = ${snapshotDbId}::uuid`);
  return row!;
}

async function headersOf(deviceId: string) {
  return admin<{ id: string; org_id: string }>(sql`
    SELECT id, org_id FROM backup_tree_checkpoints WHERE device_id = ${deviceId}::uuid ORDER BY created_at`);
}

async function entryCount(checkpointId: string): Promise<number> {
  const [row] = await admin<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM backup_tree_checkpoint_entries WHERE checkpoint_id = ${checkpointId}::uuid`);
  return row!.n;
}

async function tenant() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const deviceA = (await createDevice({ orgId: orgA.id, siteId: siteA.id })).id;
  const deviceA2 = (await createDevice({ orgId: orgA.id, siteId: siteA.id })).id;
  const deviceB = (await createDevice({ orgId: orgB.id, siteId: siteB.id })).id;
  const configA = await makeConfig(orgA.id);
  const configB = await makeConfig(orgB.id);
  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, siteA: siteA.id, siteB: siteB.id,
    deviceA, deviceA2, deviceB, configA, configB,
  };
}

describe('backup_tree_checkpoints: tables, RLS and references (W2 Task 1)', () => {
  it('an org-scoped caller sees only its own checkpoints and their entries', async () => {
    const t = await tenant();
    const headerA = await makeHeader(t.orgA, t.deviceA, t.configA);
    const headerB = await makeHeader(t.orgB, t.deviceB, t.configB);

    const seen = await withDbAccessContext(orgContext(t.orgA), async () => ({
      headers: await db.execute<{ id: string }>(sql`
        SELECT id FROM backup_tree_checkpoints WHERE id IN (${headerA}::uuid, ${headerB}::uuid)`),
      entries: await db.execute<{ checkpoint_id: string }>(sql`
        SELECT DISTINCT checkpoint_id FROM backup_tree_checkpoint_entries
         WHERE checkpoint_id IN (${headerA}::uuid, ${headerB}::uuid)`),
    }));
    expect(seen.headers.map((r) => r.id)).toEqual([headerA]);
    expect(seen.entries.map((r) => r.checkpoint_id)).toEqual([headerA]);
  });

  it('breeze_app cannot insert a checkpoint or an entry under another org', async () => {
    const t = await tenant();
    const headerB = await makeHeader(t.orgB, t.deviceB, t.configB);

    const forgedHeader = await refusal(() => withDbAccessContext(orgContext(t.orgA), () => db.execute(sql`
      INSERT INTO backup_tree_checkpoints
        (org_id, device_id, config_id, storage_identity, backup_type, key_layout, entry_count, source_manifest_sha256)
      VALUES (${t.orgB}::uuid, ${t.deviceB}::uuid, ${t.configB}::uuid, 'local:x', 'file', 'legacy_flat', 0, 'x')`)));
    expect(sqlstate(forgedHeader), errorText(forgedHeader)).toBe('42501');
    expect(errorText(forgedHeader)).toMatch(/row-level security/i);

    const forgedEntry = await refusal(() => withDbAccessContext(orgContext(t.orgA), () => db.execute(sql`
      INSERT INTO backup_tree_checkpoint_entries (checkpoint_id, entry_no, source_path, backup_path)
      VALUES (${headerB}::uuid, 99, '/forged', 'snapshots/forged')`)));
    expect(sqlstate(forgedEntry), errorText(forgedEntry)).toBe('42501');
    expect(errorText(forgedEntry)).toMatch(/row-level security/i);
    expect(await entryCount(headerB)).toBe(3);
  });

  it('a snapshot cannot point at a missing checkpoint', async () => {
    const t = await tenant();
    const snap = await makeSnapshot({ orgId: t.orgA, deviceId: t.deviceA, configId: t.configA });
    const err = await refusal(() => admin(sql`
      UPDATE backup_snapshots SET file_index_format = 'delta', file_index_checkpoint_id = ${randomUUID()}::uuid
       WHERE id = ${snap}::uuid`));
    expect(isPgForeignKeyViolation(err, 'backup_snapshots_file_index_checkpoint_fk'), errorText(err)).toBe(true);
  });

  it('a referenced checkpoint cannot be deleted', async () => {
    const t = await tenant();
    const header = await makeHeader(t.orgA, t.deviceA, t.configA);
    await makeSnapshot({ orgId: t.orgA, deviceId: t.deviceA, configId: t.configA, checkpointId: header });
    const err = await refusal(() => admin(sql`DELETE FROM backup_tree_checkpoints WHERE id = ${header}::uuid`));
    expect(FOREIGN_KEY_VIOLATION_SQLSTATES).toContain(sqlstate(err));
    expect(isPgForeignKeyViolation(err, 'backup_snapshots_file_index_checkpoint_fk'), errorText(err)).toBe(true);
    expect(await entryCount(header)).toBe(3);
  });

  it('format and pointer agree', async () => {
    const t = await tenant();
    const header = await makeHeader(t.orgA, t.deviceA, t.configA);
    const rowsSnap = await makeSnapshot({ orgId: t.orgA, deviceId: t.deviceA, configId: t.configA });
    const deltaWithoutPointer = await refusal(() => admin(sql`
      UPDATE backup_snapshots SET file_index_format = 'delta' WHERE id = ${rowsSnap}::uuid`));
    expect(sqlstate(deltaWithoutPointer)).toBe('23514');
    expect(errorText(deltaWithoutPointer)).toMatch(/backup_snapshots_file_index_checkpoint_chk/);

    const rowsWithPointer = await refusal(() => admin(sql`
      UPDATE backup_snapshots SET file_index_checkpoint_id = ${header}::uuid WHERE id = ${rowsSnap}::uuid`));
    expect(sqlstate(rowsWithPointer)).toBe('23514');
    expect(errorText(rowsWithPointer)).toMatch(/backup_snapshots_file_index_checkpoint_chk/);

    const unknownFormat = await refusal(() => admin(sql`
      UPDATE backup_snapshots SET file_index_format = 'tree' WHERE id = ${rowsSnap}::uuid`));
    expect(sqlstate(unknownFormat)).toBe('23514');
    expect(errorText(unknownFormat)).toMatch(/backup_snapshots_file_index_format_chk/);
  });

  it('deleting a config deletes its unreferenced checkpoints and their entries', async () => {
    const t = await tenant();
    const spareConfig = await makeConfig(t.orgA);
    const header = await makeHeader(t.orgA, t.deviceA, spareConfig);
    await admin(sql`DELETE FROM backup_configs WHERE id = ${spareConfig}::uuid`);
    expect(await headersOf(t.deviceA)).toEqual([]);
    expect(await entryCount(header)).toBe(0);
  });

  it("a checkpoint cannot name another org's backup config", async () => {
    const t = await tenant();
    const err = await refusal(() => makeHeader(t.orgA, t.deviceA, t.configB, 0));
    expect(isPgForeignKeyViolation(err, 'backup_tree_checkpoints_config_org_fk'), errorText(err)).toBe(true);
  });

  it('both composite FKs are validated, DEFERRABLE INITIALLY IMMEDIATE, with the intended delete action', async () => {
    const rows = await admin<{
      conname: string; condeferrable: boolean; condeferred: boolean; convalidated: boolean; confdeltype: string;
    }>(sql`
      SELECT conname, condeferrable, condeferred, convalidated, confdeltype FROM pg_constraint
       WHERE conname IN ('backup_snapshots_file_index_checkpoint_fk', 'backup_tree_checkpoints_config_org_fk')
       ORDER BY conname`);
    expect(rows).toEqual([
      // 'r' = RESTRICT: never deferred, so a referenced checkpoint is never deleted, even under deferral.
      { conname: 'backup_snapshots_file_index_checkpoint_fk', condeferrable: true, condeferred: false, convalidated: true, confdeltype: 'r' },
      { conname: 'backup_tree_checkpoints_config_org_fk', condeferrable: true, condeferred: false, convalidated: true, confdeltype: 'c' },
    ]);
  });

  it("a snapshot cannot point at another org's or another device's checkpoint", async () => {
    const t = await tenant();
    const headerB = await makeHeader(t.orgB, t.deviceB, t.configB);
    const headerA2 = await makeHeader(t.orgA, t.deviceA2, t.configA);
    const snap = await makeSnapshot({ orgId: t.orgA, deviceId: t.deviceA, configId: t.configA });

    for (const forged of [headerB, headerA2]) {
      const err = await refusal(() => admin(sql`
        UPDATE backup_snapshots SET file_index_format = 'delta', file_index_checkpoint_id = ${forged}::uuid
         WHERE id = ${snap}::uuid`));
      expect(isPgForeignKeyViolation(err, 'backup_snapshots_file_index_checkpoint_fk'), errorText(err)).toBe(true);
    }
    expect((await snapshotState(snap)).file_index_checkpoint_id).toBeNull();
  });
});

describe('backup_tree_checkpoints: move and merge coherence (W2 Task 1b)', () => {
  async function moveSnapshotOrg(t: Awaited<ReturnType<typeof tenant>>, snapshotDbId: string) {
    await withDbAccessContext(partnerContext(t.partnerId, [t.orgA, t.orgB]), () => db.execute(sql`
      UPDATE backup_snapshots SET org_id = ${t.orgB}::uuid WHERE id = ${snapshotDbId}::uuid`));
  }

  it("moving a delta snapshot's org resets it to rows, clears its status and drops its delta rows", async () => {
    const t = await tenant();
    const header = await makeHeader(t.orgA, t.deviceA, t.configA);
    const snap = await makeSnapshot({ orgId: t.orgA, deviceId: t.deviceA, configId: t.configA, checkpointId: header });
    await addDeltaRows(snap);

    await moveSnapshotOrg(t, snap);

    expect(await snapshotState(snap)).toMatchObject({
      org_id: t.orgB, file_index_format: 'rows', file_index_checkpoint_id: null, file_index_status: 'none', files: 0,
    });
    // The header itself is not touched by the snapshot's reset.
    expect(await entryCount(header)).toBe(3);
  });

  it("moving a failed delta snapshot's org resets it the same way", async () => {
    const t = await tenant();
    const header = await makeHeader(t.orgA, t.deviceA, t.configA);
    const snap = await makeSnapshot({
      orgId: t.orgA, deviceId: t.deviceA, configId: t.configA, checkpointId: header, status: 'failed',
    });
    await addDeltaRows(snap);

    await moveSnapshotOrg(t, snap);

    expect(await snapshotState(snap)).toMatchObject({
      file_index_format: 'rows', file_index_checkpoint_id: null, file_index_status: 'none', files: 0,
    });
  });

  it("changing only a delta snapshot's device resets it too", async () => {
    const t = await tenant();
    const header = await makeHeader(t.orgA, t.deviceA, t.configA);
    const snap = await makeSnapshot({ orgId: t.orgA, deviceId: t.deviceA, configId: t.configA, checkpointId: header });
    await addDeltaRows(snap);

    await withDbAccessContext(orgContext(t.orgA), () => db.execute(sql`
      UPDATE backup_snapshots SET device_id = ${t.deviceA2}::uuid WHERE id = ${snap}::uuid`));

    expect(await snapshotState(snap)).toMatchObject({
      device_id: t.deviceA2, file_index_format: 'rows', file_index_checkpoint_id: null, file_index_status: 'none', files: 0,
    });
  });

  it('moving a rows snapshot keeps its rows', async () => {
    const t = await tenant();
    const snap = await makeSnapshot({ orgId: t.orgA, deviceId: t.deviceA, configId: t.configA, status: 'agent' });
    await addRows(snap);

    await moveSnapshotOrg(t, snap);

    expect(await snapshotState(snap)).toMatchObject({
      org_id: t.orgB, file_index_format: 'rows', file_index_checkpoint_id: null, file_index_status: 'agent', files: 2,
    });
  });

  it('an update that changes neither org nor device leaves a delta snapshot alone', async () => {
    const t = await tenant();
    const header = await makeHeader(t.orgA, t.deviceA, t.configA);
    const snap = await makeSnapshot({ orgId: t.orgA, deviceId: t.deviceA, configId: t.configA, checkpointId: header });
    await addDeltaRows(snap);

    await withDbAccessContext(orgContext(t.orgA), () => db.execute(sql`
      UPDATE backup_snapshots SET label = 'relabelled', org_id = ${t.orgA}::uuid WHERE id = ${snap}::uuid`));

    expect(await snapshotState(snap)).toMatchObject({
      file_index_format: 'delta', file_index_checkpoint_id: header, file_index_status: 'complete', files: 2,
    });
  });

  it('the tenancy reset runs as a SECURITY DEFINER with a pinned search_path', async () => {
    const [fn] = await admin<{ prosecdef: boolean; proconfig: string[] | null }>(sql`
      SELECT p.prosecdef, p.proconfig FROM pg_proc p
       WHERE p.oid = 'public.breeze_backup_snapshot_file_index_tenancy_reset()'::regprocedure`);
    expect(fn!.prosecdef).toBe(true);
    expect(fn!.proconfig ?? []).toContainEqual(expect.stringMatching(/^search_path=/));
  });

  it('backup_tree_checkpoints is not in breeze_device_child_orgid_tables()', async () => {
    const rows = await admin<{ t: string }>(sql`SELECT public.breeze_device_child_orgid_tables() AS t`);
    const tables = rows.map((r) => r.t);
    expect(tables).toContain('backup_snapshots');
    expect(tables).not.toContain('backup_tree_checkpoints');
  });
});

describe('backup index changes (W2 Task 2)', () => {
  it('the duplicate snapshot index is gone and the checkpoint pointer is indexed', async () => {
    const rows = await admin<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('backup_snapshot_files_snapshot_idx', 'backup_snapshot_files_snapshot_source_idx',
                           'backup_snapshots_file_index_checkpoint_idx')
       ORDER BY indexname`);
    expect(rows.map((r) => r.indexname)).toEqual([
      'backup_snapshot_files_snapshot_source_idx',
      'backup_snapshots_file_index_checkpoint_idx',
    ]);
  });
});
