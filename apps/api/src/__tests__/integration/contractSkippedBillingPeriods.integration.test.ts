/**
 * Partner billing toggle PR 1 (spec 2026-10-16-partner-billing-enabled-design.md
 * §6.1 / Q7 / §11 "Q7 new table"): real-DB proof of contract_skipped_billing_periods
 * (RLS Shape 1, one deferrable composite FK to contracts). Modelled on
 * contractHourBlockSchema.integration.test.ts.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { replayMigration } from './replayMigration';

const FILE = '2027-01-05-120100-contract-skipped-billing-periods.sql';
const T = 'contract_skipped_billing_periods';
const FK = 'contract_skipped_billing_periods_contract_org_fk';

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const mk = async (orgId: string) => {
    const id = randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO contracts (id, partner_id, org_id, name, interval_months, start_date, currency_code)
      VALUES (${id}::uuid, ${partner.id}::uuid, ${orgId}::uuid, 'Skipped', 1, '2026-12-01', 'USD')
    `);
    return id;
  };
  return {
    partnerId: partner.id as string,
    orgA: orgA.id as string,
    orgB: orgB.id as string,
    contractA: await mk(orgA.id as string),
    contractB: await mk(orgB.id as string),
  };
}
type F = Awaited<ReturnType<typeof seed>>;
type Exec = { execute: (q: ReturnType<typeof sql>) => PromiseLike<unknown> };

type Opts = {
  contractId: string; orgId: string; start?: string; end?: string;
  reason?: string; note?: string | null;
};
async function insertRow(o: Opts, exec: Exec = getTestDb() as unknown as Exec): Promise<Array<{ id: string }>> {
  const v = { start: '2026-12-01', end: '2027-01-01', reason: 'billing_disabled', note: null, ...o };
  return await exec.execute(sql`
    INSERT INTO contract_skipped_billing_periods (org_id, contract_id, period_start, period_end, reason, resolution_note)
    VALUES (${v.orgId}::uuid, ${v.contractId}::uuid, ${v.start}::date, ${v.end}::date, ${v.reason}, ${v.note})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
}

function pgErrorFields(error: unknown): { code?: string; constraint?: string; message?: string } {
  const wrapped = error as { code?: string; constraint_name?: string; message?: string; cause?: { code?: string; constraint_name?: string; message?: string } } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name, message: node?.message };
}
async function expectConstraint(op: () => Promise<unknown>, code: string, constraint: string, label: string) {
  let raised: unknown;
  try { await op(); } catch (e) { raised = e; }
  if (raised === undefined) throw new Error(`expected ${code} on ${constraint}: ${label}`);
  const f = pgErrorFields(raised);
  expect(f.code, label).toBe(code);
  expect(f.constraint, label).toBe(constraint);
}

const ctxFor = (orgId: string, partnerId: string) =>
  ({ scope: 'organization' as const, orgId, partnerId, accessibleOrgIds: [orgId], userId: null });
const asApp = (f: F, orgId: string) => ctxFor(orgId, f.partnerId);

describe('contract_skipped_billing_periods (real DB) spec §6.1 / Q7', () => {
  it('Q7: unique (contract_id, period_start); a second period of the same contract is fine', async () => {
    const f = await seed();
    const base = { contractId: f.contractA, orgId: f.orgA };
    await expect(insertRow(base)).resolves.toHaveLength(1);
    await expectConstraint(() => insertRow(base), '23505', 'contract_skipped_billing_periods_contract_period_uq', 'duplicate period');
    await expect(insertRow({ ...base, start: '2027-01-01', end: '2027-02-01' })).resolves.toHaveLength(1);
  });

  it('Q7: period boundaries are half-open and must be valid (23514)', async () => {
    const f = await seed();
    const base = { contractId: f.contractA, orgId: f.orgA };
    await expectConstraint(() => insertRow({ ...base, end: '2026-12-01' }), '23514', 'contract_skipped_billing_periods_period_chk', 'end = start');
    await expectConstraint(() => insertRow({ ...base, end: '2026-11-01' }), '23514', 'contract_skipped_billing_periods_period_chk', 'end < start');
  });

  it('Q7: reason is restricted to billing_disabled and has no default; note is capped at 2000 chars', async () => {
    const f = await seed();
    const base = { contractId: f.contractA, orgId: f.orgA };
    await expectConstraint(() => insertRow({ ...base, reason: 'other' }), '23514', 'contract_skipped_billing_periods_reason_chk', 'unknown reason');
    let omitted: unknown;
    try {
      await getTestDb().execute(sql`
        INSERT INTO contract_skipped_billing_periods (org_id, contract_id, period_start, period_end)
        VALUES (${f.orgA}::uuid, ${f.contractA}::uuid, '2026-12-01', '2027-01-01')`);
    } catch (e) { omitted = e; }
    expect(pgErrorFields(omitted).code, 'reason omitted => NOT NULL violation, no default').toBe('23502');
    await expect(insertRow({ ...base, note: 'x'.repeat(2000) })).resolves.toHaveLength(1);
    await expectConstraint(() => insertRow({ ...base, start: '2027-01-01', end: '2027-02-01', note: 'x'.repeat(2001) }),
      '23514', 'contract_skipped_billing_periods_note_chk', 'note too long');
  });

  it('Q7: resolved defaults to false and carries no resolved_by / resolved_at / billing_resumed_at columns', async () => {
    const f = await seed();
    await insertRow({ contractId: f.contractA, orgId: f.orgA });
    const [row] = await getTestDb().execute(sql`SELECT resolved, resolution_note FROM contract_skipped_billing_periods`) as unknown as Array<{ resolved: boolean; resolution_note: string | null }>;
    expect(row).toEqual({ resolved: false, resolution_note: null });
    const cols = await getTestDb().execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${T} ORDER BY column_name
    `) as unknown as Array<{ column_name: string }>;
    expect(cols.map((c) => c.column_name)).toEqual([
      'contract_id', 'created_at', 'id', 'org_id', 'period_end', 'period_start', 'reason', 'resolution_note', 'resolved',
    ]);
  });

  it('Q7: a row for org B pointing at org A\'s contract is rejected by the composite FK (23503), as system context', async () => {
    const f = await seed();
    await expectConstraint(() => insertRow({ contractId: f.contractA, orgId: f.orgB }), '23503', FK, 'contract from another org');
  });

  it('Q7: the composite FK is DEFERRABLE INITIALLY IMMEDIATE with ON DELETE CASCADE', async () => {
    const [fk] = await getTestDb().execute(sql`
      SELECT condeferrable, condeferred, confdeltype::text AS del FROM pg_constraint
      WHERE conrelid = 'public.contract_skipped_billing_periods'::regclass AND conname = ${FK}
    `) as unknown as Array<{ condeferrable: boolean; condeferred: boolean; del: string }>;
    expect(fk).toEqual({ condeferrable: true, condeferred: false, del: 'c' });
  });

  it('Q7: deleting the contract cascades its ledger rows', async () => {
    const f = await seed();
    await insertRow({ contractId: f.contractA, orgId: f.orgA });
    await getTestDb().execute(sql`DELETE FROM contracts WHERE id = ${f.contractA}::uuid`);
    const [n] = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM contract_skipped_billing_periods`) as unknown as Array<{ n: number }>;
    expect(n!.n).toBe(0);
  });

  it('Q7: RLS is enabled and forced with the four org-isolation policies and breeze_app grants', async () => {
    const [cls] = await getTestDb().execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.contract_skipped_billing_periods'::regclass
    `) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(cls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await getTestDb().execute(sql`
      SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = ${T} ORDER BY policyname
    `) as unknown as Array<{ policyname: string; cmd: string }>;
    expect(policies).toEqual([
      { policyname: 'breeze_org_isolation_delete', cmd: 'DELETE' },
      { policyname: 'breeze_org_isolation_insert', cmd: 'INSERT' },
      { policyname: 'breeze_org_isolation_select', cmd: 'SELECT' },
      { policyname: 'breeze_org_isolation_update', cmd: 'UPDATE' },
    ]);
    const grants = await getTestDb().execute(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = ${T} AND grantee = 'breeze_app'
    `) as unknown as Array<{ privilege_type: string }>;
    expect(grants.map((g) => g.privilege_type)).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'UPDATE']));
  });

  it('Q7 as breeze_app: cross-org insert is 42501; cross-org select is empty; cross-org update/delete touch no rows', async () => {
    const f = await seed();
    await withDbAccessContext(asApp(f, f.orgA), () => insertRow({ contractId: f.contractA, orgId: f.orgA }, db as unknown as Exec));
    await withDbAccessContext(asApp(f, f.orgB), () => insertRow({ contractId: f.contractB, orgId: f.orgB }, db as unknown as Exec));

    let raised: unknown;
    try {
      await withDbAccessContext(asApp(f, f.orgA), () => insertRow({ contractId: f.contractB, orgId: f.orgB }, db as unknown as Exec));
    } catch (e) { raised = e; }
    expect(raised, 'forced RLS must reject the forged row').toBeDefined();
    const fields = pgErrorFields(raised);
    expect(fields.code).toBe('42501');
    expect(fields.message).toMatch(/new row violates row-level security policy/);

    const seenByA = await withDbAccessContext(asApp(f, f.orgA), () => db.execute(sql`SELECT org_id FROM contract_skipped_billing_periods`)) as unknown as Array<{ org_id: string }>;
    expect(seenByA.map((r) => r.org_id)).toEqual([f.orgA]);

    // Org A tries to mutate org B's row: RLS hides it, so zero rows change.
    const upd = await withDbAccessContext(asApp(f, f.orgA), () => db.execute(sql`
      UPDATE contract_skipped_billing_periods SET resolved = true WHERE org_id = ${f.orgB}::uuid RETURNING id`)) as unknown as unknown[];
    expect(upd).toHaveLength(0);
    const del = await withDbAccessContext(asApp(f, f.orgA), () => db.execute(sql`
      DELETE FROM contract_skipped_billing_periods WHERE org_id = ${f.orgB}::uuid RETURNING id`)) as unknown as unknown[];
    expect(del).toHaveLength(0);
    const [b] = await getTestDb().execute(sql`SELECT resolved FROM contract_skipped_billing_periods WHERE org_id = ${f.orgB}::uuid`) as unknown as Array<{ resolved: boolean }>;
    expect(b).toEqual({ resolved: false });

    // Own-org resolve (flag + note) works.
    const own = await withDbAccessContext(asApp(f, f.orgA), () => db.execute(sql`
      UPDATE contract_skipped_billing_periods SET resolved = true, resolution_note = 'reviewed' WHERE org_id = ${f.orgA}::uuid RETURNING id`)) as unknown as unknown[];
    expect(own).toHaveLength(1);
  });

  it('Q7 org merge contract: under SET CONSTRAINTS ALL DEFERRED, repointing parent then child org_id succeeds without 23503', async () => {
    const f = await seed();
    await insertRow({ contractId: f.contractA, orgId: f.orgA });
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`UPDATE contracts SET org_id = ${f.orgB}::uuid WHERE id = ${f.contractA}::uuid`);
      await tx.execute(sql`UPDATE contract_skipped_billing_periods SET org_id = ${f.orgB}::uuid WHERE contract_id = ${f.contractA}::uuid`);
    });
    const [r] = await getTestDb().execute(sql`SELECT org_id FROM contract_skipped_billing_periods WHERE contract_id = ${f.contractA}::uuid`) as unknown as Array<{ org_id: string }>;
    expect(r!.org_id).toBe(f.orgB);
  });

  it('Q7: re-applying the migration is a no-op (row survives; policies, FK and unique index unchanged)', async () => {
    const f = await seed();
    await insertRow({ contractId: f.contractA, orgId: f.orgA });
    await replayMigration(FILE);
    const [n] = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM contract_skipped_billing_periods`) as unknown as Array<{ n: number }>;
    expect(n!.n).toBe(1);
    const [fk] = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.contract_skipped_billing_periods'::regclass AND conname = ${FK} AND condeferrable AND NOT condeferred
    `) as unknown as Array<{ n: number }>;
    expect(fk!.n).toBe(1);
    const [pol] = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ${T}`) as unknown as Array<{ n: number }>;
    expect(pol!.n).toBe(4);
    await expectConstraint(() => insertRow({ contractId: f.contractA, orgId: f.orgA }), '23505', 'contract_skipped_billing_periods_contract_period_uq', 'unique after replay');
  });
});
