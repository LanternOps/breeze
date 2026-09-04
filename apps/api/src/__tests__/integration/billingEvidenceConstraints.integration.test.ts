/**
 * #3205 W07 / #4656 — real-DB truth table for the billing-evidence constraints.
 * Mirrors contractLinesDeviceGroupConstraints (W02). Every assertion here is a
 * property the MIGRATIONS own, not the service layer.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, contracts, contractBillingPeriods, invoices, invoiceLines } from '../../db/schema';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `EV ${sfx}`, slug: `ev-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'EA', slug: `ea-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'EB', slug: `eb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [siteA] = await db.insert(sites).values({ orgId: oA!.id, name: `SA-${sfx}` }).returning({ id: sites.id });
    const [siteB] = await db.insert(sites).values({ orgId: oB!.id, name: `SB-${sfx}` }).returning({ id: sites.id });
    // devices.site_id is NOT NULL.
    const [devA] = await db.insert(devices).values({
      orgId: oA!.id, siteId: siteA!.id, agentId: `agent-a-${sfx}`, hostname: 'alpha-01',
      status: 'online', deviceRole: 'server', osType: 'linux', osVersion: '22.04',
      architecture: 'x86_64', agentVersion: '0.99.0',
    }).returning({ id: devices.id });
    const [cA] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: oA!.id, name: 'CA', intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    const [invA] = await db.insert(invoices).values({
      partnerId: p!.id, orgId: oA!.id, currencyCode: 'USD', status: 'draft',
    }).returning({ id: invoices.id });
    const [invB] = await db.insert(invoices).values({
      partnerId: p!.id, orgId: oB!.id, currencyCode: 'USD', status: 'draft',
    }).returning({ id: invoices.id });
    const [lineA] = await db.insert(invoiceLines).values({
      invoiceId: invA!.id, orgId: oA!.id, sourceType: 'contract', description: 'Endpoints',
      quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00',
    }).returning({ id: invoiceLines.id });
    const [lineB] = await db.insert(invoiceLines).values({
      invoiceId: invB!.id, orgId: oB!.id, sourceType: 'contract', description: 'Other org',
      quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00',
    }).returning({ id: invoiceLines.id });
    const [perA] = await db.insert(contractBillingPeriods).values({
      contractId: cA!.id, orgId: oA!.id, periodStart: '2026-07-01', periodEnd: '2026-07-31', invoiceId: invA!.id,
    }).returning({ id: contractBillingPeriods.id });
    return {
      orgA: oA!.id, orgB: oB!.id, siteA: siteA!.id, siteB: siteB!.id, devA: devA!.id,
      contractA: cA!.id, invA: invA!.id, invB: invB!.id, lineA: lineA!.id, lineB: lineB!.id, periodA: perA!.id,
    };
  });
}

type F = Awaited<ReturnType<typeof seed>>;

function insertEvidence(f: F, o: {
  lineId?: string; invoiceId?: string; orgId?: string; deviceId?: string | null;
  hostname?: string; siteId?: string | null; countedAs?: string;
}) {
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, device_id, hostname, device_role, site_id, counted_as)
    VALUES (${o.lineId ?? f.lineA}::uuid, ${o.invoiceId ?? f.invA}::uuid, ${o.orgId ?? f.orgA}::uuid,
            ${o.deviceId === undefined ? f.devA : o.deviceId}::uuid, ${o.hostname ?? 'alpha-01'}, 'server',
            ${o.siteId === undefined ? f.siteA : o.siteId}::uuid, ${o.countedAs ?? 'included'}::invoice_line_device_counted_as)
    RETURNING id
  `));
}

function insertOutcome(f: F, o: { periodId?: string; orgId?: string; contractId?: string; invoiceId?: string | null }) {
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO contract_billing_period_outcomes (contract_billing_period_id, org_id, contract_id, invoice_id)
    VALUES (${o.periodId ?? f.periodA}::uuid, ${o.orgId ?? f.orgA}::uuid, ${o.contractId ?? f.contractA}::uuid,
            ${o.invoiceId === undefined ? f.invA : o.invoiceId}::uuid)
    RETURNING contract_billing_period_id
  `));
}

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

async function expectPgError(operation: () => Promise<unknown>, expected: { code: string; constraint?: string }): Promise<void> {
  try { await operation(); } catch (error) { expect(pgErrorFields(error)).toEqual(expected); return; }
  throw new Error(`expected PostgreSQL ${expected.code}`);
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('billing evidence constraints (real DB) #3205 W07', () => {
  runDb('accepts an ordinary evidence row', async () => {
    const f = await seed();
    await expect(insertEvidence(f, {})).resolves.toBeDefined();
  });

  runDb('composite line FK rejects an invoice line from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertEvidence(f, { lineId: f.lineB }),
      { code: '23503', constraint: 'invoice_line_devices_line_org_fk' },
    );
  });

  runDb('composite invoice FK rejects an invoice from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertEvidence(f, { invoiceId: f.invB }),
      { code: '23503', constraint: 'invoice_line_devices_invoice_org_fk' },
    );
  });

  runDb('composite site FK rejects a site from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertEvidence(f, { siteId: f.siteB }),
      { code: '23503', constraint: 'invoice_line_devices_site_org_fk' },
    );
  });

  runDb('invoice_line_id is NOT NULL', async () => {
    const f = await seed();
    await expectPgError(() => withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, hostname, device_role, counted_as)
      VALUES (NULL, ${f.invA}::uuid, ${f.orgA}::uuid, 'alpha-01', 'server', 'included')
    `)), { code: '23502', constraint: undefined });
  });

  runDb('deleting the device nulls ONLY device_id — org_id and hostname survive (PG15 column list)', async () => {
    const f = await seed();
    await insertEvidence(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM devices WHERE id = ${f.devA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT device_id, org_id, hostname, device_role, site_id FROM invoice_line_devices WHERE invoice_line_id = ${f.lineA}::uuid
    `));
    expect(rows).toEqual([{ device_id: null, org_id: f.orgA, hostname: 'alpha-01', device_role: 'server', site_id: f.siteA }]);
  });

  runDb('deleting the site nulls ONLY site_id (the 23502 regression the column list exists for)', async () => {
    const f = await seed();
    await insertEvidence(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM devices WHERE id = ${f.devA}::uuid`));
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM sites WHERE id = ${f.siteA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT site_id, org_id, hostname FROM invoice_line_devices WHERE invoice_line_id = ${f.lineA}::uuid
    `));
    expect(rows).toEqual([{ site_id: null, org_id: f.orgA, hostname: 'alpha-01' }]);
  });

  runDb('deleting the invoice line cascades its evidence', async () => {
    const f = await seed();
    await insertEvidence(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM invoice_lines WHERE id = ${f.lineA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS n FROM invoice_line_devices`));
    expect(rows).toEqual([{ n: 0 }]);
  });

  runDb('(invoice_line_id, device_id) is unique, and NULL device_ids do not collide', async () => {
    const f = await seed();
    await insertEvidence(f, {});
    await expectPgError(
      () => insertEvidence(f, {}),
      { code: '23505', constraint: 'invoice_line_devices_line_device_uq' },
    );
    await expect(insertEvidence(f, { deviceId: null, hostname: 'gone-1' })).resolves.toBeDefined();
    await expect(insertEvidence(f, { deviceId: null, hostname: 'gone-2' })).resolves.toBeDefined();
  });

  runDb('outcome: deleting the billing period cascades the outcome row', async () => {
    const f = await seed();
    await insertOutcome(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM contract_billing_periods WHERE id = ${f.periodA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS n FROM contract_billing_period_outcomes`));
    expect(rows).toEqual([{ n: 0 }]);
  });

  runDb('outcome: deleting the draft invoice nulls ONLY invoice_id and keeps the outcome row', async () => {
    const f = await seed();
    await insertOutcome(f, {});
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM invoices WHERE id = ${f.invA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT invoice_id, org_id, contract_id, snapshot_device_total, uncovered_total, flagged_total, billed_overage_total
      FROM contract_billing_period_outcomes
    `));
    expect(rows).toEqual([{
      invoice_id: null, org_id: f.orgA, contract_id: f.contractA,
      snapshot_device_total: 0, uncovered_total: 0, flagged_total: 0, billed_overage_total: 0,
    }]);
  });

  runDb('outcome: the period composite FK rejects a period from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertOutcome(f, { orgId: f.orgB }),
      { code: '23503', constraint: 'cbp_outcomes_period_org_fk' },
    );
  });

  runDb('all six composite FKs are DEFERRABLE and both prerequisite unique indexes exist', async () => {
    await seed();
    const cons = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT conname, condeferrable FROM pg_constraint
      WHERE conrelid IN ('invoice_line_devices'::regclass, 'contract_billing_period_outcomes'::regclass)
        AND contype = 'f'
        AND cardinality(conkey) = 2
      ORDER BY conname
    `));
    expect(cons).toEqual([
      { conname: 'cbp_outcomes_contract_org_fk', condeferrable: true },
      { conname: 'cbp_outcomes_invoice_org_fk', condeferrable: true },
      { conname: 'cbp_outcomes_period_org_fk', condeferrable: true },
      { conname: 'invoice_line_devices_invoice_org_fk', condeferrable: true },
      { conname: 'invoice_line_devices_line_org_fk', condeferrable: true },
      { conname: 'invoice_line_devices_site_org_fk', condeferrable: true },
    ]);
    const idx = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('invoice_lines_id_org_uq', 'contract_billing_periods_id_org_uq')
      ORDER BY indexname
    `));
    expect(idx).toEqual([{ indexname: 'contract_billing_periods_id_org_uq' }, { indexname: 'invoice_lines_id_org_uq' }]);
  });

  runDb('both tables have forced RLS, four policies each, and the breeze_app grants', async () => {
    await seed();
    const rls = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('invoice_line_devices', 'contract_billing_period_outcomes') ORDER BY relname
    `));
    expect(rls).toEqual([
      { relname: 'contract_billing_period_outcomes', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'invoice_line_devices', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const pol = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT tablename, count(*)::int AS n FROM pg_policies
      WHERE tablename IN ('invoice_line_devices', 'contract_billing_period_outcomes')
      GROUP BY tablename ORDER BY tablename
    `));
    expect(pol).toEqual([
      { tablename: 'contract_billing_period_outcomes', n: 4 },
      { tablename: 'invoice_line_devices', n: 4 },
    ]);
    const grants = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
      FROM information_schema.role_table_grants
      WHERE grantee = 'breeze_app' AND table_name IN ('invoice_line_devices', 'contract_billing_period_outcomes')
        AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      GROUP BY table_name ORDER BY table_name
    `));
    expect(grants).toEqual([
      { table_name: 'contract_billing_period_outcomes', privs: 'DELETE,INSERT,SELECT,UPDATE' },
      { table_name: 'invoice_line_devices', privs: 'DELETE,INSERT,SELECT,UPDATE' },
    ]);
  });
});
