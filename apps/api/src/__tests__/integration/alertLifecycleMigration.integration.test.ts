/**
 * Alert re-arm lifecycle W2 (feature #10765, wave #10767; plan Task 11):
 * real-DB proof of the lifecycle-defaults migration.
 *
 * - partners get NOT NULL defaults equal to the old monitor defaults;
 * - organizations get the same four columns, nullable (NULL = inherit);
 * - monitor_definitions.cooldown_minutes / auto_resolve lose NOT NULL and
 *   DEFAULT, and the backfill nulls only the old default values (OD9);
 * - the re-arm pair CHECKs reject `after_delay` without minutes (23514).
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { replayMigration } from './replayMigration';

const FILE = '2027-01-21-110000-alert-lifecycle-defaults.sql';

type Row = Record<string, unknown>;

async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  return await getTestDb().execute(query) as unknown as T[];
}

async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
  return undefined;
}

async function insertMonitor(orgId: string, cooldown: number, autoResolve: boolean): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`
    INSERT INTO monitor_definitions (org_id, name, kind, condition, severity, cooldown_minutes, auto_resolve)
    VALUES (${orgId}::uuid, ${`m-${cooldown}-${autoResolve}`}, 'cpu', '{"threshold":90}'::jsonb, 'high', ${cooldown}, ${autoResolve})
    RETURNING id`);
  return row!.id;
}

describe('alert lifecycle defaults migration (real DB)', () => {
  it('backfill nulls cooldown 5 and auto_resolve false only', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const ids = {
      fiveFalse: await insertMonitor(org.id, 5, false),
      tenTrue: await insertMonitor(org.id, 10, true),
      fiveTrue: await insertMonitor(org.id, 5, true),
      zeroFalse: await insertMonitor(org.id, 0, false),
    };

    await replayMigration(FILE);

    const read = async (id: string) => {
      const [r] = await rows<{ cooldown_minutes: number | null; auto_resolve: boolean | null }>(sql`
        SELECT cooldown_minutes, auto_resolve FROM monitor_definitions WHERE id = ${id}::uuid`);
      return r!;
    };
    expect(await read(ids.fiveFalse)).toEqual({ cooldown_minutes: null, auto_resolve: null });
    expect(await read(ids.tenTrue)).toEqual({ cooldown_minutes: 10, auto_resolve: true });
    expect(await read(ids.fiveTrue)).toEqual({ cooldown_minutes: null, auto_resolve: true });
    // 0 is a deliberate "no cooldown", never the old default.
    expect(await read(ids.zeroFalse)).toEqual({ cooldown_minutes: 0, auto_resolve: null });

    // Idempotent: a second replay changes nothing.
    await replayMigration(FILE);
    expect(await read(ids.tenTrue)).toEqual({ cooldown_minutes: 10, auto_resolve: true });
  });

  it('monitor cooldown_minutes / auto_resolve are nullable with no default, so an omitted value inherits', async () => {
    const cols = await rows<{ column_name: string; is_nullable: string; column_default: string | null }>(sql`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'monitor_definitions'
        AND column_name IN ('cooldown_minutes', 'auto_resolve', 'rearm_mode', 'rearm_delay_minutes')
      ORDER BY column_name`);
    expect(cols).toEqual([
      { column_name: 'auto_resolve', is_nullable: 'YES', column_default: null },
      { column_name: 'cooldown_minutes', is_nullable: 'YES', column_default: null },
      { column_name: 'rearm_delay_minutes', is_nullable: 'YES', column_default: null },
      { column_name: 'rearm_mode', is_nullable: 'YES', column_default: null },
    ]);

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [m] = await rows<Row>(sql`
      INSERT INTO monitor_definitions (org_id, name, kind, condition, severity)
      VALUES (${org.id}::uuid, 'inherit', 'cpu', '{"threshold":90}'::jsonb, 'high')
      RETURNING cooldown_minutes, auto_resolve, rearm_mode, rearm_delay_minutes`);
    expect(m).toEqual({ cooldown_minutes: null, auto_resolve: null, rearm_mode: null, rearm_delay_minutes: null });
  });

  it('partners default to the built-in lifecycle', async () => {
    const partner = await createPartner();
    const [p] = await rows<Row>(sql`
      SELECT alert_auto_resolve, alert_rearm_mode, alert_rearm_delay_minutes, alert_cooldown_minutes
      FROM partners WHERE id = ${partner.id}::uuid`);
    expect(p).toEqual({
      alert_auto_resolve: false, alert_rearm_mode: 'new_evidence', alert_rearm_delay_minutes: null, alert_cooldown_minutes: 5,
    });
  });

  it('organizations columns default to NULL', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [o] = await rows<Row>(sql`
      SELECT alert_auto_resolve, alert_rearm_mode, alert_rearm_delay_minutes, alert_cooldown_minutes
      FROM organizations WHERE id = ${org.id}::uuid`);
    expect(o).toEqual({
      alert_auto_resolve: null, alert_rearm_mode: null, alert_rearm_delay_minutes: null, alert_cooldown_minutes: null,
    });
  });

  it('rejects after_delay without minutes on partners and organizations', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    expect(await sqlState(() => db.execute(sql`
      UPDATE partners SET alert_rearm_mode = 'after_delay' WHERE id = ${partner.id}::uuid`))).toBe('23514');
    expect(await sqlState(() => db.execute(sql`
      UPDATE organizations SET alert_rearm_mode = 'after_delay' WHERE id = ${org.id}::uuid`))).toBe('23514');
    // A delay without after_delay is rejected too (the pair is one setting).
    expect(await sqlState(() => db.execute(sql`
      UPDATE partners SET alert_rearm_delay_minutes = 30 WHERE id = ${partner.id}::uuid`))).toBe('23514');
    expect(await sqlState(() => db.execute(sql`
      UPDATE organizations SET alert_rearm_delay_minutes = 30 WHERE id = ${org.id}::uuid`))).toBe('23514');

    // The valid pair saves at both levels.
    expect(await sqlState(() => db.execute(sql`
      UPDATE partners SET alert_rearm_mode = 'after_delay', alert_rearm_delay_minutes = 60 WHERE id = ${partner.id}::uuid`))).toBeUndefined();
    expect(await sqlState(() => db.execute(sql`
      UPDATE organizations SET alert_rearm_mode = 'after_delay', alert_rearm_delay_minutes = 15 WHERE id = ${org.id}::uuid`))).toBeUndefined();
    // NULL mode = inherit at the org (no delay allowed with it).
    expect(await sqlState(() => db.execute(sql`
      UPDATE organizations SET alert_rearm_mode = NULL, alert_rearm_delay_minutes = NULL WHERE id = ${org.id}::uuid`))).toBeUndefined();
  });

  it('bounds the values and rejects an unknown mode on every level', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const monitorId = await insertMonitor(org.id, 7, true);

    const bad = [
      sql`UPDATE partners SET alert_cooldown_minutes = 1441 WHERE id = ${partner.id}::uuid`,
      sql`UPDATE partners SET alert_rearm_mode = 'always' WHERE id = ${partner.id}::uuid`,
      sql`UPDATE partners SET alert_rearm_mode = 'after_delay', alert_rearm_delay_minutes = 0 WHERE id = ${partner.id}::uuid`,
      sql`UPDATE organizations SET alert_cooldown_minutes = -1 WHERE id = ${org.id}::uuid`,
      sql`UPDATE organizations SET alert_rearm_mode = 'after_delay', alert_rearm_delay_minutes = 1441 WHERE id = ${org.id}::uuid`,
      sql`UPDATE monitor_definitions SET rearm_mode = 'after_delay' WHERE id = ${monitorId}::uuid`,
      sql`UPDATE monitor_definitions SET rearm_delay_minutes = 10 WHERE id = ${monitorId}::uuid`,
      sql`UPDATE monitor_definitions SET rearm_mode = 'always' WHERE id = ${monitorId}::uuid`,
    ];
    for (const statement of bad) {
      expect(await sqlState(() => db.execute(statement))).toBe('23514');
    }
    expect(await sqlState(() => db.execute(sql`
      UPDATE monitor_definitions SET rearm_mode = 'after_delay', rearm_delay_minutes = 1440 WHERE id = ${monitorId}::uuid`))).toBeUndefined();
  });
});
