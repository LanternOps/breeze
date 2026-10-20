/**
 * #9315: the portal_visible backfill on deliverable_template_items.
 *
 * The migration flips existing one_time items to hidden, but only on the apply
 * that ADDS the column. A replay must never re-hide an item an editor later
 * made visible. Run inside a rolled-back transaction because it drops the
 * column to recreate the pre-migration shape.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2027-01-02-100500-deliverable-template-item-portal-visible.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

class Rollback extends Error {}

describe.skipIf(!RUN)('deliverable_template_items.portal_visible migration (#9315)', () => {
  it('backfills one_time items on first apply and leaves later editor choices alone on replay', async () => {
    const observed: Record<string, Record<string, boolean>> = {};
    const snapshot = async (tx: postgres.TransactionSql, label: string) => {
      const rows = await tx<{ name: string; portal_visible: boolean }[]>`
        SELECT name, portal_visible FROM deliverable_template_items WHERE set_id = (
          SELECT id FROM deliverable_template_sets WHERE name = 'pv-9315 set')`;
      observed[label] = Object.fromEntries(rows.map((r) => [r.name, r.portal_visible]));
    };

    await adminSql.begin(async (tx) => {
      await tx`SELECT set_config('breeze.scope', 'system', true)`;
      await tx`ALTER TABLE deliverable_template_items DROP COLUMN portal_visible`;
      const [partner] = await tx<{ id: string }[]>`
        INSERT INTO partners (name, slug) VALUES ('pv-9315', ${`pv-9315-${Date.now()}`}) RETURNING id`;
      const [set] = await tx<{ id: string }[]>`
        INSERT INTO deliverable_template_sets (partner_id, name) VALUES (${partner!.id}, 'pv-9315 set') RETURNING id`;
      await tx`
        INSERT INTO deliverable_template_items (set_id, partner_id, name, cadence) VALUES
          (${set!.id}, ${partner!.id}, 'Billing configured', 'one_time'),
          (${set!.id}, ${partner!.id}, 'Monthly report', 'monthly')`;

      await tx.unsafe(migrationSql);
      await snapshot(tx, 'firstApply');

      // An editor deliberately shows the one-time item, then the file replays.
      await tx`UPDATE deliverable_template_items SET portal_visible = true WHERE name = 'Billing configured'`;
      await tx.unsafe(migrationSql);
      await snapshot(tx, 'replay');

      throw new Rollback();
    }).catch((err) => { if (!(err instanceof Rollback)) throw err; });

    expect(observed.firstApply).toEqual({ 'Billing configured': false, 'Monthly report': true });
    expect(observed.replay).toEqual({ 'Billing configured': true, 'Monthly report': true });
  });
});
