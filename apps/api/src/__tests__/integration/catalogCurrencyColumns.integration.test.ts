/**
 * Multi-currency wave 3 (#3775, spec §6) — schema contract for the currency
 * columns added by 2026-08-29-b-catalog-cost-currency-and-org-pricing-currency.sql:
 *
 *   (a) catalog_items.cost_currency is NOT NULL with NO default — an insert
 *       that omits it fails loud (23502), matching organizations.currency_code.
 *   (b) information_schema proves no default + NOT NULL on all three new
 *       columns (cost_currency, org_pricing.currency_code, org_pricing.partner_id).
 *   (c) pg_constraint carries the four FKs: both supported_currencies FKs and
 *       the two composite same-partner FKs on catalog_item_org_pricing.
 *   (d) a forged override (itemA of partnerA, orgB of partnerB, partner_id =
 *       partnerA) is rejected by the composite (org_id, partner_id) FK even
 *       under system context — 23503, structural proof the item, org and
 *       override share one partner.
 *   (e) an off-list cost_currency ('ZZZ') is rejected by the FK — 23503.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { catalogItemOrgPricing, catalogItems } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedItem(partnerId: string, costCurrency = 'USD') {
  const [row] = await db
    .insert(catalogItems)
    .values({
      partnerId,
      itemType: 'service',
      name: 'currency-columns item',
      unitPrice: '10.00',
      costCurrency,
    })
    .returning({ id: catalogItems.id });
  if (!row) throw new Error('failed to seed catalog item');
  return row;
}

interface ColumnMeta {
  column_name: string;
  is_nullable: string;
  column_default: string | null;
}

async function columnMeta(table: string, column: string): Promise<ColumnMeta | undefined> {
  const rows = (await db.execute(sql`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `)) as unknown as ColumnMeta[];
  return rows[0];
}

describe('catalog currency columns (migration 2026-08-29-b)', () => {
  // postgres.js re-throws a failed statement at commit time even when caught
  // inside the transaction, so each forged write gets its own context call and
  // the rejection is asserted on the whole withSystemDbAccessContext.
  runDb('(a) catalog_items insert without cost_currency fails with 23502', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    await expect(
      withSystemDbAccessContext(() =>
        db.insert(catalogItems).values({
          partnerId: partner.id,
          itemType: 'service',
          name: 'no cost currency',
          unitPrice: '1.00',
        } as typeof catalogItems.$inferInsert),
      ),
    ).rejects.toMatchObject({ cause: { code: '23502' } });
  });

  runDb('(b) the three new columns are NOT NULL with no default', async () => {
    const expected: Array<[string, string]> = [
      ['catalog_items', 'cost_currency'],
      ['catalog_item_org_pricing', 'currency_code'],
      ['catalog_item_org_pricing', 'partner_id'],
    ];
    for (const [table, column] of expected) {
      const meta = await columnMeta(table, column);
      expect(meta, `${table}.${column} exists`).toBeDefined();
      expect(meta!.is_nullable, `${table}.${column} NOT NULL`).toBe('NO');
      expect(meta!.column_default, `${table}.${column} has no default`).toBeNull();
    }
  });

  runDb('(c) the currency FKs and composite same-partner FKs exist', async () => {
    const orgPricing = (await db.execute(sql`
      SELECT conname FROM pg_constraint WHERE conrelid = 'catalog_item_org_pricing'::regclass
    `)) as unknown as Array<{ conname: string }>;
    const items = (await db.execute(sql`
      SELECT conname FROM pg_constraint WHERE conrelid = 'catalog_items'::regclass
    `)) as unknown as Array<{ conname: string }>;
    const names = new Set([...orgPricing, ...items].map((r) => r.conname));
    expect(names.has('catalog_items_cost_currency_fkey')).toBe(true);
    expect(names.has('catalog_item_org_pricing_currency_code_fkey')).toBe(true);
    expect(names.has('catalog_item_org_pricing_item_partner_fk')).toBe(true);
    expect(names.has('catalog_item_org_pricing_org_partner_fk')).toBe(true);
  });

  runDb('(d) a forged cross-partner override is rejected by the composite FK even under system context (23503)', async () => {
    const f = await withSystemDbAccessContext(async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const orgB = await createOrganization({ partnerId: partnerB.id });
      const itemA = await seedItem(partnerA.id);
      return { partnerA, partnerB, orgB, itemA };
    });

    // partner_id matches the item, not the org → org_partner_fk rejects.
    await expect(
      withSystemDbAccessContext(() =>
        db.insert(catalogItemOrgPricing).values({
          catalogItemId: f.itemA.id,
          orgId: f.orgB.id,
          partnerId: f.partnerA.id,
          currencyCode: 'USD',
          unitPrice: '5.00',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });

    // Mirror image: partner_id matches the org, not the item → item_partner_fk
    // rejects. No combination lets a foreign org override A's item.
    await expect(
      withSystemDbAccessContext(() =>
        db.insert(catalogItemOrgPricing).values({
          catalogItemId: f.itemA.id,
          orgId: f.orgB.id,
          partnerId: f.partnerB.id,
          currencyCode: 'USD',
          unitPrice: '5.00',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('(e) an off-list cost_currency is rejected by the supported_currencies FK (23503)', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    await expect(withSystemDbAccessContext(() => seedItem(partner.id, 'ZZZ'))).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });

  runDb('positive proof: a same-partner override with a currency inserts', async () => {
    await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const item = await seedItem(partner.id, 'EUR');
      const [override] = await db
        .insert(catalogItemOrgPricing)
        .values({
          catalogItemId: item.id,
          orgId: org.id,
          partnerId: partner.id,
          currencyCode: 'USD',
          unitPrice: '5.00',
        })
        .returning();
      expect(override?.currencyCode).toBe('USD');
      expect(override?.partnerId).toBe(partner.id);
    });
  });
});
