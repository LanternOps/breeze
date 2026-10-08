/**
 * Block hours W01 (#4547): real-DB proof of the schema this wave adds —
 * contract_line_type.hour_block, the contract_lines block columns and CHECKs,
 * the contract_hour_periods ledger (RLS Shape 1, three composite deferrable
 * FKs) and time_entries.contract_line_id.
 *
 * Harness copied from contractLinesAllowanceConstraints.integration.test.ts
 * (seed / insert / pgErrorFields / replay via the superuser client) and
 * billingEvidenceRls.integration.test.ts (breeze_app context + 42501 check).
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { CONTRACT_LINE_TYPES } from '@breeze/shared';
import { db, withDbAccessContext } from '../../db';
import { splitSqlStatements } from '../../db/autoMigrate';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import { replayMigration } from './replayMigration';

describe('contract_line_type.hour_block (real DB) #4547 W01', () => {
  it('is the last label, and every existing label is still present', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'contract_line_type' ORDER BY e.enumsortorder
    `) as unknown as Array<{ enumlabel: string }>;
    const labels = rows.map((r) => r.enumlabel);
    expect(labels.at(-1)).toBe('hour_block');
    expect(labels).toEqual(expect.arrayContaining([...CONTRACT_LINE_TYPES, 'hour_block']));
  });
});

const MIGRATIONS_DIR = join(__dirname, '../../../migrations/');
const F_LINES = '2026-12-17-100100-contract-lines-hour-block.sql';
const F_ALLOWANCE_OLD = '2026-10-08-100200-contract-lines-allowance-overage.sql';

async function replay(file: string): Promise<void> {
  await getTestDb().execute(sql.raw(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')));
}

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const admin = getTestDb();
  const mkContract = async (orgId: string) => {
    const id = randomUUID();
    await admin.execute(sql`
      INSERT INTO contracts (id, partner_id, org_id, name, interval_months, start_date, currency_code)
      VALUES (${id}::uuid, ${partner.id}::uuid, ${orgId}::uuid, 'Block hours', 1, '2026-12-01', 'USD')
    `);
    return id;
  };
  const user = await createUser({ partnerId: partner.id, email: `bh-${randomUUID()}@example.test` });
  return {
    partnerId: partner.id as string,
    userId: user.id as string,
    orgA: orgA.id as string,
    orgB: orgB.id as string,
    contractA: await mkContract(orgA.id as string),
    contractB: await mkContract(orgB.id as string),
  };
}
type F = Awaited<ReturnType<typeof seed>>;

type LineOpts = {
  lineType?: string; included?: string | null; mode?: string | null; price?: string | null;
  rollover?: string | null; cap?: string | null; alertPct?: number | null; first?: string | null;
  retiredAt?: string | null; siteId?: string | null; siteName?: string | null;
  manualQuantity?: string | null; contractId?: string; orgId?: string;
};

/** Insert one line as the superuser (superuser connection: RLS not applied, CHECKs and FKs still apply).
 *  Defaults to a VALID live hour_block; each test overrides the field under test. */
async function insertLine(f: F, o: LineOpts = {}): Promise<Array<{ id: string }>> {
  const v = {
    lineType: 'hour_block', included: '10.00', mode: 'bill', price: '95.00', rollover: 'none',
    cap: null, alertPct: null, first: '2026-12-01', retiredAt: null, siteId: null, siteName: null,
    manualQuantity: null, contractId: f.contractA, orgId: f.orgA, ...o,
  } as Required<LineOpts>;
  return await getTestDb().execute(sql`
    INSERT INTO contract_lines
      (contract_id, org_id, line_type, description, unit_price, taxable, site_id, site_name, manual_quantity,
       included_quantity, overage_mode, overage_unit_price,
       rollover_policy, rollover_cap_hours, hour_block_alert_pct, hour_block_first_period_start, hour_block_retired_at)
    VALUES
      (${v.contractId}::uuid, ${v.orgId}::uuid, ${v.lineType}::contract_line_type, 'Prepaid hours', 500.00, false,
       ${v.siteId}::uuid, ${v.siteName}, ${v.manualQuantity}::numeric,
       ${v.included}::numeric, ${v.mode}::contract_overage_mode, ${v.price}::numeric,
       ${v.rollover}, ${v.cap}::numeric, ${v.alertPct}::int, ${v.first}::date, ${v.retiredAt}::timestamptz)
    RETURNING id
  `) as unknown as Array<{ id: string }>;
}

