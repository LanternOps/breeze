/**
 * catalog_item_prices RLS — partner-axis (shape 3) enforcement for the
 * multi-currency wave 3 price book (#3775, spec §6 / §14).
 *
 * Migration under test: 2026-08-29-a-catalog-item-prices.sql.
 *
 * The rls-coverage contract test proves a *policy string* mentions
 * breeze_has_partner_access; it does NOT prove the branch behaves. This
 * functional suite runs through the REAL postgres.js driver as `breeze_app`:
 *   (a) partner B context reading partner A's price row -> 0 rows
 *   (b) forged INSERT under partner B with partnerId=partnerA -> 42501
 *   (c) partner B UPDATE/DELETE of the A row -> 0 rows affected
 *   (d) system INSERT (itemA, partnerB) -> 23503: the composite FK
 *       (item_id, partner_id) -> catalog_items(id, partner_id) rejects a
 *       foreign partner even for system writers
 *   (e) org A context INSERT -> 42501 (org tokens never write the price book)
 *   (f) deleting the catalog item cascades the price rows
 *   (g) POSITIVE proof: partner A sees its row, can insert a second currency,
 *       update it and delete it (an over-restrictive policy must fail too)
 *   (h) system context can insert a price row
 *
 * Fixture is re-seeded fresh per test: setup.ts's beforeEach TRUNCATE ...
 * CASCADEs partners/organizations, which wipes every catalog row, so a
 * module-level cache would make the assertions vacuous (see
 * catalog-rls.integration.test.ts for the full rationale).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { catalogItemPrices, catalogItems } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  itemA: { id: string };
  priceA: { id: string };
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    // Task 2 adds cost_currency to catalog_items and sweeps this fixture.
    const [itemA] = await db
      .insert(catalogItems)
      .values({
        partnerId: partnerA.id,
        itemType: 'service',
        name: 'A-only service',
        unitPrice: '10.00',
      })
      .returning({ id: catalogItems.id });
    if (!itemA) throw new Error('failed to seed catalog item A');

    const [priceA] = await db
      .insert(catalogItemPrices)
      .values({
        itemId: itemA.id,
        partnerId: partnerA.id,
        currencyCode: 'USD',
        unitPrice: '10.00',
      })
      .returning({ id: catalogItemPrices.id });
    if (!priceA) throw new Error('failed to seed price row A');

    return { partnerA, orgA, partnerB, orgB, itemA, priceA };
  });
}

describe('catalog_item_prices partner-axis RLS', () => {
  runDb('(a) partner B context cannot read partner A price rows', async () => {
    const f = await seedFixture();
    const rows = await withDbAccessContext(partnerContext(f.partnerB.id, [f.orgB.id]), () =>
      db.select().from(catalogItemPrices).where(eq(catalogItemPrices.itemId, f.itemA.id)),
    );
    expect(rows).toHaveLength(0);
  });

  runDb('(b) forged cross-partner INSERT under partner B is rejected with 42501', async () => {
    const f = await seedFixture();
    await expect(
      withDbAccessContext(partnerContext(f.partnerB.id, [f.orgB.id]), () =>
        db
          .insert(catalogItemPrices)
          .values({
            itemId: f.itemA.id,
            partnerId: f.partnerA.id,
            currencyCode: 'EUR',
            unitPrice: '9.00',
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('(c) partner B UPDATE/DELETE of the A row affects 0 rows', async () => {
    const f = await seedFixture();
    const ctx = partnerContext(f.partnerB.id, [f.orgB.id]);

    const updated = await withDbAccessContext(ctx, () =>
      db
        .update(catalogItemPrices)
        .set({ unitPrice: '1.00' })
        .where(eq(catalogItemPrices.id, f.priceA.id))
        .returning({ id: catalogItemPrices.id }),
    );
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(ctx, () =>
      db
        .delete(catalogItemPrices)
        .where(eq(catalogItemPrices.id, f.priceA.id))
        .returning({ id: catalogItemPrices.id }),
    );
    expect(deleted).toHaveLength(0);

    // The row is still there, untouched, for its owner.
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(catalogItemPrices).where(eq(catalogItemPrices.id, f.priceA.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitPrice).toBe('10.00');
  });

  runDb('(d) composite FK rejects a foreign partner_id even under system scope (23503)', async () => {
    const f = await seedFixture();
    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(catalogItemPrices)
          .values({
            itemId: f.itemA.id,
            partnerId: f.partnerB.id,
            currencyCode: 'EUR',
            unitPrice: '9.00',
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('(e) org tokens never write the price book (42501)', async () => {
    const f = await seedFixture();
    await expect(
      withDbAccessContext(orgContext(f.orgA.id), () =>
        db
          .insert(catalogItemPrices)
          .values({
            itemId: f.itemA.id,
            partnerId: f.partnerA.id,
            currencyCode: 'EUR',
            unitPrice: '9.00',
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('(f) deleting the catalog item cascades its price rows', async () => {
    const f = await seedFixture();
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(catalogItems).where(eq(catalogItems.id, f.itemA.id)),
    );
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(catalogItemPrices).where(eq(catalogItemPrices.itemId, f.itemA.id)),
    );
    expect(rows).toHaveLength(0);
  });

  runDb('(g) positive proof: partner A reads, inserts, updates and deletes its own rows', async () => {
    const f = await seedFixture();
    const ctx = partnerContext(f.partnerA.id, [f.orgA.id]);

    const visible = await withDbAccessContext(ctx, () =>
      db.select().from(catalogItemPrices).where(eq(catalogItemPrices.itemId, f.itemA.id)),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]!.currencyCode).toBe('USD');

    const inserted = await withDbAccessContext(ctx, () =>
      db
        .insert(catalogItemPrices)
        .values({
          itemId: f.itemA.id,
          partnerId: f.partnerA.id,
          currencyCode: 'EUR',
          unitPrice: '9.00',
        })
        .returning(),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.currencyCode).toBe('EUR');
    expect(inserted[0]!.unitPrice).toBe('9.00');

    const updated = await withDbAccessContext(ctx, () =>
      db
        .update(catalogItemPrices)
        .set({ unitPrice: '8.50' })
        .where(
          and(eq(catalogItemPrices.itemId, f.itemA.id), eq(catalogItemPrices.currencyCode, 'EUR')),
        )
        .returning({ unitPrice: catalogItemPrices.unitPrice }),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]!.unitPrice).toBe('8.50');

    const deleted = await withDbAccessContext(ctx, () =>
      db
        .delete(catalogItemPrices)
        .where(
          and(eq(catalogItemPrices.itemId, f.itemA.id), eq(catalogItemPrices.currencyCode, 'EUR')),
        )
        .returning({ id: catalogItemPrices.id }),
    );
    expect(deleted).toHaveLength(1);
  });

  runDb('(h) system context can insert a price row for the owning partner', async () => {
    const f = await seedFixture();
    const inserted = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(catalogItemPrices)
        .values({
          itemId: f.itemA.id,
          partnerId: f.partnerA.id,
          currencyCode: 'GBP',
          unitPrice: '7.00',
        })
        .returning(),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.currencyCode).toBe('GBP');
  });
});
