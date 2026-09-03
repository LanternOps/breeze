/**
 * Real-DB truth table for the #3205 W04 (#4607) allowance invariants on
 * contract_lines, as breeze_app (forced RLS, no bypass). Mirrors
 * contractLinesDeviceRolesConstraints / contractLinesDeviceGroupConstraints.
 *
 * The point of the full PRESENCE MATRIX (all 8 null/non-null combinations of
 * the three columns, on all six line types) is that a CHECK passes on TRUE *or
 * NULL* — so every conjunct has to be proven to REJECT rather than abstain. A
 * three-valued comparison like `overage_mode <> 'bill'` would silently admit
 * rows and no single-case test would notice.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { partners, organizations, contracts } from '../../db/schema';

const MIGRATION = '2026-10-08-100200-contract-lines-allowance-overage.sql';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `AP ${sfx}`, slug: `ap-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'AOrg', slug: `ao-${sfx}` })
      .returning({ id: organizations.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Allowance', intervalMonths: 1,
      startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return { orgId: o!.id, contractId: c!.id };
  });
}

type F = Awaited<ReturnType<typeof seed>>;

/** Insert one line, supplying only the per-type columns the OTHER CHECKs need,
 *  so a rejection can only ever come from contract_lines_allowance_chk. */
function insertLine(f: F, opts: {
  lineType: string;
  includedQuantity?: string | null;
  overageMode?: string | null;
  overageUnitPrice?: string | null;
}) {
  const roles = opts.lineType === 'per_device_role' ? sql`ARRAY['server']::text[]` : sql`NULL`;
  // A group line needs a stamped name and no site (contract_lines_device_group_chk);
  // a NULL device_group_id is the legal post-deletion state, so no group row is needed.
  const groupName = opts.lineType === 'per_device_group' ? sql`'VIP'` : sql`NULL`;
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO contract_lines
      (contract_id, org_id, line_type, description, unit_price, taxable,
       device_roles, device_group_name, manual_quantity,
       included_quantity, overage_mode, overage_unit_price)
    VALUES
      (${f.contractId}::uuid, ${f.orgId}::uuid, ${opts.lineType}::contract_line_type, 'a', 10.00, true,
       ${roles}, ${groupName}, ${opts.lineType === 'manual' ? sql`2.00` : sql`NULL`},
       ${opts.includedQuantity ?? null}::numeric,
       ${opts.overageMode ?? null}::contract_overage_mode,
       ${opts.overageUnitPrice ?? null}::numeric)
    RETURNING id
  `));
}

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

async function expectRejected(op: () => Promise<unknown>, label: string): Promise<void> {
  try { await op(); } catch (error) {
    expect(pgErrorFields(error), label).toEqual({ code: '23514', constraint: 'contract_lines_allowance_chk' });
    return;
  }
  throw new Error(`expected contract_lines_allowance_chk to reject: ${label}`);
}

const ALLOWANCE_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
const NON_ALLOWANCE_TYPES = ['flat', 'manual'] as const;
const I = '25.00';
const P = '12.00';
/** [includedQuantity, overageMode, overageUnitPrice] presence, 8 combinations. */
const PRESENCE: Array<[boolean, boolean, boolean]> = [
  [false, false, false], [false, false, true], [false, true, false], [false, true, true],
  [true, false, false], [true, false, true], [true, true, false], [true, true, true],
];

describe('contract_lines allowance invariants (real DB) #3205 W04', () => {
  it('presence matrix on every allowance type, in both modes', async () => {
    const f = await seed();
    for (const lineType of ALLOWANCE_TYPES) {
      for (const mode of ['bill', 'flag'] as const) {
        for (const [hasI, hasM, hasP] of PRESENCE) {
          const opts = {
            lineType,
            includedQuantity: hasI ? I : null,
            overageMode: hasM ? mode : null,
            overageUnitPrice: hasP ? P : null,
          };
          // Accepted iff: no allowance at all, OR (I and M set) and the price is
          // present exactly when the mode is 'bill'.
          const accepted = (!hasI && !hasM && !hasP) || (hasI && hasM && hasP === (mode === 'bill'));
          const label = `${lineType}/${mode} I=${hasI} M=${hasM} P=${hasP}`;
          if (accepted) await expect(insertLine(f, opts), label).resolves.toBeDefined();
          else await expectRejected(() => insertLine(f, opts), label);
        }
      }
    }
  });

  it('rejects every allowance column on flat and manual, and accepts them with none', async () => {
    const f = await seed();
    for (const lineType of NON_ALLOWANCE_TYPES) {
      await expect(insertLine(f, { lineType })).resolves.toBeDefined();
      await expectRejected(() => insertLine(f, { lineType, includedQuantity: I, overageMode: 'flag' }), `${lineType} I+M`);
      await expectRejected(() => insertLine(f, { lineType, includedQuantity: I }), `${lineType} I only`);
      await expectRejected(() => insertLine(f, { lineType, overageMode: 'flag' }), `${lineType} M only`);
      await expectRejected(() => insertLine(f, { lineType, overageUnitPrice: P }), `${lineType} P only`);
    }
  });

  it('rejects a zero or fractional included_quantity and a negative overage price, and accepts a zero overage price', async () => {
    const f = await seed();
    await expectRejected(() => insertLine(f, { lineType: 'per_device', includedQuantity: '0.00', overageMode: 'flag' }), 'zero included');
    await expectRejected(() => insertLine(f, { lineType: 'per_device', includedQuantity: '25.50', overageMode: 'flag' }), 'fractional included');
    // The `overage_unit_price >= 0` conjunct: the money Zod type already refuses a sign, so this is the DB's own proof.
    await expectRejected(() => insertLine(f, { lineType: 'per_device', includedQuantity: I, overageMode: 'bill', overageUnitPrice: '-1.00' }), 'negative overage price');
    // 0.00 = "itemised at no charge" — still writes a customer-visible line.
    await expect(insertLine(f, { lineType: 'per_device', includedQuantity: I, overageMode: 'bill', overageUnitPrice: '0.00' })).resolves.toBeDefined();
  });

  it('contract_overage_mode carries exactly {bill, flag}', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'contract_overage_mode' ORDER BY e.enumsortorder
    `)) as unknown as Array<{ enumlabel: string }>;
    expect(rows.map((r) => r.enumlabel)).toEqual(['bill', 'flag']);
  });

  it('re-applying the migration is a no-op and the CHECK still fires', async () => {
    const f = await seed();
    const migrationSql = readFileSync(join(__dirname, '../../../migrations/', MIGRATION), 'utf8');
    // getTestDb() is the superuser client — the same shape the other migration
    // replay tests use for DDL.
    await getTestDb().execute(sql.raw(migrationSql));
    await expectRejected(() => insertLine(f, { lineType: 'per_device', includedQuantity: I }), 'after replay');
    await expect(insertLine(f, { lineType: 'per_device', includedQuantity: I, overageMode: 'flag' })).resolves.toBeDefined();
  });
});
