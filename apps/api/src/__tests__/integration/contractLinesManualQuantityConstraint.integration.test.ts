/**
 * Real-DB truth table for contract_lines_manual_quantity_chk (#9664), as
 * breeze_app (forced RLS, no bypass). A manual line with NULL manual_quantity
 * used to bill quantity 0 — a silent $0 invoice line.
 *
 * Also replays the migration file: on a clean table it must leave the CHECK
 * VALIDATED, and on a table that already holds an offending row it must still
 * apply (NOT VALID, enforced for new writes) instead of failing autoMigrate.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, contracts, contractLines } from '../../db/schema';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2027-01-06-150000-contract-lines-manual-quantity-check.sql');
const CONSTRAINT = 'contract_lines_manual_quantity_chk';
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `MQ ${sfx}`, slug: `mq-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'MQO', slug: `mqo-${sfx}` })
      .returning({ id: organizations.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'C', intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return { orgId: o!.id, contractId: c!.id };
  });
}

/** Raw insert as breeze_app so the CHECK — not Drizzle typing — is what rejects. */
async function rawLine(f: Awaited<ReturnType<typeof seed>>, cols: Record<string, unknown>) {
  return withSystemDbAccessContext(() => db.insert(contractLines).values({
    contractId: f.contractId, orgId: f.orgId, description: 'x', unitPrice: '1.00', taxable: false,
    ...cols,
  } as never).returning({ id: contractLines.id }));
}

async function expectConstraint(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    const wrapped = error as { message?: string; cause?: { message?: string; constraint_name?: string } };
    expect(`${wrapped.message ?? ''} ${wrapped.cause?.message ?? ''} ${wrapped.cause?.constraint_name ?? ''}`)
      .toMatch(new RegExp(CONSTRAINT));
    return;
  }
  throw new Error(`expected ${CONSTRAINT} to reject the write`);
}

async function convalidated(executor: { execute: typeof db.execute }): Promise<boolean | undefined> {
  const rows = await executor.execute(sql`
    SELECT convalidated FROM pg_constraint
     WHERE conname = ${CONSTRAINT} AND conrelid = 'public.contract_lines'::regclass
  `) as unknown as Array<{ convalidated: boolean }>;
  return rows[0]?.convalidated;
}

describe('contract_lines manual quantity CHECK (#9664)', () => {
  runDb('rejects a manual line with NULL manual_quantity', async () => {
    const f = await seed();
    await expectConstraint(() => rawLine(f, { lineType: 'manual' }));
    await expectConstraint(() => rawLine(f, { lineType: 'manual', manualQuantity: null }));
  });

  runDb('accepts a manual line with a quantity, including an explicit 0', async () => {
    const f = await seed();
    expect(await rawLine(f, { lineType: 'manual', manualQuantity: '2.00' })).toHaveLength(1);
    expect(await rawLine(f, { lineType: 'manual', manualQuantity: '0.00' })).toHaveLength(1);
  });

  runDb('rejects clearing the quantity on an existing manual line', async () => {
    const f = await seed();
    const [line] = await rawLine(f, { lineType: 'manual', manualQuantity: '2.00' });
    await expectConstraint(() => withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE contract_lines SET manual_quantity = NULL WHERE id = ${line!.id}`)));
  });

  runDb('leaves every other line type free to carry NULL', async () => {
    const f = await seed();
    expect(await rawLine(f, { lineType: 'flat' })).toHaveLength(1);
    expect(await rawLine(f, { lineType: 'per_seat' })).toHaveLength(1);
  });

  runDb('on a clean table the migration validates the CHECK, and re-applying is a no-op', async () => {
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    const adminDb = getTestDb();
    await adminDb.execute(sql.raw(migration));
    await adminDb.execute(sql.raw(migration));
    expect(await convalidated(adminDb)).toBe(true);
  });

  runDb('with a pre-existing offending row the migration still applies, NOT VALID but enforced', async () => {
    const f = await seed();
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    const adminDb = getTestDb();
    const ROLLBACK = new Error('rollback: leave the shared table as it was');
    await expect(adminDb.transaction(async (tx) => {
      // Reproduce the pre-migration world: no CHECK, a manual line with no quantity.
      await tx.execute(sql.raw(`ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`));
      await tx.execute(sql`
        INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable)
        VALUES (${f.contractId}::uuid, ${f.orgId}::uuid, 'manual', 'legacy', 1.00, false)
      `);
      await tx.execute(sql.raw(migration));
      expect(await convalidated(tx)).toBe(false);
      // NOT VALID still binds new writes.
      await expectConstraint(() => tx.execute(sql`
        INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable)
        VALUES (${f.contractId}::uuid, ${f.orgId}::uuid, 'manual', 'new', 1.00, false)
      `));
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    expect(await convalidated(adminDb)).toBe(true);
  });
});
