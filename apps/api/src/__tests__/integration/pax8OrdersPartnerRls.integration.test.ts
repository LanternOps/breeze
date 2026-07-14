/**
 * Real-driver partner-axis RLS and integrity tests for the Pax8 order ledger.
 *
 * Runs as the unprivileged `breeze_app` role through withDbAccessContext. Each
 * test seeds fresh fixtures because integration setup truncates tenant rows in
 * beforeEach; memoizing them would make the isolation assertions vacuous.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  pax8Integrations,
  pax8Orders,
  pax8OrderLines,
  catalogItems,
  contracts,
  contractLines,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function withPartnerContext<T>(partnerId: string, fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(partnerContext(partnerId), fn);
}

async function seedIntegration(partnerId: string) {
  const [integration] = await db
    .insert(pax8Integrations)
    .values({
      partnerId,
      name: 'Pax8',
      clientIdEncrypted: 'enc:client-id',
      clientSecretEncrypted: 'enc:client-secret',
      tokenUrl: 'https://api.pax8.com/v1/token',
    })
    .returning();
  if (!integration) throw new Error('failed to seed Pax8 integration');
  return integration;
}

// Re-seeds fresh on every call. Intentionally not memoized (see file header).
async function seed() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const integrationA = await seedIntegration(partnerA.id);
    const integrationB = await seedIntegration(partnerB.id);

    const [orderA] = await db
      .insert(pax8Orders)
      .values({
        integrationId: integrationA.id,
        partnerId: partnerA.id,
        orgId: orgA.id,
        pax8CompanyId: null,
        status: 'awaiting_details',
        source: 'quote',
        dedupeKey: 'existing-order-a',
      })
      .returning();
    if (!orderA) throw new Error('failed to seed partner A order');

    const [orderB] = await db
      .insert(pax8Orders)
      .values({
        integrationId: integrationB.id,
        partnerId: partnerB.id,
        orgId: orgB.id,
        pax8CompanyId: 'pax8-co-b',
        dedupeKey: 'existing-order-b',
      })
      .returning();
    if (!orderB) throw new Error('failed to seed partner B order');

    return {
      partnerA,
      orgA,
      partnerB,
      orgB,
      integrationA,
      integrationB,
      orderA,
      orderB,
    };
  });
}

describe('Pax8 ordering partner-axis RLS and integrity (breeze_app)', () => {
  runDb('rejects a cross-partner forged order insert with 42501', async () => {
    const { partnerA, partnerB, orgB, integrationB } = await seed();

    await expect(
      withPartnerContext(partnerA.id, () =>
        db.insert(pax8Orders).values({
          integrationId: integrationB.id,
          partnerId: partnerB.id,
          orgId: orgB.id,
          pax8CompanyId: 'forged-co',
          dedupeKey: 'forge-test-1',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb("hides another partner's orders from SELECT", async () => {
    const { partnerA, orderB } = await seed();

    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db.select().from(pax8Orders).where(eq(pax8Orders.id, orderB.id))
    );
    expect(existsUnderSystem).toHaveLength(1);

    const rows = await withPartnerContext(partnerA.id, () =>
      db.select().from(pax8Orders).where(eq(pax8Orders.id, orderB.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('rejects a second order with the same (partner_id, dedupe_key)', async () => {
    const { partnerA, orgA, integrationA, orderA } = await seed();

    await expect(
      withPartnerContext(partnerA.id, () =>
        db.insert(pax8Orders).values({
          integrationId: integrationA.id,
          partnerId: partnerA.id,
          orgId: orgA.id,
          pax8CompanyId: null,
          dedupeKey: orderA.dedupeKey,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  runDb('rejects a cancel line carrying a quantity (action payload CHECK)', async () => {
    const { partnerA, orgA, orderA } = await seed();

    await expect(
      withPartnerContext(partnerA.id, () =>
        db.insert(pax8OrderLines).values({
          orderId: orderA.id,
          partnerId: partnerA.id,
          orgId: orgA.id,
          action: 'cancel',
          targetSubscriptionId: 'sub-1',
          quantity: '5.00',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  runDb('deleting a catalog item clears only catalog_item_id on its order line', async () => {
    const { partnerA, orgA, orderA } = await seed();

    const result = await withSystemDbAccessContext(async () => {
      const [catalogItem] = await db
        .insert(catalogItems)
        .values({
          partnerId: partnerA.id,
          itemType: 'service',
          name: 'Pax8-backed service',
          unitPrice: '10.00',
        })
        .returning({ id: catalogItems.id });
      if (!catalogItem) throw new Error('failed to seed catalog item');

      const [orderLine] = await db
        .insert(pax8OrderLines)
        .values({
          orderId: orderA.id,
          partnerId: partnerA.id,
          orgId: orgA.id,
          action: 'new_subscription',
          pax8ProductId: 'product-1',
          catalogItemId: catalogItem.id,
          billingTerm: 'Monthly',
          quantity: '1.00',
        })
        .returning({ id: pax8OrderLines.id });
      if (!orderLine) throw new Error('failed to seed catalog-backed order line');

      await db.delete(catalogItems).where(eq(catalogItems.id, catalogItem.id));

      const [remaining] = await db
        .select({
          catalogItemId: pax8OrderLines.catalogItemId,
          partnerId: pax8OrderLines.partnerId,
        })
        .from(pax8OrderLines)
        .where(eq(pax8OrderLines.id, orderLine.id));
      return remaining;
    });

    expect(result).toEqual({ catalogItemId: null, partnerId: partnerA.id });
  });

  runDb('deleting a contract line clears only contract_line_id on its order line', async () => {
    const { partnerA, orgA, orderA } = await seed();

    const result = await withSystemDbAccessContext(async () => {
      const [contract] = await db
        .insert(contracts)
        .values({
          partnerId: partnerA.id,
          orgId: orgA.id,
          name: 'Pax8 contract',
          intervalMonths: 1,
          startDate: '2026-07-14',
        })
        .returning({ id: contracts.id });
      if (!contract) throw new Error('failed to seed contract');

      const [contractLine] = await db
        .insert(contractLines)
        .values({
          contractId: contract.id,
          orgId: orgA.id,
          lineType: 'manual',
          description: 'Pax8 subscription',
          unitPrice: '10.00',
        })
        .returning({ id: contractLines.id });
      if (!contractLine) throw new Error('failed to seed contract line');

      const [orderLine] = await db
        .insert(pax8OrderLines)
        .values({
          orderId: orderA.id,
          partnerId: partnerA.id,
          orgId: orgA.id,
          action: 'cancel',
          targetSubscriptionId: 'subscription-1',
          contractLineId: contractLine.id,
        })
        .returning({ id: pax8OrderLines.id });
      if (!orderLine) throw new Error('failed to seed contract-backed order line');

      await db.delete(contractLines).where(eq(contractLines.id, contractLine.id));

      const [remaining] = await db
        .select({
          contractLineId: pax8OrderLines.contractLineId,
          orgId: pax8OrderLines.orgId,
        })
        .from(pax8OrderLines)
        .where(eq(pax8OrderLines.id, orderLine.id));
      return remaining;
    });

    expect(result).toEqual({ contractLineId: null, orgId: orgA.id });
  });
});
