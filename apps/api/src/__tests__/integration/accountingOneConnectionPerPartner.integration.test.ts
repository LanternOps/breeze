/**
 * Real-DB proof of Xero W01's one-connection-per-partner contract (spec D2):
 *  - the migration refuses to run while any partner holds >1 row, and it can
 *    SEE those rows under FORCE RLS (it elects system scope first);
 *  - re-running the migration is a no-op;
 *  - a second provider row for the same partner is refused by the index;
 *  - upsertConnection reuses the row on a same-provider reconnect and raises
 *    AccountingProviderConflictError on a different provider (Task 2).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { accountingConnections } from '../../db/schema';
import { createPartner } from './db-utils';
import {
  AccountingProviderConflictError,
  upsertConnection,
} from '../../services/accounting/accountingConnectionService';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-11-02-110000-accounting-connections-one-per-partner.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

describe.skipIf(!RUN)('accounting_connections: one connection per partner', () => {
  it('the index exists and re-running the migration is a no-op', async () => {
    await adminSql.unsafe(migrationSql);
    const idx = await adminSql`
      select indexdef from pg_indexes
      where tablename = 'accounting_connections' and indexname = 'accounting_connections_partner_idx'`;
    expect(idx).toHaveLength(1);
    expect(String(idx[0]!.indexdef)).toMatch(/UNIQUE INDEX .* \(partner_id\)$/);
    // Kept on purpose (plan preamble item 1): rollback safety for ON CONFLICT (partner_id, provider).
    const legacy = await adminSql`
      select 1 from pg_indexes where indexname = 'accounting_connections_partner_provider_idx'`;
    expect(legacy).toHaveLength(1);
  });

  it('refuses a second provider row for the same partner', async () => {
    const partner = await createPartner();
    await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'r-one-1' }));
    // Deviation from the brief: this drizzle-orm version wraps the postgres.js
    // error in a DrizzleQueryError whose OWN `.code` is undefined — the real
    // SQLSTATE lives on `.cause` (see packages/shared/src/utils/pgErrors.ts's
    // doc comment). Asserting on `.cause.code` keeps the same intent (a real
    // 23505 fired) against the actual error shape.
    await expect(withSystemDbAccessContext(() => db.insert(accountingConnections).values({
      partnerId: partner.id, provider: 'xero',
    }))).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('the migration aborts, with a count, when a partner holds two rows (and it can see them under FORCE RLS)', async () => {
    const partner = await createPartner();
    let caught: unknown;
    await adminSql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('breeze.scope', 'system', true)`);
      await tx.unsafe('DROP INDEX accounting_connections_partner_idx');
      await tx`insert into accounting_connections (partner_id, provider) values (${partner.id}, 'quickbooks')`;
      await tx`insert into accounting_connections (partner_id, provider) values (${partner.id}, 'xero')`;
      // Reset to the migration runner's default scope, so the migration's own set_config is what makes the rows visible.
      await tx.unsafe(`SELECT set_config('breeze.scope', 'none', true)`);
      try {
        await tx.unsafe(`SAVEPOINT before_migration`);
        await tx.unsafe(migrationSql);
      } catch (err) {
        caught = err;
        await tx.unsafe(`ROLLBACK TO SAVEPOINT before_migration`);
      }
      throw new Error('rollback-sentinel'); // never keep the dropped index or the duplicate rows
    }).catch((err) => { if ((err as Error).message !== 'rollback-sentinel') throw err; });
    expect(String((caught as Error | undefined)?.message)).toMatch(/one-per-partner precondition failed: 1 partner/);
  });

  it('upsertConnection: same-provider reconnect reuses the row; a different provider raises AccountingProviderConflictError', async () => {
    const partner = await createPartner();
    const first = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'r-a' }));
    // Stale 'disconnected' row (Review Focus 4).
    await withSystemDbAccessContext(() => db.update(accountingConnections)
      .set({ status: 'disconnected' }).where(eq(accountingConnections.id, first.id)));

    const again = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'r-a', status: 'connected' }));
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('connected');

    await withSystemDbAccessContext(() => db.update(accountingConnections)
      .set({ status: 'disconnected' }).where(eq(accountingConnections.id, first.id)));
    await expect(withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'xero', { realmId: 'tenant-x' })))
      .rejects.toBeInstanceOf(AccountingProviderConflictError);
    const rows = await withSystemDbAccessContext(() => db.select().from(accountingConnections)
      .where(eq(accountingConnections.partnerId, partner.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('quickbooks');
    expect(rows[0]!.status).toBe('disconnected'); // untouched by the refused connect
  });
});
