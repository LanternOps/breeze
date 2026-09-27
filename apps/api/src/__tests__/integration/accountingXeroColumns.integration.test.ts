/**
 * Xero W02 Task 1: the three new accounting_connections columns exist, are
 * nullable varchar(64), and the migration re-runs as a no-op.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { db, withSystemDbAccessContext } from '../../db';
import { createPartner } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-11-02-120000-accounting-connections-xero-columns.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

describe.skipIf(!RUN)('accounting_connections Xero columns (W02 Task 1)', () => {
  it('adds three nullable varchar(64) columns and re-runs as a no-op', async () => {
    await adminSql.unsafe(migrationSql);
    await adminSql.unsafe(migrationSql);
    const cols = await adminSql`
      select column_name, data_type, character_maximum_length, is_nullable
      from information_schema.columns
      where table_name = 'accounting_connections'
        and column_name in ('default_exempt_tax_code_ref', 'default_payment_account_ref', 'provider_connection_ref')
      order by column_name`;
    expect(cols.map((c) => [c.column_name, c.data_type, c.character_maximum_length, c.is_nullable])).toEqual([
      ['default_exempt_tax_code_ref', 'character varying', 64, 'YES'],
      ['default_payment_account_ref', 'character varying', 64, 'YES'],
      ['provider_connection_ref', 'character varying', 64, 'YES'],
    ]);
  });

  it('round-trips through upsertConnection', async () => {
    const partner = await createPartner();
    const conn = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'xero', {
      realmId: 'tenant-cols-1', providerConnectionRef: 'conn-cols-1', environment: 'production',
    }));
    expect(conn.providerConnectionRef).toBe('conn-cols-1');
    expect(conn.defaultExemptTaxCodeRef).toBeNull();
    expect(conn.defaultPaymentAccountRef).toBeNull();
  });
});