/** A line that is not a block: the allowance columns and every block column off. */
const FLAT: LineOpts = { lineType: 'flat', included: null, mode: null, price: null, rollover: null, first: null };

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

/** The operation must fail with `code`, and the constraint that fired must be one of `constraints`.
 *  Postgres evaluates CHECKs in name order, so a row that violates two reports the earlier name. */
async function expectConstraint(
  op: () => Promise<unknown>, code: string, constraints: string[], label: string,
): Promise<void> {
  let raised: unknown;
  try { await op(); } catch (error) { raised = error; }
  if (raised === undefined) throw new Error(`expected ${code} on ${constraints.join(' | ')}: ${label}`);
  const f = pgErrorFields(raised);
  expect(f.code, label).toBe(code);
  expect(constraints, label).toContain(f.constraint);
}

const HB = 'contract_lines_hour_block_chk';
const AL = 'contract_lines_allowance_chk';
const SITE_STAMP = 'contract_lines_site_stamp_chk';
const LIVE_UQ = 'contract_lines_one_live_hour_block_per_org_uq';

describe('contract_lines hour_block CHECKs (real DB) #4547 W01', () => {
  it('rejects each malformed block, naming the constraint that fires', async () => {
    const f = await seed();
    const [site] = await getTestDb().execute(sql`
      INSERT INTO sites (org_id, name) VALUES (${f.orgA}::uuid, 'HQ') RETURNING id
    `) as unknown as Array<{ id: string }>;
    const cases: Array<[string, LineOpts, string[]]> = [
      // Required fields NULL. (included_quantity NULL also needs mode/price NULL, or the allowance CHECK fires first.)
      ['included_quantity NULL', { included: null, mode: null, price: null }, [HB]],
      ['overage_mode NULL', { mode: null, price: null }, [AL, HB]],
      ['overage_mode flag (Open Decision 10 A)', { mode: 'flag', price: null }, [HB]],
      ['overage price NULL under bill', { price: null }, [AL]],
      ['rollover_policy NULL', { rollover: null }, [HB]],
      ['rollover_policy not in the set', { rollover: 'weekly' }, [HB]],
      ['hour_block_first_period_start NULL', { first: null }, [HB]],
      // Zero hours; the allowance CHECK's "> 0" conjunct.
      ['included_quantity 0', { included: '0.00' }, [AL]],
      // Scoping columns a block may not carry.
      ['site_id on a block', { siteId: site!.id, siteName: 'HQ' }, [HB, SITE_STAMP]],
      ['manual_quantity on a block', { manualQuantity: '2.00' }, [HB]],
      // Cap only under carry_forward, and > 0.
      ['rollover_cap_hours under none', { rollover: 'none', cap: '5.00' }, [HB]],
      ['rollover_cap_hours 0 under carry_forward', { rollover: 'carry_forward', cap: '0.00' }, [HB]],
      // Alert percentage is 1..100.
      ['alert_pct 0', { alertPct: 0 }, [HB]],
      ['alert_pct 101', { alertPct: 101 }, [HB]],
    ];
    for (const [label, opts, constraints] of cases) {
      await expectConstraint(() => insertLine(f, opts), '23514', constraints, label);
    }
  });

  it('accepts fractional hours and every legal combination (retired, so the live-block index is not in play)', async () => {
    const f = await seed();
    const retiredAt = '2026-12-02T00:00:00Z';
    const accepted: Array<[string, LineOpts]> = [
      ['plain block', {}],
      ['7.5 hours (fractional — exempt from the integrality conjunct)', { included: '7.50' }],
      ['carry_forward, uncapped', { rollover: 'carry_forward', cap: null }],
      ['carry_forward, capped 40.5h', { rollover: 'carry_forward', cap: '40.50' }],
      ['alert_pct 1', { alertPct: 1 }],
      ['alert_pct 100', { alertPct: 100 }],
      ['overage rate 0.00 (itemised at no charge)', { price: '0.00' }],
    ];
    for (const [label, opts] of accepted) {
      await expect(insertLine(f, { retiredAt, ...opts }), label).resolves.toHaveLength(1);
    }
  });

  it('rejects every block-only column on a non-block line and accepts a plain flat line', async () => {
    const f = await seed();
    await expect(insertLine(f, FLAT)).resolves.toHaveLength(1);
    const onFlat: Array<[string, LineOpts]> = [
      ['rollover_policy', { rollover: 'none' }],
      ['rollover_cap_hours', { cap: '5.00' }],
      ['hour_block_alert_pct', { alertPct: 50 }],
      ['hour_block_first_period_start', { first: '2026-12-01' }],
      ['hour_block_retired_at', { retiredAt: '2026-12-02T00:00:00Z' }],
    ];
    for (const [label, opts] of onFlat) {
      await expectConstraint(() => insertLine(f, { ...FLAT, ...opts }), '23514', [HB], `${label} on flat`);
    }
    // And on a counted type that legitimately carries an allowance.
    await expectConstraint(
      () => insertLine(f, { lineType: 'per_device', included: '25.00', mode: 'flag', price: null, rollover: null, first: null, retiredAt: '2026-12-02T00:00:00Z' }),
      '23514', [HB], 'retired_at on per_device',
    );
  });

  it('the fractional-hours exemption does not leak to device lines', async () => {
    const f = await seed();
    await expectConstraint(
      () => insertLine(f, { lineType: 'per_device', included: '25.50', mode: 'flag', price: null, rollover: null, first: null }),
      '23514', [AL], 'fractional included on per_device',
    );
  });

  it('allows one live block per org, frees the slot when it is retired, and is per org', async () => {
    const f = await seed();
    const [first] = await insertLine(f);
    await expectConstraint(() => insertLine(f), '23505', [LIVE_UQ], 'second live block, same org');
    await expect(insertLine(f, { contractId: f.contractB, orgId: f.orgB }), 'other org').resolves.toHaveLength(1);
    // A retired block never counts, so any number of them may sit beside a live one.
    await expect(insertLine(f, { retiredAt: '2026-12-02T00:00:00Z' })).resolves.toHaveLength(1);
    await getTestDb().execute(sql`UPDATE contract_lines SET hour_block_retired_at = now() WHERE id = ${first!.id}::uuid`);
    await expect(insertLine(f), 'successor after retirement').resolves.toHaveLength(1);
  });

  it('re-applying the migration is a no-op and the CHECKs still fire', async () => {
    const f = await seed();
    await replay(F_LINES);
    await expectConstraint(() => insertLine(f, { rollover: 'weekly' }), '23514', [HB], 'after replay');
    await expect(insertLine(f, { included: '7.50' })).resolves.toHaveLength(1);
  });

  it('replaying the OLDER allowance migration (as contractLinesAllowanceConstraints does) leaves hour_block admitted', async () => {
    const f = await seed();
    // replayMigration re-applies every later file that rewrites the same
    // constraint name, so this file's DROP + re-ADD (without hour_block) is
    // followed by F_LINES. A bare db.execute of the old file would not be.
    await replayMigration(F_ALLOWANCE_OLD);
    await expect(insertLine(f, { included: '7.50' })).resolves.toHaveLength(1);
  });
});

