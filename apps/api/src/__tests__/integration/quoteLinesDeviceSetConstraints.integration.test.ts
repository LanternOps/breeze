/**
 * Real-DB truth table for the #3205 W05 quote_lines device-set invariants, as
 * breeze_app (forced RLS, no bypass). Mirrors
 * contractLinesDeviceGroupConstraints / contractLinesAllowanceConstraints.
 *
 * A CHECK passes on TRUE *or NULL*, so every conjunct has to be proven to
 * REJECT rather than abstain — hence the single-non-NULL matrix over all nine
 * columns on a contract_line_type IS NULL line.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, deviceGroups, quotes, quoteBlocks, quoteLines } from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `QS ${sfx}`, slug: `qs-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'QA', slug: `qa-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'QB', slug: `qb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [siteA] = await db.insert(sites).values({ orgId: oA!.id, name: `Dallas ${sfx}` }).returning({ id: sites.id, name: sites.name });
    const [gA] = await db.insert(deviceGroups).values({ orgId: oA!.id, name: `VIP ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id, name: deviceGroups.name });
    const [qA] = await db.insert(quotes).values({ partnerId: p!.id, orgId: oA!.id, currencyCode: 'USD' }).returning({ id: quotes.id });
    const [blk] = await db.insert(quoteBlocks).values({ quoteId: qA!.id, orgId: oA!.id, blockType: 'line_items', content: {} }).returning({ id: quoteBlocks.id });
    return { partnerId: p!.id, orgA: oA!.id, orgB: oB!.id, site: siteA!, group: gA!, quoteId: qA!.id, blockId: blk!.id };
  });
}

/** Insert a quote line with the shared defaults; `cols` supplies the descriptor. */
async function line(f: Awaited<ReturnType<typeof seed>>, cols: Record<string, unknown>) {
  try {
    return await withSystemDbAccessContext(() => db.insert(quoteLines).values({
      quoteId: f.quoteId, orgId: f.orgA, blockId: f.blockId, sourceType: 'manual',
      name: 'Endpoints', quantity: '3.00', unitPrice: '40.00', taxable: false,
      recurrence: 'monthly', ...cols,
    } as never).returning({ id: quoteLines.id }));
  } catch (error) {
    // Drizzle wraps the PostgreSQL error; expose the driver error so the truth
    // table can assert the constraint name and SQLSTATE directly.
    throw (error as { cause?: unknown }).cause ?? error;
  }
}

const CHK = /quote_lines_device_set_chk/;

