/**
 * PAM ownership epochs W1 (#8203, feature #8202) — epoch lineage foundation.
 *
 * Spec: docs/superpowers/specs/pam/2026-10-06-pam-ownership-epoch-design.md §4.1, §4.2, §4.5.
 *
 * Pins, against real PostgreSQL:
 *   - every device carries `ownership_epoch` and a matching epoch row from
 *     insert (or from the backfill for pre-existing devices);
 *   - the three lineage tables are append-only and app-role write-proof;
 *   - an org change appends closure + next epoch + retirement markers in the
 *     same statement, and a refused / rolled-back change leaves nothing;
 *   - the advance trigger's elevated scope never leaks into the caller's
 *     transaction;
 *   - the generic device-move org_id restamp never touches lineage.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { getTestDb, getAppDb } from './setup';
import { createPartner, createOrganization, createSite, createDevice } from './db-utils';
import { replayMigration } from './replayMigration';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

const LINEAGE_TABLES = [
  'device_ownership_epochs',
  'device_ownership_epoch_closures',
  'pam_ledger_retirements',
] as const;

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
}

async function expectPgCode(op: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await op();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected PostgreSQL ${code}`).toBeDefined();
  expect(pgCode(caught)).toBe(code);
}

async function twoOrgs() {
  const partner = await createPartner();
  const a = await createOrganization({ partnerId: partner.id });
  const b = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: a.id });
  const siteB = await createSite({ orgId: b.id });
  return { partner, a, b, siteA, siteB };
}

async function epochsOf(deviceId: string) {
  return getTestDb().execute<{ epoch: number; org_id: string; site_id: string | null; cause: string }>(sql`
    SELECT epoch, org_id, site_id, cause FROM device_ownership_epochs
    WHERE device_id = ${deviceId} ORDER BY epoch`);
}

async function closuresOf(deviceId: string) {
  return getTestDb().execute<{
    epoch: number; org_id: string; hostname_snapshot: string | null;
    display_name_snapshot: string | null; site_id_snapshot: string | null;
  }>(sql`
    SELECT epoch, org_id, hostname_snapshot, display_name_snapshot, site_id_snapshot
    FROM device_ownership_epoch_closures WHERE device_id = ${deviceId} ORDER BY epoch`);
}

async function currentEpoch(deviceId: string): Promise<number> {
  const [d] = await getTestDb().execute<{ ownership_epoch: number }>(sql`
    SELECT ownership_epoch FROM devices WHERE id = ${deviceId}`);
  return d!.ownership_epoch;
}

async function lineageCounts(deviceId: string): Promise<Record<string, number>> {
  const [row] = await getTestDb().execute<Record<string, number>>(sql`
    SELECT
      (SELECT count(*)::int FROM device_ownership_epochs WHERE device_id = ${deviceId}) AS epochs,
      (SELECT count(*)::int FROM device_ownership_epoch_closures WHERE device_id = ${deviceId}) AS closures,
      (SELECT count(*)::int FROM pam_ledger_retirements WHERE device_id = ${deviceId}) AS retirements`);
  return row!;
}

async function moveDevice(deviceId: string, orgId: string, siteId: string, cause?: string): Promise<void> {
  await getTestDb().transaction(async (tx) => {
    if (cause !== undefined) {
      await tx.execute(sql`SELECT set_config('breeze.ownership_change_cause', ${cause}, true)`);
    }
    await tx.execute(sql`UPDATE devices SET org_id = ${orgId}, site_id = ${siteId} WHERE id = ${deviceId}`);
  });
}

/** Insert a device with every user trigger suppressed (no init epoch row). */
async function insertDeviceWithoutTriggers(orgId: string, siteId: string): Promise<string> {
  const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
        VALUES (${orgId}, ${siteId}, ${`agent-${randomUUID()}`}, ${`legacy-${randomUUID().slice(0, 8)}`},
                'windows', '11', 'amd64', '2.0.0')
        RETURNING id`;
      return row!.id;
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function seedPamActuation(orgId: string, siteId: string, partnerId: string, deviceId: string): Promise<string> {
  const [row] = await getTestDb().execute<{ id: string }>(sql`
    WITH request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username,
        reason, target_executable_path, target_executable_hash, status, approved_at
      ) VALUES (
        ${orgId}, ${siteId}, ${partnerId}, ${deviceId}, 'uac_intercept', 'fixture-user',
        'ownership epoch fixture', 'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)},
        'approved', now()
      ) RETURNING id
    )
    INSERT INTO pam_actuations (
      org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path, target_executable_hash, subject_username
    ) SELECT ${orgId}, ${deviceId}, request.id, 1, 1, 'cleanup', 'cleaned',
      'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)}, 'fixture-user'
    FROM request RETURNING id`);
  return row!.id;
}

describe('device ownership epochs — foundation', () => {
  it('every device has epoch 1 on insert with a matching epoch row', async () => {
    const { a, siteA } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    expect(await currentEpoch(device.id)).toBe(1);
    expect(await epochsOf(device.id)).toEqual([
      { epoch: 1, org_id: a.id, site_id: siteA.id, cause: 'enrollment' },
    ]);
  });

  it('an app-role device insert under org context gets its epoch row (no app INSERT grant needed)', async () => {
    const { a, siteA } = await twoOrgs();
    const deviceId = await getAppDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'organization', true),
                                  set_config('breeze.org_id', ${a.id}, true),
                                  set_config('breeze.accessible_org_ids', ${a.id}, true)`);
      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
        VALUES (${a.id}, ${siteA.id}, ${`agent-${randomUUID()}`}, 'app-enrolled', 'windows', '11', 'amd64', '2.0.0')
        RETURNING id`);
      // The init trigger's elevated scope must not leak into this transaction.
      const [scope] = await tx.execute<{ s: string }>(sql`SELECT current_setting('breeze.scope', true) AS s`);
      expect(scope!.s).toBe('organization');
      return row!.id;
    });
    expect(await epochsOf(deviceId)).toEqual([
      { epoch: 1, org_id: a.id, site_id: siteA.id, cause: 'enrollment' },
    ]);
  });

  it('epoch rows reject UPDATE (append-only)', async () => {
    const { a, siteA } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    await expectPgCode(() => getTestDb().execute(sql`
      UPDATE device_ownership_epochs SET cause = 'device_move' WHERE device_id = ${device.id}`), '42501');
  });

  it('caller-written ownership_epoch changes are rejected', async () => {
    const { a, siteA } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    await expectPgCode(
      () => getTestDb().execute(sql`UPDATE devices SET ownership_epoch = 7 WHERE id = ${device.id}`),
      '42501',
    );
    // Restating the same org does not license an epoch write either.
    await expectPgCode(
      () => getTestDb().execute(sql`UPDATE devices SET org_id = org_id, ownership_epoch = 7 WHERE id = ${device.id}`),
      '42501',
    );
    expect(await currentEpoch(device.id)).toBe(1);
  });

  it('the app role holds no INSERT/UPDATE/TRUNCATE on any lineage table', async () => {
    const rows = await getTestDb().execute<{ t: string; ins: boolean; upd: boolean; trunc: boolean; sel: boolean; del: boolean }>(sql`
      SELECT t,
             has_table_privilege('breeze_app', t, 'INSERT') AS ins,
             has_table_privilege('breeze_app', t, 'UPDATE') AS upd,
             has_table_privilege('breeze_app', t, 'TRUNCATE') AS trunc,
             has_table_privilege('breeze_app', t, 'SELECT') AS sel,
             has_table_privilege('breeze_app', t, 'DELETE') AS del
      FROM unnest(${sql.raw(`ARRAY['${LINEAGE_TABLES.join("','")}']`)}::text[]) AS t ORDER BY t`);
    for (const row of rows) {
      expect(row, row.t).toMatchObject({ ins: false, upd: false, trunc: false, sel: true, del: true });
    }
  });

  it('an app-role caller with org access cannot forge an epoch row', async () => {
    const { a, siteA } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    await expectPgCode(() => getAppDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'organization', true),
                                  set_config('breeze.accessible_org_ids', ${a.id}, true)`);
      await tx.execute(sql`
        INSERT INTO device_ownership_epochs (device_id, epoch, org_id, cause)
        VALUES (${device.id}, 2, ${a.id}, 'device_move')`);
    }), '42501');
  });

  it('the backfill gives a pre-existing device epoch 1 (cause backfill) and re-applies as a no-op', async () => {
    const { a, siteA } = await twoOrgs();
    const legacy = await insertDeviceWithoutTriggers(a.id, siteA.id);
    const enrolled = await createDevice({ orgId: a.id, siteId: siteA.id });
    expect(await epochsOf(legacy)).toEqual([]);

    await replayMigration('2026-12-17-130100-device-ownership-epochs-backfill.sql');
    expect(await epochsOf(legacy)).toEqual([
      { epoch: 1, org_id: a.id, site_id: siteA.id, cause: 'backfill' },
    ]);

    await replayMigration('2026-12-17-130000-device-ownership-epochs.sql');
    await replayMigration('2026-12-17-130100-device-ownership-epochs-backfill.sql');
    expect(await epochsOf(legacy)).toHaveLength(1);
    expect(await epochsOf(enrolled.id)).toEqual([
      { epoch: 1, org_id: a.id, site_id: siteA.id, cause: 'enrollment' },
    ]);
  });
});

