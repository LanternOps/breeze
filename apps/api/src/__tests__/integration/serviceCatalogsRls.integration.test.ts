/**
 * service_catalogs / service_catalog_items — ownership, XOR and RLS (#8325, R1).
 *
 * Migration: 2026-12-28-120000-service-catalog-foundation.sql.
 * Spec: docs/superpowers/specs/ticketing/2026-10-10-service-catalog-design.md §6.1, §6.3.
 *
 * `rls-coverage.integration.test.ts` proves the policies EXIST by reading
 * pg_catalog. This suite drives the real driver as `breeze_app` under FORCE RLS,
 * which is the only thing that proves they enforce anything, and exercises the
 * database constraints (XOR, one catalog per partner, same-owner composite FKs).
 *
 * Statements that must reach a constraint rather than the policy are issued
 * under SYSTEM scope, which short-circuits RLS.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { serviceCatalogs, serviceCatalogItems } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdCatalogIds: string[] = [];

afterEach(async () => {
  const ids = [...new Set(createdCatalogIds)];
  createdCatalogIds.length = 0;
  if (ids.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.delete(serviceCatalogItems).where(inArray(serviceCatalogItems.catalogId, ids));
    await db.delete(serviceCatalogs).where(inArray(serviceCatalogs.id, ids));
  });
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

/** Seed under SYSTEM scope, bypassing the policy under test. */
async function seedCatalog(owner: { partnerId?: string | null; orgId?: string | null }): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(serviceCatalogs)
      .values({
        partnerId: owner.partnerId ?? null,
        orgId: owner.orgId ?? null,
        name: `Catalog ${Math.random().toString(36).slice(2, 10)}`,
      })
      .returning({ id: serviceCatalogs.id }),
  );
  const id = rows[0]!.id;
  createdCatalogIds.push(id);
  return id;
}

async function seedItem(
  catalogId: string,
  owner: { partnerId?: string | null; orgId?: string | null },
): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(serviceCatalogItems)
      .values({
        catalogId,
        partnerId: owner.partnerId ?? null,
        orgId: owner.orgId ?? null,
        name: `Item ${Math.random().toString(36).slice(2, 10)}`,
      })
      .returning({ id: serviceCatalogItems.id }),
  );
  return rows[0]!.id;
}

const visibleCatalogs = async (ctx: DbAccessContext, id: string): Promise<number> =>
  withDbAccessContext(ctx, async () => {
    const rows = await db.select({ id: serviceCatalogs.id }).from(serviceCatalogs).where(eq(serviceCatalogs.id, id));
    return rows.length;
  });

const visibleItems = async (ctx: DbAccessContext, id: string): Promise<number> =>
  withDbAccessContext(ctx, async () => {
    const rows = await db
      .select({ id: serviceCatalogItems.id })
      .from(serviceCatalogItems)
      .where(eq(serviceCatalogItems.id, id));
    return rows.length;
  });

describe('service catalog ownership and XOR (#8325 R1)', () => {
  it('rejects a catalog with NO owner (23514)', async () => {
    await expectSqlState(
      () =>
        withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(serviceCatalogs).values({ partnerId: null, orgId: null, name: 'No owner' }),
        ),
      '23514',
    );
  });

  it('rejects a catalog with BOTH owners (23514)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expectSqlState(
      () =>
        withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(serviceCatalogs).values({ partnerId: partner.id, orgId: org.id, name: 'Both owners' }),
        ),
      '23514',
    );
  });

  it('rejects an item with NO owner and an item with BOTH owners (23514)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalogId = await seedCatalog({ partnerId: partner.id });
    await expectSqlState(
      () =>
        withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(serviceCatalogItems).values({ catalogId, partnerId: null, orgId: null, name: 'No owner' }),
        ),
      '23514',
    );
    await expectSqlState(
      () =>
        withDbAccessContext(SYSTEM_CTX, () =>
          db
            .insert(serviceCatalogItems)
            .values({ catalogId, partnerId: partner.id, orgId: org.id, name: 'Both owners' }),
        ),
      '23514',
    );
  });

  it('allows a single partner-owned catalog per partner and refuses a second (23505)', async () => {
    const partner = await createPartner();
    await seedCatalog({ partnerId: partner.id });
    await expectSqlState(() => seedCatalog({ partnerId: partner.id }), '23505');
  });

  it('allows the org axis at the schema level (readiness only; no product path creates it)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalogId = await seedCatalog({ orgId: org.id });
    const itemId = await seedItem(catalogId, { orgId: org.id });
    expect(await visibleItems(SYSTEM_CTX, itemId)).toBe(1);
  });
});

