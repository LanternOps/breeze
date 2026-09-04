/**
 * #3205 W07 — tenant isolation for the two evidence tables, exercised as
 * breeze_app under a real org context (forced RLS, no bypass). Shape 1, so
 * rls-coverage auto-discovers them; this suite proves the policies actually bite.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, invoices, invoiceLines } from '../../db/schema';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `RLS ${sfx}`, slug: `rls-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'RA', slug: `ra-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'RB', slug: `rb-${sfx}` },
    ]).returning({ id: organizations.id });
    await db.insert(sites).values({ orgId: oA!.id, name: `RA-${sfx}` });
    const mk = async (orgId: string, host: string) => {
      const [inv] = await db.insert(invoices)
        .values({ partnerId: p!.id, orgId, currencyCode: 'USD', status: 'draft' })
        .returning({ id: invoices.id });
      const [line] = await db.insert(invoiceLines).values({
        invoiceId: inv!.id, orgId, sourceType: 'contract', description: 'Endpoints',
        quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00',
      }).returning({ id: invoiceLines.id });
      await db.execute(sql`
        INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, device_id, hostname, device_role, counted_as)
        VALUES (${line!.id}::uuid, ${inv!.id}::uuid, ${orgId}::uuid, NULL, ${host}, 'server', 'included')
      `);
      return { invoiceId: inv!.id, lineId: line!.id };
    };
    const a = await mk(oA!.id, 'a-host-01');
    const b = await mk(oB!.id, 'b-host-01');
    return { partnerId: p!.id, orgA: oA!.id, orgB: oB!.id, a, b };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ctxFor = (orgId: string, partnerId: string) =>
  ({ scope: 'organization' as const, orgId, partnerId, accessibleOrgIds: [orgId], userId: null });

async function expectRlsViolation(operation: () => Promise<unknown>): Promise<void> {
  let raised: unknown;
  try {
    await operation();
  } catch (error) {
    raised = error;
  }
  expect(raised, 'expected forced RLS to reject the forged write').toBeDefined();
  const wrapped = raised as { code?: string; cause?: { code?: string; message?: string } };
  expect(wrapped.cause?.code ?? wrapped.code).toBe('42501');
  expect(wrapped.cause?.message).toMatch(/new row violates row-level security policy/);
}

describe('invoice_line_devices tenant isolation (real DB) #3205 W07', () => {
  runDb('a forged insert carrying another org id fails with 42501', async () => {
    const f = await seed();
    await expectRlsViolation(() => withDbAccessContext(ctxFor(f.orgA, f.partnerId), () => db.execute(sql`
      INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, hostname, device_role, counted_as)
      VALUES (${f.b.lineId}::uuid, ${f.b.invoiceId}::uuid, ${f.orgB}::uuid, 'forged', 'server', 'included')
    `)));
  });

  runDb('org B rows are invisible in org A context, and vice versa', async () => {
    const f = await seed();
    const inA = await withDbAccessContext(ctxFor(f.orgA, f.partnerId), () => db.execute(sql`
      SELECT hostname FROM invoice_line_devices ORDER BY hostname
    `));
    expect(inA).toEqual([{ hostname: 'a-host-01' }]);
    const inB = await withDbAccessContext(ctxFor(f.orgB, f.partnerId), () => db.execute(sql`
      SELECT hostname FROM invoice_line_devices ORDER BY hostname
    `));
    expect(inB).toEqual([{ hostname: 'b-host-01' }]);
  });

  runDb('the system context sees both', async () => {
    const f = await seed();
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT hostname FROM invoice_line_devices WHERE org_id IN (${f.orgA}::uuid, ${f.orgB}::uuid) ORDER BY hostname
    `));
    expect(rows).toEqual([{ hostname: 'a-host-01' }, { hostname: 'b-host-01' }]);
  });

  runDb('contract_billing_period_outcomes: a forged cross-org insert fails with 42501', async () => {
    const f = await seed();
    const period = await withSystemDbAccessContext(async () => {
      const rows = await db.execute(sql`
        INSERT INTO contracts (partner_id, org_id, name, interval_months, start_date, currency_code)
        VALUES (${f.partnerId}::uuid, ${f.orgB}::uuid, 'CB', 1, '2026-07-01', 'USD') RETURNING id
      `) as unknown as Array<{ id: string }>;
      const cid = rows[0]!.id;
      const p = await db.execute(sql`
        INSERT INTO contract_billing_periods (contract_id, org_id, period_start, period_end)
        VALUES (${cid}::uuid, ${f.orgB}::uuid, '2026-07-01', '2026-07-31') RETURNING id
      `) as unknown as Array<{ id: string }>;
      return { contractId: cid, periodId: p[0]!.id };
    });
    await expectRlsViolation(() => withDbAccessContext(ctxFor(f.orgA, f.partnerId), () => db.execute(sql`
      INSERT INTO contract_billing_period_outcomes (contract_billing_period_id, org_id, contract_id)
      VALUES (${period.periodId}::uuid, ${f.orgB}::uuid, ${period.contractId}::uuid)
    `)));
  });
});