describe('device ownership epochs — advance on org change', () => {
  it('org change appends a closure, a new epoch, and keeps the caller cause', async () => {
    const { a, b, siteA, siteB } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id, hostname: 'host-a' });
    await getTestDb().execute(sql`UPDATE devices SET display_name = 'Front desk' WHERE id = ${device.id}`);

    await moveDevice(device.id, b.id, siteB.id, 'device_move');

    expect(await currentEpoch(device.id)).toBe(2);
    expect(await epochsOf(device.id)).toEqual([
      { epoch: 1, org_id: a.id, site_id: siteA.id, cause: 'enrollment' },
      { epoch: 2, org_id: b.id, site_id: siteB.id, cause: 'device_move' },
    ]);
    expect(await closuresOf(device.id)).toEqual([
      { epoch: 1, org_id: a.id, hostname_snapshot: 'host-a', display_name_snapshot: 'Front desk', site_id_snapshot: siteA.id },
    ]);
    // No PAM history → no retirement markers.
    expect((await lineageCounts(device.id)).retirements).toBe(0);
  });

  it('records cause unspecified when the GUC is unset or not an ownership cause', async () => {
    const { a, b, siteA, siteB } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    await moveDevice(device.id, b.id, siteB.id);
    await moveDevice(device.id, a.id, siteA.id, 'enrollment');
    expect((await epochsOf(device.id)).map((e) => e.cause)).toEqual(['enrollment', 'unspecified', 'unspecified']);
  });

  it('A → B → A produces three epochs, epoch 3 in A, and two closures', async () => {
    const { a, b, siteA, siteB } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    await moveDevice(device.id, b.id, siteB.id, 'device_move');
    await moveDevice(device.id, a.id, siteA.id, 'org_merge');

    expect(await currentEpoch(device.id)).toBe(3);
    expect((await epochsOf(device.id)).map(({ epoch, org_id, cause }) => ({ epoch, org_id, cause }))).toEqual([
      { epoch: 1, org_id: a.id, cause: 'enrollment' },
      { epoch: 2, org_id: b.id, cause: 'device_move' },
      { epoch: 3, org_id: a.id, cause: 'org_merge' },
    ]);
    expect((await closuresOf(device.id)).map(({ epoch, org_id }) => ({ epoch, org_id }))).toEqual([
      { epoch: 1, org_id: a.id },
      { epoch: 2, org_id: b.id },
    ]);
  });

  it('a site-only change does not advance the epoch', async () => {
    const { a, siteA } = await twoOrgs();
    const siteA2 = await createSite({ orgId: a.id });
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    await getTestDb().execute(sql`UPDATE devices SET site_id = ${siteA2.id} WHERE id = ${device.id}`);
    // Restating the org (UPDATE OF org_id fires the trigger) is also a no-op.
    await getTestDb().execute(sql`UPDATE devices SET org_id = ${a.id}, hostname = 'renamed' WHERE id = ${device.id}`);
    expect(await currentEpoch(device.id)).toBe(1);
    expect(await lineageCounts(device.id)).toEqual({ epochs: 1, closures: 0, retirements: 0 });
  });

  it('a caller-supplied ownership_epoch alongside an org change is overridden to exactly +1', async () => {
    const { a, b, siteA, siteB } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    await getTestDb().execute(sql`
      UPDATE devices SET org_id = ${b.id}, site_id = ${siteB.id}, ownership_epoch = 99 WHERE id = ${device.id}`);
    expect(await currentEpoch(device.id)).toBe(2);
    expect((await epochsOf(device.id)).map((e) => e.epoch)).toEqual([1, 2]);
  });

  it('rolled-back org change leaves no epoch or closure rows', async () => {
    const { a, b, siteA, siteB } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      await client`BEGIN`;
      await client`UPDATE devices SET org_id = ${b.id}, site_id = ${siteB.id} WHERE id = ${device.id}`;
      const [inside] = await client<{ n: number }[]>`
        SELECT count(*)::int AS n FROM device_ownership_epochs WHERE device_id = ${device.id}`;
      expect(inside!.n).toBe(2);
      await client`ROLLBACK`;
    } finally {
      await client.end({ timeout: 1 });
    }
    expect(await currentEpoch(device.id)).toBe(1);
    expect(await lineageCounts(device.id)).toEqual({ epochs: 1, closures: 0, retirements: 0 });
  });

  it('a move refused by the PAM history guard writes no lineage rows', async () => {
    const { partner, a, b, siteA, siteB } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    await seedPamActuation(a.id, siteA.id, partner.id, device.id);
    const before = await lineageCounts(device.id);

    await expectPgCode(() => moveDevice(device.id, b.id, siteB.id, 'device_move'), '23514');

    expect(await currentEpoch(device.id)).toBe(1);
    expect(await lineageCounts(device.id)).toEqual(before);
    expect(before).toEqual({ epochs: 1, closures: 0, retirements: 0 });
  });

  it('an app-role mover writes closure, epoch and one retirement marker per source actuation, without scope leak', async () => {
    // Retirement markers only arise once PAM-touched devices may move (W6).
    // Until then the history guard refuses such a move, so this test lifts the
    // guard inside one rolled-back transaction to exercise the trigger body.
    const { partner, a, b, siteA, siteB } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    const act1 = await seedPamActuation(a.id, siteA.id, partner.id, device.id);
    const act2 = await seedPamActuation(a.id, siteA.id, partner.id, device.id);
    // Decoy: another device's actuation in the same source org must not be retired.
    const otherDevice = await createDevice({ orgId: a.id, siteId: siteA.id });
    await seedPamActuation(a.id, siteA.id, partner.id, otherDevice.id);

    const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const ROLLBACK = new Error('rollback sentinel');
    let observed: {
      scopeAfter: string; appSeesRetirements: number;
      retirements: { actuation_id: string; retired_epoch: number }[];
      epochs: { epoch: number; org_id: string }[];
      closures: number;
    } | undefined;
    try {
      await client.begin(async (tx) => {
        await tx`ALTER TABLE devices DISABLE TRIGGER devices_pam_history_move_guard`;
        await tx`SET LOCAL ROLE breeze_app`;
        await tx`SELECT set_config('breeze.scope', 'organization', true),
                        set_config('breeze.accessible_org_ids', ${`${a.id},${b.id}`}, true),
                        set_config('breeze.ownership_change_cause', 'device_move', true)`;
        await tx`UPDATE devices SET org_id = ${b.id}, site_id = ${siteB.id} WHERE id = ${device.id}`;
        const [scope] = await tx<{ s: string }[]>`SELECT current_setting('breeze.scope', true) AS s`;
        // System-only table: invisible to the app role even though the trigger wrote it.
        const [seen] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pam_ledger_retirements`;
        await tx`RESET ROLE`;
        const retirements = await tx<{ actuation_id: string; retired_epoch: number }[]>`
          SELECT actuation_id, retired_epoch FROM pam_ledger_retirements
          WHERE device_id = ${device.id} ORDER BY actuation_id`;
        const epochs = await tx<{ epoch: number; org_id: string }[]>`
          SELECT epoch, org_id FROM device_ownership_epochs WHERE device_id = ${device.id} ORDER BY epoch`;
        const [closures] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM device_ownership_epoch_closures WHERE device_id = ${device.id}`;
        observed = {
          scopeAfter: scope!.s,
          appSeesRetirements: seen!.n,
          retirements: [...retirements],
          epochs: [...epochs],
          closures: closures!.n,
        };
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    } finally {
      await client.end({ timeout: 1 });
    }

    expect(observed).toEqual({
      scopeAfter: 'organization',
      appSeesRetirements: 0,
      retirements: [act1, act2].sort().map((id) => ({ actuation_id: id, retired_epoch: 1 })),
      epochs: [{ epoch: 1, org_id: a.id }, { epoch: 2, org_id: b.id }],
      closures: 1,
    });
    // Rolled back: the guard is back and nothing persisted.
    expect(await lineageCounts(device.id)).toEqual({ epochs: 1, closures: 0, retirements: 0 });
  });

  it('a device missing its epoch-1 row (trigger-suppressed insert) still moves, and its lineage is healed', async () => {
    const { a, b, siteA, siteB } = await twoOrgs();
    const legacy = await insertDeviceWithoutTriggers(a.id, siteA.id);
    await moveDevice(legacy, b.id, siteB.id, 'device_move');
    expect(await epochsOf(legacy)).toEqual([
      { epoch: 1, org_id: a.id, site_id: siteA.id, cause: 'backfill' },
      { epoch: 2, org_id: b.id, site_id: siteB.id, cause: 'device_move' },
    ]);
    expect((await closuresOf(legacy)).map((c) => c.epoch)).toEqual([1]);
  });

  it('the generic device-move org_id restamp excludes exactly the source-frozen tables, lineage included', async () => {
    // Pins the FULL exclusion set, not just the new names: this migration
    // redefines breeze_device_child_orgid_tables(), and a body copied from a
    // stale definition silently drops earlier exclusions.
    const rows = await getTestDb().execute<{ t: string }>(sql`SELECT public.breeze_device_child_orgid_tables() AS t`);
    const discovered = new Set(rows.map((r) => r.t));
    const candidates = await getTestDb().execute<{ t: string }>(sql`
      SELECT c.relname::text AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'devices'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'device_id'
                      AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype)
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id'
                      AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype)`);
    const excluded = candidates.map((r) => r.t).filter((t) => !discovered.has(t)).sort();
    expect(excluded).toEqual([
      'ai_agent_runs',
      'ai_operator_task_targets',
      'ai_operator_tasks',
      'device_ownership_epoch_closures',
      'device_ownership_epochs',
      'fix_outcomes',
      'invoice_line_devices',
      'offline_transition_effects',
      'pam_actuation_results',
      'pam_actuations',
    ]);
    // Sanity: discovery still works for an ordinary device child.
    expect(discovered.has('device_group_memberships')).toBe(true);
  });

  it('a departing epoch row recorded under a DIFFERENT org fails the move loudly and writes nothing', async () => {
    const { a, b, siteA, siteB } = await twoOrgs();
    const legacy = await insertDeviceWithoutTriggers(a.id, siteA.id);
    // Corrupt lineage: epoch 1 claims org B while the device is in org A.
    await getTestDb().execute(sql`
      INSERT INTO device_ownership_epochs (device_id, epoch, org_id, site_id, cause)
      VALUES (${legacy}, 1, ${b.id}, ${siteB.id}, 'backfill')`);

    await expectPgCode(() => moveDevice(legacy, b.id, siteB.id, 'device_move'), '23503');

    expect(await currentEpoch(legacy)).toBe(1);
    expect(await lineageCounts(legacy)).toEqual({ epochs: 1, closures: 0, retirements: 0 });
  });

  it('closures and epochs are visible only to the org that owned the epoch', async () => {
    const { a, b, siteA, siteB } = await twoOrgs();
    const device = await createDevice({ orgId: a.id, siteId: siteA.id });
    await moveDevice(device.id, b.id, siteB.id, 'device_move');
    const asOrg = (orgId: string) => getAppDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'organization', true),
                                  set_config('breeze.accessible_org_ids', ${orgId}, true)`);
      const epochs = await tx.execute<{ epoch: number }>(sql`
        SELECT epoch FROM device_ownership_epochs WHERE device_id = ${device.id} ORDER BY epoch`);
      const closures = await tx.execute<{ epoch: number }>(sql`
        SELECT epoch FROM device_ownership_epoch_closures WHERE device_id = ${device.id} ORDER BY epoch`);
      return { epochs: epochs.map((r) => r.epoch), closures: closures.map((r) => r.epoch) };
    });
    expect(await asOrg(a.id)).toEqual({ epochs: [1], closures: [1] });
    expect(await asOrg(b.id)).toEqual({ epochs: [2], closures: [] });
  });
});
