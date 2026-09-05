/**
 * #3205 — contract_lines_device_roles_chk and contract_lines_site_org_fk,
 * exercised with raw SQL as breeze_app so the DATABASE (not Zod) is what
 * rejects each malformed row. Codes: 23514 check_violation, 23503 foreign_key_violation.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { BILLABLE_DEVICE_ROLES } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, contracts } from '../../db/schema';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `KP ${sfx}`, slug: `kp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'KA', slug: `ka-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'KB', slug: `kb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [siteA] = await db.insert(sites).values({ orgId: oA!.id, name: `A-${sfx}` }).returning({ id: sites.id });
    const [siteB] = await db.insert(sites).values({ orgId: oB!.id, name: `B-${sfx}` }).returning({ id: sites.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: oA!.id, name: 'K', intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return { orgA: oA!.id, siteA: siteA!.id, siteB: siteB!.id, contractId: c!.id };
  });
}

function insertLine(f: { orgA: string; contractId: string }, lineType: string, rolesSql: ReturnType<typeof sql>, siteId: string | null = null) {
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable, device_roles, site_id, site_name)
    VALUES (${f.contractId}::uuid, ${f.orgA}::uuid, ${lineType}::contract_line_type, 'k', 1.00, false, ${rolesSql}, ${siteId}::uuid, ${siteId === null ? null : 'Site'})
  `));
}

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as {
    code?: string;
    constraint_name?: string;
    cause?: { code?: string; constraint_name?: string };
  } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

async function expectPgError(
  operation: () => Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(pgErrorFields(error)).toEqual(expected);
    return;
  }
  throw new Error(`expected PostgreSQL ${expected.code}`);
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('contract_lines device-role invariants (real DB) #3205', () => {
  runDb('the CHECK role list is exactly BILLABLE_DEVICE_ROLES (shared SSOT — widen both or neither)', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'contract_lines_device_roles_chk'`));
    const def = (rows as unknown as Array<{ def: string }>)[0]!.def;
    const arrayLiteral = /ARRAY\[([^\]]*)\]/.exec(def)![1]!;
    const dbRoles = [...arrayLiteral.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(dbRoles).toEqual([...BILLABLE_DEVICE_ROLES].sort());
  });

  runDb('accepts a valid role set on per_device_role and NULL on other types', async () => {
    const f = await seed();
    await expect(insertLine(f, 'per_device_role', sql`ARRAY['server','nas']::text[]`)).resolves.toBeDefined();
    await expect(insertLine(f, 'flat', sql`NULL`)).resolves.toBeDefined();
  });

  runDb.each([
    ['NULL roles on a role line', 'per_device_role', sql`NULL`],
    ['empty array on a role line', 'per_device_role', sql`ARRAY[]::text[]`],
    ['a NULL element', 'per_device_role', sql`ARRAY['server', NULL]::text[]`],
    ["'unknown'", 'per_device_role', sql`ARRAY['unknown']::text[]`],
    ['an unrecognised role', 'per_device_role', sql`ARRAY['mainframe']::text[]`],
    ['a 2-D array', 'per_device_role', sql`ARRAY[['server']]::text[]`],
    ['an empty array on a flat line', 'flat', sql`ARRAY[]::text[]`],
    ['roles on a per_device line', 'per_device', sql`ARRAY['server']::text[]`],
  ])('rejects %s with 23514', async (_name, lineType, rolesSql) => {
    const f = await seed();
    await expectPgError(
      () => insertLine(f, lineType, rolesSql),
      { code: '23514', constraint: 'contract_lines_device_roles_chk' },
    );
  });

  runDb('rejects a site owned by another org with 23503 (composite FK)', async () => {
    const f = await seed();
    await expectPgError(
      () => insertLine(f, 'per_device', sql`NULL`, f.siteB),
      { code: '23503', constraint: 'contract_lines_site_org_fk' },
    );
    await expect(insertLine(f, 'per_device', sql`NULL`, f.siteA)).resolves.toBeDefined();
  });

  runDb('deleting a site nulls only site_id on its lines (org_id survives)', async () => {
    const f = await seed();
    await insertLine(f, 'per_device_role', sql`ARRAY['server']::text[]`, f.siteA);
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM sites WHERE id = ${f.siteA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT site_id, org_id FROM contract_lines WHERE contract_id = ${f.contractId}::uuid`));
    expect((rows as unknown as Array<{ site_id: string | null; org_id: string }>)[0]).toEqual({ site_id: null, org_id: f.orgA });
  });
});
