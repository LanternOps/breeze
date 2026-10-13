/**
 * Backup snapshot key root schema (#7081 / #8731) against real Postgres:
 *
 *  - (key_layout, key_prefix) pair CHECKs on backup_snapshots,
 *    backup_snapshot_id_reservations and backup_snapshot_retirements;
 *  - the root is immutable on all three tables;
 *  - a snapshot row must carry its reservation's root (reserve-id trigger),
 *    and a reservation synthesized from a snapshot row copies its root;
 *  - an erasure fence records the deleted row's root;
 *  - re-applying the migration is a no-op.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupKeyPrefixSchema.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { setBackupErasureContext } from '../../services/backupErasureFence';
import {
  WRITE_IDENTITY,
  expectSqlState,
  orgContext,
  reservationRow,
  seedWriteTenant,
  type WriteTenant,
} from './backupWriteFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION = resolve(__dirname, '../../../migrations/2026-12-27-140000-backup-key-root.sql');
const P = 'msp/acme';

function sid(label: string): string {
  return `snapshot-20261227T140000Z-${createHash('sha256').update(label + randomUUID()).digest('hex').slice(0, 24)}`;
}

type Root = { layout: string; prefix: string | null };
const LEGACY: Root = { layout: 'legacy_flat', prefix: null };
const PREFIXED: Root = { layout: 'prefixed_flat', prefix: P };

async function insertSnapshot(t: WriteTenant, snapshotId: string, root: Root): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshots (id, org_id, job_id, device_id, config_id, snapshot_id, storage_identity, key_layout, key_prefix)
    VALUES (${id}, ${t.orgId}, ${t.jobId}, ${t.deviceId}, ${t.configId}, ${snapshotId}, ${WRITE_IDENTITY}, ${root.layout}, ${root.prefix})
  `);
  return id;
}

async function insertReservation(t: WriteTenant, snapshotId: string, root: Root): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshot_id_reservations
      (snapshot_id, org_id, device_id, config_id, storage_identity, source, state, current_job_id, key_layout, key_prefix)
    VALUES (${snapshotId}, ${t.orgId}, ${t.deviceId}, ${t.configId}, ${WRITE_IDENTITY}, 'server_minted', 'reserved', ${t.jobId},
            ${root.layout}, ${root.prefix})
  `);
}

async function insertRetirement(t: WriteTenant, snapshotId: string, root: Root): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshot_retirements (org_id, config_id, device_id, snapshot_id, storage_identity, reason, key_layout, key_prefix)
    VALUES (${t.orgId}, ${t.configId}, ${t.deviceId}, ${snapshotId}, ${WRITE_IDENTITY}, 'manual', ${root.layout}, ${root.prefix})
  `);
}

const INSERTERS = {
  backup_snapshots: insertSnapshot,
  backup_snapshot_id_reservations: insertReservation,
  backup_snapshot_retirements: insertRetirement,
} as const;
const TABLES = Object.keys(INSERTERS) as Array<keyof typeof INSERTERS>;

describe('backup snapshot key root schema', () => {
  describe.each(TABLES)('%s', (table) => {
    const insert = INSERTERS[table];

    runDb('(a) refuses prefixed_flat without a prefix', async () => {
      const t = await seedWriteTenant();
      expect(await expectSqlState(() => insert(t, sid('a'), { layout: 'prefixed_flat', prefix: null }))).toBe('23514');
    });

    runDb('(b) refuses legacy_flat with a prefix', async () => {
      const t = await seedWriteTenant();
      expect(await expectSqlState(() => insert(t, sid('b'), { layout: 'legacy_flat', prefix: 'x' }))).toBe('23514');
    });

    runDb('(c) accepts prefixed_flat with a prefix, and the legacy default', async () => {
      const t = await seedWriteTenant();
      expect(await expectSqlState(() => insert(t, sid('c'), PREFIXED))).toBeNull();
      expect(await expectSqlState(() => insert(t, sid('c-legacy'), LEGACY))).toBeNull();
    });

    runDb.each(['/x', 'x/', 'a//b', ''])('(d) refuses the malformed prefix %j', async (prefix) => {
      const t = await seedWriteTenant();
      expect(await expectSqlState(() => insert(t, sid('d'), { layout: 'prefixed_flat', prefix }))).toBe('23514');
    });

    runDb('(d) refuses a prefix over 256 characters', async () => {
      const t = await seedWriteTenant();
      expect(await expectSqlState(() => insert(t, sid('d-long'), { layout: 'prefixed_flat', prefix: 'a'.repeat(257) }))).toBe('23514');
    });

    runDb('(e) refuses an unknown layout', async () => {
      const t = await seedWriteTenant();
      expect(await expectSqlState(() => insert(t, sid('e'), { layout: 'nested_v2', prefix: null }))).toBe('23514');
    });

    runDb('(g) the root is immutable', async () => {
      const t = await seedWriteTenant();
      const id = sid('g');
      await insert(t, id, PREFIXED);
      const where = sql`snapshot_id = ${id}`;
      const tableSql = sql.identifier(table);
      expect(await expectSqlState(() =>
        getTestDb().execute(sql`UPDATE ${tableSql} SET key_prefix = 'other' WHERE ${where}`),
      )).toBe('23514');
      expect(await expectSqlState(() =>
        getTestDb().execute(sql`UPDATE ${tableSql} SET key_layout = 'legacy_flat', key_prefix = NULL WHERE ${where}`),
      )).toBe('23514');
      // Updating any other column is unaffected.
      expect(await expectSqlState(() =>
        getTestDb().execute(sql`UPDATE ${tableSql} SET storage_identity = storage_identity WHERE ${where}`),
      )).toBeNull();
    });
  });

  runDb('(h) a snapshot row must carry its reservation\'s root, as the app role', async () => {
    const t = await seedWriteTenant();
    const id = sid('h');
    await insertReservation(t, id, PREFIXED);

    const insertAsApp = (root: Root) => withDbAccessContext(orgContext(t.orgId), () =>
      db.execute(sql`
        INSERT INTO backup_snapshots (org_id, job_id, device_id, config_id, snapshot_id, storage_identity, key_layout, key_prefix)
        VALUES (${t.orgId}, ${t.jobId}, ${t.deviceId}, ${t.configId}, ${id}, ${WRITE_IDENTITY}, ${root.layout}, ${root.prefix})
      `),
    );

    const mismatch = await expectSqlState(() => insertAsApp(LEGACY));
    expect(mismatch).toBe('23505');
    expect(await expectSqlState(() => insertAsApp({ layout: 'prefixed_flat', prefix: 'msp/other' }))).toBe('23505');
    expect(await getTestDb().execute(sql`SELECT 1 FROM backup_snapshots WHERE snapshot_id = ${id}`)).toHaveLength(0);

    expect(await expectSqlState(() => insertAsApp(PREFIXED))).toBeNull();
    const rows = (await getTestDb().execute(sql`
      SELECT key_layout, key_prefix FROM backup_snapshots WHERE snapshot_id = ${id}
    `)) as unknown as Array<{ key_layout: string; key_prefix: string | null }>;
    expect(rows).toEqual([{ key_layout: 'prefixed_flat', key_prefix: P }]);
  });

  runDb('(h) the mismatch names the reservation key, like any other foreign claim', async () => {
    const t = await seedWriteTenant();
    const id = sid('h-constraint');
    await insertReservation(t, id, PREFIXED);
    let constraint: string | undefined;
    try {
      await insertSnapshot(t, id, LEGACY);
    } catch (err) {
      let cur: unknown = err;
      for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
        const name = (cur as { constraint_name?: unknown; constraint?: unknown }).constraint_name
          ?? (cur as { constraint?: unknown }).constraint;
        if (typeof name === 'string') { constraint = name; break; }
        cur = (cur as { cause?: unknown }).cause;
      }
    }
    expect(constraint).toBe('backup_snapshot_id_reservations_pkey');
  });

  runDb('(i) a reservation synthesized from a snapshot row copies its root', async () => {
    const t = await seedWriteTenant();
    const prefixedId = sid('i-prefixed');
    const legacyId = sid('i-legacy');
    const otherId = sid('i-other');
    await insertSnapshot(t, prefixedId, PREFIXED);
    await insertSnapshot(t, legacyId, LEGACY);
    // A layout readers refuse is still recorded (and refused) consistently.
    await insertSnapshot(t, otherId, { layout: 'device_scoped', prefix: null });
    expect(await reservationRow(otherId)).toMatchObject({ key_layout: 'device_scoped', key_prefix: null });

    expect(await reservationRow(prefixedId)).toMatchObject({
      source: 'legacy_published', key_layout: 'prefixed_flat', key_prefix: P,
    });
    expect(await reservationRow(legacyId)).toMatchObject({
      source: 'legacy_published', key_layout: 'legacy_flat', key_prefix: null,
    });
  });

  runDb('(j) an erasure fence records the deleted snapshot row\'s root', async () => {
    const t = await seedWriteTenant();
    const prefixedId = sid('j-prefixed');
    const legacyId = sid('j-legacy');
    await insertSnapshot(t, prefixedId, PREFIXED);
    await insertSnapshot(t, legacyId, LEGACY);

    await withSystemDbAccessContext(async () => {
      await setBackupErasureContext(t.orgId);
      await db.execute(sql`DELETE FROM backup_snapshots WHERE org_id = ${t.orgId}`);
    });

    const targets = (await getTestDb().execute(sql`
      SELECT snapshot_id, source, key_layout, key_prefix FROM backup_erasure_targets
       WHERE subject_org_id = ${t.orgId} AND kind = 'snapshot_prefix'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(2);
    expect(targets.find((r) => r.snapshot_id === prefixedId)).toMatchObject({
      source: 'snapshot', key_layout: 'prefixed_flat', key_prefix: P,
    });
    expect(targets.find((r) => r.snapshot_id === legacyId)).toMatchObject({
      source: 'snapshot', key_layout: 'legacy_flat', key_prefix: null,
    });
  });

  runDb('(j) an erasure fence records a deleted retirement\'s and reservation\'s root', async () => {
    const t = await seedWriteTenant();
    const retiredId = sid('j-retired');
    const reservedId = sid('j-reserved');
    await insertRetirement(t, retiredId, PREFIXED);
    await insertReservation(t, reservedId, PREFIXED);

    await withSystemDbAccessContext(async () => {
      await setBackupErasureContext(t.orgId);
      await db.execute(sql`DELETE FROM backup_snapshot_retirements WHERE org_id = ${t.orgId}`);
      await db.execute(sql`DELETE FROM backup_snapshot_id_reservations WHERE org_id = ${t.orgId}`);
    });

    const targets = (await getTestDb().execute(sql`
      SELECT snapshot_id, source, key_layout, key_prefix FROM backup_erasure_targets
       WHERE subject_org_id = ${t.orgId} AND kind = 'snapshot_prefix'
       ORDER BY source
    `)) as unknown as Array<Record<string, unknown>>;
    expect(targets).toEqual([
      { snapshot_id: reservedId, source: 'reservation', key_layout: 'prefixed_flat', key_prefix: P },
      { snapshot_id: retiredId, source: 'retirement', key_layout: 'prefixed_flat', key_prefix: P },
    ]);
  });

  runDb('(f) re-applying the migration is a no-op', async () => {
    const t = await seedWriteTenant();
    const id = sid('f');
    await insertReservation(t, id, PREFIXED);

    await getTestDb().execute(sql.raw(readFileSync(MIGRATION, 'utf8')));
    await getTestDb().execute(sql.raw(readFileSync(MIGRATION, 'utf8')));

    expect(await reservationRow(id)).toMatchObject({ key_layout: 'prefixed_flat', key_prefix: P });
    // The constraints and triggers are still in force after the re-run.
    expect(await expectSqlState(() => insertSnapshot(t, sid('f-bad'), { layout: 'prefixed_flat', prefix: null }))).toBe('23514');
    expect(await expectSqlState(() => insertSnapshot(t, id, LEGACY))).toBe('23505');
    const triggers = (await getTestDb().execute(sql`
      SELECT tgname FROM pg_trigger WHERE tgname LIKE '%key_root_immutable' AND NOT tgisinternal ORDER BY tgname
    `)) as unknown as Array<{ tgname: string }>;
    expect(triggers.map((r) => r.tgname)).toEqual([
      'backup_snapshot_id_reservations_key_root_immutable',
      'backup_snapshot_retirements_key_root_immutable',
      'backup_snapshots_key_root_immutable',
    ]);
  });
});