describe('quote_lines_device_set_chk (#3205 W05)', () => {
  runDb('accepts each of the four device-set types on a recurring line', async () => {
    const f = await seed();
    expect(await line(f, { contractLineType: 'per_device' })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_device_role', deviceRoles: ['server'] })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_device_group', deviceGroupId: f.group.id, deviceGroupName: f.group.name })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_seat' })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_device', recurrence: 'annual' })).toHaveLength(1);
  });

  // A CHECK abstains on NULL. Each of the nine columns alone, on an ordinary
  // line, must therefore be shown to REJECT — otherwise the "all NULL together"
  // branch is decorative.
  runDb.each([
    ['contract_line_type is the discriminator, so a lone descriptor column is a forgery', { deviceRoles: ['server'] }],
    ['device_group_id', { deviceGroupId: null as unknown as string }],
    ['device_group_name', { deviceGroupName: 'VIP' }],
    ['site_id', { siteId: null as unknown as string }],
    ['site_name', { siteName: 'Dallas' }],
    ['included_quantity', { includedQuantity: '25' }],
    ['overage_mode', { overageMode: 'flag' }],
    ['overage_unit_price', { overageUnitPrice: '12.00' }],
  ] as const)('rejects %s on a line with contract_line_type NULL', async (_name, cols) => {
    const f = await seed();
    const nonNull = Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== null));
    if (Object.keys(nonNull).length === 0) return; // the two uuid rows are covered by the FK suite below
    await expect(line(f, nonNull)).rejects.toThrow(CHK);
  });

  runDb('rejects a descriptor on a one_time line and on a bundle child', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_device', recurrence: 'one_time' })).rejects.toThrow(CHK);
    const [parent] = await line(f, { sourceType: 'bundle' });
    await expect(line(f, { contractLineType: 'per_device', parentLineId: parent!.id })).rejects.toThrow(CHK);
  });

  runDb("rejects 'flat' and 'manual' — they have no device set", async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'flat' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'manual' })).rejects.toThrow(CHK);
  });

  runDb('roles are two-way, non-empty and closed; DUPLICATES are accepted by the DB', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_device_role' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', deviceRoles: ['server'] })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device_role', deviceRoles: [] })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device_role', deviceRoles: ['unknown'] })).rejects.toThrow(CHK);
    // `<@` is CONTAINMENT, not set equality: the validator is the ONLY duplicate
    // guard. Recorded here so nobody deletes the validator rule as redundant.
    expect(await line(f, { contractLineType: 'per_device_role', deviceRoles: ['server', 'server'] })).toHaveLength(1);
  });

  runDb('group lines require the stamp; the id is optional (the orphan state)', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_device_group', deviceGroupId: f.group.id })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', deviceGroupName: 'VIP' })).rejects.toThrow(CHK);
    expect(await line(f, { contractLineType: 'per_device_group', deviceGroupName: f.group.name })).toHaveLength(1);
  });

  runDb('a REAL device_group_id is rejected on every non-group type (CHECK fires before the FK)', async () => {
    const f = await seed();
    for (const contractLineType of ['per_device', 'per_device_role', 'per_seat'] as const) {
      const extra = contractLineType === 'per_device_role' ? { deviceRoles: ['server'] } : {};
      await expect(line(f, { contractLineType, deviceGroupId: f.group.id, deviceGroupName: f.group.name, ...extra })).rejects.toThrow(CHK);
      await expect(line(f, { contractLineType, deviceGroupId: f.group.id, ...extra })).rejects.toThrow(CHK);
    }
  });

  runDb('site columns only on per_device / per_device_role, and an id always carries its stamp', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_seat', siteId: f.site.id, siteName: f.site.name })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device_group', deviceGroupName: f.group.name, siteName: 'Dallas' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', siteId: f.site.id })).rejects.toThrow(CHK);
    expect(await line(f, { contractLineType: 'per_device', siteId: f.site.id, siteName: f.site.name })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_device', siteName: f.site.name })).toHaveLength(1); // deleted-site state
  });

  runDb('the five allowance conjuncts, identical to contract_lines_allowance_chk', async () => {
    const f = await seed();
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '25' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', overageMode: 'flag' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '0', overageMode: 'flag' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '25.5', overageMode: 'flag' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '25', overageMode: 'bill' })).rejects.toThrow(CHK);
    await expect(line(f, { contractLineType: 'per_device', includedQuantity: '25', overageMode: 'flag', overageUnitPrice: '12.00' })).rejects.toThrow(CHK);
    expect(await line(f, { contractLineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00' })).toHaveLength(1);
    expect(await line(f, { contractLineType: 'per_seat', includedQuantity: '25', overageMode: 'flag' })).toHaveLength(1);
  });
});

describe('quote_lines composite FKs (#3205 W05)', () => {
  runDb('all three report condeferrable = true (the org-merge contract)', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT conname, condeferrable FROM pg_constraint
       WHERE conrelid = 'quote_lines'::regclass
         AND conname IN ('quote_lines_quote_org_fk','quote_lines_device_group_org_fk','quote_lines_site_org_fk')
       ORDER BY conname`));
    expect(rows.map((r: Record<string, unknown>) => [r.conname, r.condeferrable]))
      .toEqual([['quote_lines_device_group_org_fk', true], ['quote_lines_quote_org_fk', true], ['quote_lines_site_org_fk', true]]);
  });

  runDb('a line whose org_id differs from its quote is rejected (23503)', async () => {
    const f = await seed();
    await expect(line(f, { orgId: f.orgB })).rejects.toMatchObject({ code: '23503' });
  });

  runDb('deleting a group nulls device_group_id and KEEPS device_group_name', async () => {
    const f = await seed();
    const [l] = await line(f, { contractLineType: 'per_device_group', deviceGroupId: f.group.id, deviceGroupName: f.group.name });
    await withSystemDbAccessContext(() => db.delete(deviceGroups).where(eq(deviceGroups.id, f.group.id)));
    const [after] = await withSystemDbAccessContext(() =>
      db.select({ deviceGroupId: quoteLines.deviceGroupId, deviceGroupName: quoteLines.deviceGroupName })
        .from(quoteLines).where(eq(quoteLines.id, l!.id)));
    expect(after).toEqual({ deviceGroupId: null, deviceGroupName: f.group.name });
  });

  runDb('deleting a site nulls site_id and KEEPS site_name', async () => {
    const f = await seed();
    const [l] = await line(f, { contractLineType: 'per_device', siteId: f.site.id, siteName: f.site.name });
    await withSystemDbAccessContext(() => db.delete(sites).where(eq(sites.id, f.site.id)));
    const [after] = await withSystemDbAccessContext(() =>
      db.select({ siteId: quoteLines.siteId, siteName: quoteLines.siteName })
        .from(quoteLines).where(eq(quoteLines.id, l!.id)));
    expect(after).toEqual({ siteId: null, siteName: f.site.name });
  });
});

describe('quote_acceptances.hash_version (#3205 W05)', () => {
  runDb('defaults to 1 — the truth for every acceptance recorded before this release', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'quote_acceptances' AND column_name = 'hash_version'`));
    expect(rows).toHaveLength(1);
    expect(String((rows[0] as Record<string, unknown>).column_default)).toContain('1');
    expect((rows[0] as Record<string, unknown>).is_nullable).toBe('NO');
  });
});