describe('service catalog item owner consistency (#8325 R1)', () => {
  it('accepts an item with the same partner as its catalog', async () => {
    const partner = await createPartner();
    const catalogId = await seedCatalog({ partnerId: partner.id });
    const itemId = await seedItem(catalogId, { partnerId: partner.id });
    expect(await visibleItems(SYSTEM_CTX, itemId)).toBe(1);
  });

  it('rejects an item whose partner differs from its catalog partner (23503)', async () => {
    const owner = await createPartner();
    const other = await createPartner();
    const catalogId = await seedCatalog({ partnerId: owner.id });
    await expectSqlState(() => seedItem(catalogId, { partnerId: other.id }), '23503');
  });

  it('rejects an org-owned item inside a partner-owned catalog (23503)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalogId = await seedCatalog({ partnerId: partner.id });
    await expectSqlState(() => seedItem(catalogId, { orgId: org.id }), '23503');
  });

  it('rejects a partner-owned item inside an org-owned catalog (23503)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalogId = await seedCatalog({ orgId: org.id });
    await expectSqlState(() => seedItem(catalogId, { partnerId: partner.id }), '23503');
  });

  it('deletes items with their catalog (ON DELETE CASCADE)', async () => {
    const partner = await createPartner();
    const catalogId = await seedCatalog({ partnerId: partner.id });
    const itemId = await seedItem(catalogId, { partnerId: partner.id });
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(serviceCatalogs).where(eq(serviceCatalogs.id, catalogId)));
    expect(await visibleItems(SYSTEM_CTX, itemId)).toBe(0);
  });
});

describe('service catalog RLS as breeze_app (#8325 R1)', () => {
  it('partner scope can INSERT its own partner-owned catalog and item', async () => {
    const partner = await createPartner();
    const ctx = partnerContext(partner.id, []);
    const catalogs = await withDbAccessContext(ctx, () =>
      db.insert(serviceCatalogs).values({ partnerId: partner.id, name: 'Own catalog' }).returning(),
    );
    createdCatalogIds.push(catalogs[0]!.id);
    expect(catalogs[0]?.orgId).toBeNull();
    const items = await withDbAccessContext(ctx, () =>
      db
        .insert(serviceCatalogItems)
        .values({ catalogId: catalogs[0]!.id, partnerId: partner.id, name: 'Own item' })
        .returning(),
    );
    expect(items).toHaveLength(1);
  });

  it('refuses a cross-partner forged catalog and item (42501)', async () => {
    const attacker = await createPartner();
    const victim = await createPartner();
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(attacker.id, []), () =>
          db.insert(serviceCatalogs).values({ partnerId: victim.id, name: 'Forged' }).returning(),
        ),
      '42501',
    );
    const victimCatalogId = await seedCatalog({ partnerId: victim.id });
    await expectSqlState(
      () =>
        withDbAccessContext(partnerContext(attacker.id, []), () =>
          db
            .insert(serviceCatalogItems)
            .values({ catalogId: victimCatalogId, partnerId: victim.id, name: 'Forged item' })
            .returning(),
        ),
      '42501',
    );
  });

  it('hides another partner catalog and its items from a partner session', async () => {
    const mine = await createPartner();
    const theirs = await createPartner();
    const theirCatalog = await seedCatalog({ partnerId: theirs.id });
    const theirItem = await seedItem(theirCatalog, { partnerId: theirs.id });
    expect(await visibleCatalogs(partnerContext(mine.id, []), theirCatalog)).toBe(0);
    expect(await visibleItems(partnerContext(mine.id, []), theirItem)).toBe(0);
  });

  it('lets an org session READ its own partner-wide catalog and items (SELECT branch)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalogId = await seedCatalog({ partnerId: partner.id });
    const itemId = await seedItem(catalogId, { partnerId: partner.id });
    const ctx = orgContext(org.id, partner.id);
    expect(await visibleCatalogs(ctx, catalogId)).toBe(1);
    expect(await visibleItems(ctx, itemId)).toBe(1);
  });

  it('hides a partner-wide catalog from an org of ANOTHER partner and from a no-partner caller', async () => {
    const owner = await createPartner();
    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    const catalogId = await seedCatalog({ partnerId: owner.id });
    expect(await visibleCatalogs(orgContext(otherOrg.id, other.id), catalogId)).toBe(0);
    expect(await visibleCatalogs(orgContext(otherOrg.id, null), catalogId)).toBe(0);
  });

  it('gives an org session NO write on partner-wide rows (INSERT 42501; UPDATE/DELETE match zero rows)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalogId = await seedCatalog({ partnerId: partner.id });
    const itemId = await seedItem(catalogId, { partnerId: partner.id });
    const ctx = orgContext(org.id, partner.id);

    await expectSqlState(
      () =>
        withDbAccessContext(ctx, () =>
          db.insert(serviceCatalogs).values({ partnerId: partner.id, name: 'Org forged' }).returning(),
        ),
      '42501',
    );

    const updated = await withDbAccessContext(ctx, () =>
      db
        .update(serviceCatalogs)
        .set({ name: 'Renamed by org' })
        .where(eq(serviceCatalogs.id, catalogId))
        .returning({ id: serviceCatalogs.id }),
    );
    expect(updated).toHaveLength(0);

    const deleted = await withDbAccessContext(ctx, () =>
      db
        .delete(serviceCatalogItems)
        .where(eq(serviceCatalogItems.id, itemId))
        .returning({ id: serviceCatalogItems.id }),
    );
    expect(deleted).toHaveLength(0);
    expect(await visibleItems(SYSTEM_CTX, itemId)).toBe(1);
  });
});
