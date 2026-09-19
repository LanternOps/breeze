/**
 * Real-DB truth table for the #3205 W02 contract_lines device-group invariants,
 * as breeze_app (forced RLS, no bypass). Mirrors contractLinesDeviceRolesConstraints.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, contracts, deviceGroups } from '../../db/schema';

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `GP ${sfx}`, slug: `gp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'GA', slug: `ga-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'GB', slug: `gb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [siteA] = await db.insert(sites).values({ orgId: oA!.id, name: `A-${sfx}` }).returning({ id: sites.id });
    const [gA] = await db.insert(deviceGroups).values({ orgId: oA!.id, name: `Group A ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id });
    const [gB] = await db.insert(deviceGroups).values({ orgId: oB!.id, name: `Group B ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id });
    const [cA] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: oA!.id, name: 'CA', intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return { orgA: oA!.id, orgB: oB!.id, siteA: siteA!.id, groupA: gA!.id, groupB: gB!.id, contractA: cA!.id };
  });
}

type F = Awaited<ReturnType<typeof seed>>;

function insertLine(f: F, opts: { lineType: string; orgId?: string; groupId?: string | null; groupName?: string | null; siteId?: string | null }) {
  return withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable, device_group_id, device_group_name, site_id)
    VALUES (${f.contractA}::uuid, ${opts.orgId ?? f.orgA}::uuid, ${opts.lineType}::contract_line_type, 'g', 1.00, false,
            ${opts.groupId ?? null}::uuid, ${opts.groupName ?? null}, ${opts.siteId ?? null}::uuid)
    RETURNING id
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
const CHK = { code: '23514', constraint: 'contract_lines_device_group_chk' };

describe('contract_lines device-group invariants (real DB) #3205 W02', () => {
  runDb('accepts a group line with id + stamped name, and a group line whose group is gone (NULL id, name kept)', async () => {
    const f = await seed();
    await expect(insertLine(f, { lineType: 'per_device_group', groupId: f.groupA, groupName: 'Group A' })).resolves.toBeDefined();
    await expect(insertLine(f, { lineType: 'per_device_group', groupId: null, groupName: 'Deleted group' })).resolves.toBeDefined();
  });

  runDb('rejects a group line without a stamped name', async () => {
    const f = await seed();
    await expectPgError(() => insertLine(f, { lineType: 'per_device_group', groupId: f.groupA, groupName: null }), CHK);
  });

  runDb('rejects a group line with a site_id', async () => {
    const f = await seed();
    await expectPgError(() => insertLine(f, { lineType: 'per_device_group', groupId: f.groupA, groupName: 'Group A', siteId: f.siteA }), CHK);
  });

  runDb('rejects group columns on every other line type', async () => {
    const f = await seed();
    await expectPgError(() => insertLine(f, { lineType: 'flat', groupId: f.groupA, groupName: 'Group A' }), CHK);
    await expectPgError(() => insertLine(f, { lineType: 'per_device', groupName: 'Group A' }), CHK);
  });

  runDb('composite group FK rejects a group from another org', async () => {
    const f = await seed();
    await expectPgError(
      () => insertLine(f, { lineType: 'per_device_group', groupId: f.groupB, groupName: 'Group B' }),
      { code: '23503', constraint: 'contract_lines_device_group_org_fk' },
    );
  });

  runDb('composite contract FK rejects a line whose org differs from its contract', async () => {
    const f = await seed();
    await expectPgError(
      () => insertLine(f, { lineType: 'flat', orgId: f.orgB }),
      { code: '23503', constraint: 'contract_lines_contract_org_fk' },
    );
  });

  runDb('deleting the group nulls device_group_id and keeps device_group_name', async () => {
    const f = await seed();
    await insertLine(f, { lineType: 'per_device_group', groupId: f.groupA, groupName: 'Group A' });
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM device_groups WHERE id = ${f.groupA}::uuid`));
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT device_group_id, device_group_name FROM contract_lines WHERE contract_id = ${f.contractA}::uuid
    `));
    expect(rows).toEqual([{ device_group_id: null, device_group_name: 'Group A' }]);
  });

  runDb('both composite FKs are deferrable and the (id, org_id) unique index exists', async () => {
    await seed();
    const cons = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT conname, condeferrable FROM pg_constraint
      WHERE conrelid = 'contract_lines'::regclass
        AND conname IN ('contract_lines_device_group_org_fk', 'contract_lines_contract_org_fk')
      ORDER BY conname
    `));
    expect(cons).toEqual([
      { conname: 'contract_lines_contract_org_fk', condeferrable: true },
      { conname: 'contract_lines_device_group_org_fk', condeferrable: true },
    ]);
    const idx = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'device_groups' AND indexname = 'device_groups_id_org_id_uniq'
    `));
    expect(idx).toHaveLength(1);
  });
});