const F_LEDGER = '2026-12-17-100200-contract-hour-periods.sql';
const LEDGER_FKS = [
  'contract_hour_periods_contract_org_fk',
  'contract_hour_periods_line_org_fk',
  'contract_hour_periods_invoice_org_fk',
] as const;

type PeriodOpts = {
  lineId: string; contractId: string; orgId: string;
  periodStart?: string; periodEnd?: string; consumed?: string; overage?: string;
  closeSource?: string; invoiceId?: string | null;
};
type Exec = { execute: (q: ReturnType<typeof sql>) => PromiseLike<unknown> };

/** Insert one ledger row through `exec` (the superuser client by default; the
 *  breeze_app `db` inside withDbAccessContext for the RLS tests). */
async function insertPeriod(o: PeriodOpts, exec: Exec = getTestDb() as unknown as Exec): Promise<Array<{ id: string }>> {
  const v = {
    periodStart: '2026-12-01', periodEnd: '2027-01-01', consumed: '7.50', overage: '0.00',
    closeSource: 'billing_run', invoiceId: null, ...o,
  };
  return await exec.execute(sql`
    INSERT INTO contract_hour_periods
      (contract_line_id, contract_id, org_id, period_start, period_end,
       included_hours, carried_in_hours, consumed_hours, overage_hours, carried_out_hours,
       entry_count, overage_unit_price, currency_code, overage_invoice_id, close_source)
    VALUES
      (${v.lineId}::uuid, ${v.contractId}::uuid, ${v.orgId}::uuid, ${v.periodStart}::date, ${v.periodEnd}::date,
       10.00, 0.00, ${v.consumed}::numeric, ${v.overage}::numeric, 2.50,
       3, 95.00, 'USD', ${v.invoiceId}::uuid, ${v.closeSource})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
}

async function seedLedger() {
  const f = await seed();
  const [a] = await insertLine(f);
  const [b] = await insertLine(f, { contractId: f.contractB, orgId: f.orgB });
  return { ...f, lineA: a!.id, lineB: b!.id };
}

const ctxFor = (orgId: string, partnerId: string) =>
  ({ scope: 'organization' as const, orgId, partnerId, accessibleOrgIds: [orgId], userId: null });

describe('contract_hour_periods (real DB) #4547 W01', () => {
  it('stores fractional hours exactly and enforces one row per (line, period_start)', async () => {
    const f = await seedLedger();
    const base = { lineId: f.lineA, contractId: f.contractA, orgId: f.orgA };
    await expect(insertPeriod(base)).resolves.toHaveLength(1);
    const [row] = await getTestDb().execute(sql`
      SELECT consumed_hours::text AS c, carried_out_hours::text AS o, foreign_currency_hours::text AS fx
      FROM contract_hour_periods WHERE contract_line_id = ${f.lineA}::uuid
    `) as unknown as Array<{ c: string; o: string; fx: string }>;
    expect(row).toEqual({ c: '7.50', o: '2.50', fx: '0.00' });
    await expectConstraint(() => insertPeriod(base), '23505', ['contract_hour_periods_line_period_uq'], 'double close of one period');
    await expect(insertPeriod({ ...base, periodStart: '2027-01-01', periodEnd: '2027-02-01' })).resolves.toHaveLength(1);
  });

  it('rejects an inverted period, a negative hours column and an unknown close_source', async () => {
    const f = await seedLedger();
    const base = { lineId: f.lineA, contractId: f.contractA, orgId: f.orgA };
    await expectConstraint(() => insertPeriod({ ...base, periodEnd: '2026-12-01' }), '23514', ['contract_hour_periods_period_chk'], 'period_end = period_start');
    await expectConstraint(() => insertPeriod({ ...base, consumed: '-0.01' }), '23514', ['contract_hour_periods_hours_nonneg_chk'], 'negative consumed');
    await expectConstraint(() => insertPeriod({ ...base, overage: '-1.00' }), '23514', ['contract_hour_periods_hours_nonneg_chk'], 'negative overage');
    await expectConstraint(() => insertPeriod({ ...base, closeSource: 'manual' }), '23514', ['contract_hour_periods_close_source_chk'], 'close_source');
  });

  it('rejects a row whose line, contract or invoice belongs to another org — as system context, so only the FK can be the guard', async () => {
    const f = await seedLedger();
    const [inv] = await getTestDb().execute(sql`
      INSERT INTO invoices (partner_id, org_id, currency_code, status)
      VALUES (${f.partnerId}::uuid, ${f.orgA}::uuid, 'USD', 'draft') RETURNING id
    `) as unknown as Array<{ id: string }>;
    // Row is for org B; the line is org A's.
    await expectConstraint(
      () => insertPeriod({ lineId: f.lineA, contractId: f.contractB, orgId: f.orgB }),
      '23503', ['contract_hour_periods_line_org_fk'], 'line from another org');
    // Row is for org B; the contract is org A's.
    await expectConstraint(
      () => insertPeriod({ lineId: f.lineB, contractId: f.contractA, orgId: f.orgB }),
      '23503', ['contract_hour_periods_contract_org_fk'], 'contract from another org');
    // Row is for org B; the overage invoice is org A's.
    await expectConstraint(
      () => insertPeriod({ lineId: f.lineB, contractId: f.contractB, orgId: f.orgB, invoiceId: inv!.id }),
      '23503', ['contract_hour_periods_invoice_org_fk'], 'invoice from another org');
  });

  it('deleting a block line that has a ledger row is refused (RESTRICT), and allowed once the ledger row is gone', async () => {
    const f = await seedLedger();
    await insertPeriod({ lineId: f.lineA, contractId: f.contractA, orgId: f.orgA });
    // Postgres reports RESTRICT as foreign_key_violation (23503).
    await expectConstraint(
      () => getTestDb().execute(sql`DELETE FROM contract_lines WHERE id = ${f.lineA}::uuid`),
      '23503', ['contract_hour_periods_line_org_fk'], 'delete block with history');
    await getTestDb().execute(sql`DELETE FROM contract_hour_periods WHERE contract_line_id = ${f.lineA}::uuid`);
    await expect(getTestDb().execute(sql`DELETE FROM contract_lines WHERE id = ${f.lineA}::uuid`)).resolves.toBeDefined();
  });

  it('deleting the overage invoice nulls only overage_invoice_id (the SET NULL column list keeps org_id)', async () => {
    const f = await seedLedger();
    const [inv] = await getTestDb().execute(sql`
      INSERT INTO invoices (partner_id, org_id, currency_code, status)
      VALUES (${f.partnerId}::uuid, ${f.orgA}::uuid, 'USD', 'draft') RETURNING id
    `) as unknown as Array<{ id: string }>;
    await insertPeriod({ lineId: f.lineA, contractId: f.contractA, orgId: f.orgA, overage: '1.00', invoiceId: inv!.id });
    await getTestDb().execute(sql`DELETE FROM invoices WHERE id = ${inv!.id}::uuid`);
    const [row] = await getTestDb().execute(sql`
      SELECT overage_invoice_id, org_id FROM contract_hour_periods WHERE contract_line_id = ${f.lineA}::uuid
    `) as unknown as Array<{ overage_invoice_id: string | null; org_id: string }>;
    expect(row).toEqual({ overage_invoice_id: null, org_id: f.orgA });
  });

  it('all three composite FKs are DEFERRABLE INITIALLY IMMEDIATE, with the intended delete actions', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT conname, condeferrable, condeferred, confdeltype::text AS del, (confdelsetcols IS NOT NULL) AS has_cols
      FROM pg_constraint WHERE conrelid = 'public.contract_hour_periods'::regclass AND contype = 'f'
      ORDER BY conname
    `) as unknown as Array<{ conname: string; condeferrable: boolean; condeferred: boolean; del: string; has_cols: boolean }>;
    const byName = new Map(rows.map((r) => [r.conname, r]));
    for (const name of LEDGER_FKS) {
      expect(byName.get(name), name).toMatchObject({ condeferrable: true, condeferred: false });
    }
    expect(byName.get('contract_hour_periods_contract_org_fk')!.del).toBe('c'); // CASCADE
    expect(byName.get('contract_hour_periods_line_org_fk')!.del).toBe('r');     // RESTRICT
    expect(byName.get('contract_hour_periods_invoice_org_fk')).toMatchObject({ del: 'n', has_cols: true }); // SET NULL (overage_invoice_id)
  });

  it('RLS is enabled and forced with the four org-isolation policies, and breeze_app holds the grants', async () => {
    const [cls] = await getTestDb().execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.contract_hour_periods'::regclass
    `) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(cls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await getTestDb().execute(sql`
      SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_hour_periods' ORDER BY policyname
    `) as unknown as Array<{ policyname: string; cmd: string }>;
    expect(policies).toEqual([
      { policyname: 'breeze_org_isolation_delete', cmd: 'DELETE' },
      { policyname: 'breeze_org_isolation_insert', cmd: 'INSERT' },
      { policyname: 'breeze_org_isolation_select', cmd: 'SELECT' },
      { policyname: 'breeze_org_isolation_update', cmd: 'UPDATE' },
    ]);
    const grants = await getTestDb().execute(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'contract_hour_periods' AND grantee = 'breeze_app'
      ORDER BY privilege_type
    `) as unknown as Array<{ privilege_type: string }>;
    expect(grants.map((g) => g.privilege_type)).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'UPDATE']));
  });

  it('as breeze_app: a row for another org is rejected with 42501; each org sees only its own ledger', async () => {
    const f = await seedLedger();
    await withDbAccessContext(ctxFor(f.orgA, f.partnerId), () =>
      insertPeriod({ lineId: f.lineA, contractId: f.contractA, orgId: f.orgA }, db as unknown as Exec));
    // Forged: org-A context writing a row stamped for org B (the FK targets all exist in B).
    let raised: unknown;
    try {
      await withDbAccessContext(ctxFor(f.orgA, f.partnerId), () =>
        insertPeriod({ lineId: f.lineB, contractId: f.contractB, orgId: f.orgB }, db as unknown as Exec));
    } catch (error) { raised = error; }
    expect(raised, 'expected forced RLS to reject the row').toBeDefined();
    const wrapped = raised as { code?: string; cause?: { code?: string; message?: string } };
    expect(wrapped.cause?.code ?? wrapped.code).toBe('42501');
    expect(wrapped.cause?.message).toMatch(/new row violates row-level security policy/);
    const inA = await withDbAccessContext(ctxFor(f.orgA, f.partnerId), () =>
      db.execute(sql`SELECT id FROM contract_hour_periods`));
    const inB = await withDbAccessContext(ctxFor(f.orgB, f.partnerId), () =>
      db.execute(sql`SELECT id FROM contract_hour_periods`));
    expect(inA.length).toBe(1);
    expect(inB.length).toBe(0);
  });

  it('re-applying the migration is a no-op: the row survives and the policies and FKs are unchanged', async () => {
    const f = await seedLedger();
    await insertPeriod({ lineId: f.lineA, contractId: f.contractA, orgId: f.orgA });
    const before = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM contract_hour_periods`) as unknown as Array<{ n: number }>;
    await replay(F_LEDGER);
    const after = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM contract_hour_periods`) as unknown as Array<{ n: number }>;
    expect(after[0]!.n).toBe(before[0]!.n);
    const fks = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.contract_hour_periods'::regclass AND contype = 'f' AND condeferrable AND NOT condeferred
        AND conname LIKE 'contract_hour_periods_%_org_fk'
    `) as unknown as Array<{ n: number }>;
    expect(fks[0]!.n).toBe(3);
  });
});

const F_ENTRIES = '2026-12-17-100300-time-entries-contract-line.sql';
const TE_FK = 'time_entries_contract_line_org_fk';
const TE_ORG_CHK = 'time_entries_contract_line_org_chk';
const TE_STATUS_CHK = 'time_entries_contract_line_chk';

/** Replay a no-transaction file the way autoMigrate does: one statement per
 *  command on a single connection (CREATE INDEX CONCURRENTLY cannot share a
 *  simple-query transaction). Pattern: topology-foundation.integration.test.ts. */
async function replayNoTransaction(file: string): Promise<void> {
  const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    for (const statement of splitSqlStatements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))) {
      await admin.unsafe(statement);
    }
  } finally { await admin.end(); }
}

async function insertEntry(
  f: { partnerId: string; userId: string },
  o: { orgId: string | null; lineId: string | null; billingStatus?: string },
): Promise<Array<{ id: string }>> {
  return await getTestDb().execute(sql`
    INSERT INTO time_entries
      (partner_id, org_id, user_id, started_at, ended_at, duration_minutes, currency_code, billing_status, contract_line_id)
    VALUES
      (${f.partnerId}::uuid, ${o.orgId}::uuid, ${f.userId}::uuid, '2026-12-03T09:00:00'::timestamp, '2026-12-03T10:00:00'::timestamp,
       60, ${o.orgId === null ? null : 'USD'}, ${o.billingStatus ?? 'contract'}::billing_status, ${o.lineId}::uuid)
    RETURNING id
  `) as unknown as Array<{ id: string }>;
}

describe('time_entries.contract_line_id (real DB) #4547 W01', () => {
  it('accepts a contract-status entry that names a line of its own org', async () => {
    const f = await seedLedger();
    await expect(insertEntry(f, { orgId: f.orgA, lineId: f.lineA })).resolves.toHaveLength(1);
    // And an ordinary entry with no line is untouched by any of this.
    await expect(insertEntry(f, { orgId: f.orgA, lineId: null, billingStatus: 'not_billed' })).resolves.toHaveLength(1);
  });

  it('rejects a line id with a NULL org (the composite FK is MATCH SIMPLE and would skip it)', async () => {
    const f = await seedLedger();
    await expectConstraint(() => insertEntry(f, { orgId: null, lineId: f.lineA }), '23514', [TE_ORG_CHK], 'contract_line_id with org_id NULL');
  });

  it("rejects a line id on an entry that is not 'contract' (the line id is only ever written with the status)", async () => {
    const f = await seedLedger();
    for (const billingStatus of ['not_billed', 'no_charge']) {
      await expectConstraint(() => insertEntry(f, { orgId: f.orgA, lineId: f.lineA, billingStatus }), '23514', [TE_STATUS_CHK], `billing_status ${billingStatus}`);
    }
  });

  it("rejects another org's line and a line that does not exist", async () => {
    const f = await seedLedger();
    // Entry is org B's (same partner, so time_entries_org_partner_fk passes); the line is org A's.
    await expectConstraint(() => insertEntry(f, { orgId: f.orgB, lineId: f.lineA }), '23503', [TE_FK], "other org's line");
    await expectConstraint(() => insertEntry(f, { orgId: f.orgA, lineId: randomUUID() }), '23503', [TE_FK], 'unknown line');
  });

  it('deleting the line nulls only contract_line_id (the SET NULL column list keeps org_id and the status)', async () => {
    const f = await seedLedger();
    const [e] = await insertEntry(f, { orgId: f.orgA, lineId: f.lineA });
    await getTestDb().execute(sql`DELETE FROM contract_lines WHERE id = ${f.lineA}::uuid`);
    const [row] = await getTestDb().execute(sql`
      SELECT contract_line_id, org_id, billing_status::text AS status FROM time_entries WHERE id = ${e!.id}::uuid
    `) as unknown as Array<{ contract_line_id: string | null; org_id: string; status: string }>;
    expect(row).toEqual({ contract_line_id: null, org_id: f.orgA, status: 'contract' });
  });

  it('all four new composite FKs are DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT conname, condeferrable, condeferred FROM pg_constraint
      WHERE contype = 'f' AND conname IN (
        'contract_hour_periods_contract_org_fk', 'contract_hour_periods_line_org_fk',
        'contract_hour_periods_invoice_org_fk', 'time_entries_contract_line_org_fk')
      ORDER BY conname
    `) as unknown as Array<{ conname: string; condeferrable: boolean; condeferred: boolean }>;
    expect(rows.map((r) => r.conname)).toEqual([
      'contract_hour_periods_contract_org_fk', 'contract_hour_periods_invoice_org_fk',
      'contract_hour_periods_line_org_fk', 'time_entries_contract_line_org_fk',
    ]);
    for (const r of rows) expect(r, r.conname).toMatchObject({ condeferrable: true, condeferred: false });
  });

  it('the NOT VALID constraints were validated, and the partial index is valid', async () => {
    const cons = await getTestDb().execute(sql`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conrelid = 'public.time_entries'::regclass
        AND conname IN ('time_entries_contract_line_org_fk', 'time_entries_contract_line_org_chk', 'time_entries_contract_line_chk')
      ORDER BY conname
    `) as unknown as Array<{ conname: string; convalidated: boolean }>;
    expect(cons).toEqual([
      { conname: 'time_entries_contract_line_chk', convalidated: true },
      { conname: 'time_entries_contract_line_org_chk', convalidated: true },
      { conname: 'time_entries_contract_line_org_fk', convalidated: true },
    ]);
    const [idx] = await getTestDb().execute(sql`
      SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'time_entries_contract_line_idx'
    `) as unknown as Array<{ indisvalid: boolean; def: string }>;
    expect(idx!.indisvalid).toBe(true);
    expect(idx!.def).toMatch(/WHERE \(?contract_line_id IS NOT NULL\)?/);
  });

  it('re-applying the file (statement by statement, as autoMigrate does) is a no-op', async () => {
    const f = await seedLedger();
    const [e] = await insertEntry(f, { orgId: f.orgA, lineId: f.lineA });
    await replayNoTransaction(F_ENTRIES);
    const [row] = await getTestDb().execute(sql`SELECT contract_line_id FROM time_entries WHERE id = ${e!.id}::uuid`) as unknown as Array<{ contract_line_id: string }>;
    expect(row!.contract_line_id).toBe(f.lineA);
    await expectConstraint(() => insertEntry(f, { orgId: null, lineId: f.lineA }), '23514', [TE_ORG_CHK], 'after replay');
  });
});
