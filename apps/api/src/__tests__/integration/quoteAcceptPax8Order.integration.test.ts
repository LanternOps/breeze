import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  catalogItems,
  contractLines,
  contracts,
  pax8CompanyMappings,
  pax8Integrations,
  pax8OrderLines,
  pax8Orders,
  pax8ProductMappings,
  quotes,
} from '../../db/schema';
import { acceptQuote } from '../../services/quoteAcceptService';
import { pax8CompanyOrderReadiness } from '../../services/pax8CompanyReadiness';
import { PAX8_COMPANY_MAPPING_REQUIRED_ERROR } from '../../services/quoteToPax8Order';
import { addCatalogLine, createQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import type { QuoteActor } from '../../services/quoteTypes';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function context(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}

function actor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}

async function seedPax8Quote(options: {
  recurrence?: 'monthly' | 'annual' | 'one_time';
  mappedCompany?: boolean;
  backed?: boolean;
  duplicateLines?: number;
} = {}) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const recurrence = options.recurrence ?? 'monthly';
    const [catalogItem] = await db.insert(catalogItems).values({
      partnerId: partner.id,
      itemType: 'software',
      name: 'Pax8-backed license',
      billingType: recurrence === 'one_time' ? 'one_time' : 'recurring',
      billingFrequency: recurrence === 'annual' ? 'annual' : (recurrence === 'monthly' ? 'monthly' : null),
      unitPrice: '19.95',
      taxable: false,
    }).returning();
    if (!catalogItem) throw new Error('catalog seed failed');

    const [integration] = await db.insert(pax8Integrations).values({
      partnerId: partner.id,
      name: 'Pax8 quote staging test',
      clientIdEncrypted: 'enc:test-client',
      clientSecretEncrypted: 'enc:test-secret',
      tokenUrl: 'https://api.pax8.com/v1/token',
      isActive: true,
    }).returning();
    if (!integration) throw new Error('integration seed failed');

    if (options.backed !== false) {
      await db.insert(pax8ProductMappings).values({
        integrationId: integration.id,
        partnerId: partner.id,
        pax8ProductId: 'product-1',
        productName: 'Pax8-backed license',
        catalogItemId: catalogItem.id,
      });
    }
    if (options.mappedCompany) {
      await db.insert(pax8CompanyMappings).values({
        integrationId: integration.id,
        partnerId: partner.id,
        pax8CompanyId: 'company-1',
        pax8CompanyName: 'Customer company',
        orgId: org.id,
      });
    }

    const ctx = context(org.id, partner.id);
    const quoteActor = actor(org.id, partner.id);
    const quote = await createQuote({ orgId: org.id, currencyCode: 'USD' }, quoteActor);
    const quoteLines = [];
    for (let index = 0; index < (options.duplicateLines ?? 1); index++) {
      quoteLines.push(await addCatalogLine(quote.id, catalogItem.id, index + 2, undefined, quoteActor));
    }
    await sendQuote(quote.id, quoteActor);
    return { partner, org, user, integration, catalogItem, quote, quoteLines, ctx };
  });
}

describe('quote acceptance stages Pax8 fulfillment (real Postgres)', () => {
  runDb('stages with missing company readiness and wires only Phase 4 contract lines', async () => {
    const fixture = await seedPax8Quote({ duplicateLines: 2 });

    const result = await withDbAccessContext(fixture.ctx, () => acceptQuote({
      quoteId: fixture.quote.id,
      signerName: 'A Customer',
      actorUserId: fixture.user.id,
    }));

    expect(result.pax8OrderId).toMatch(/^[0-9a-f-]{36}$/);
    const state = await withSystemDbAccessContext(async () => {
      const [order] = await db.select().from(pax8Orders)
        .where(eq(pax8Orders.sourceQuoteId, fixture.quote.id));
      const lines = order
        ? await db.select().from(pax8OrderLines).where(eq(pax8OrderLines.orderId, order.id)).orderBy(pax8OrderLines.sortOrder)
        : [];
      const createdContractLines = await db.select({
        id: contractLines.id,
        catalogItemId: contractLines.catalogItemId,
        unitPrice: contractLines.unitPrice,
      })
        .from(contractLines)
        .where(inArray(contractLines.contractId, result.contractIds));
      const companyMappings = await db.select({ id: pax8CompanyMappings.id })
        .from(pax8CompanyMappings)
        .where(eq(pax8CompanyMappings.integrationId, fixture.integration.id));
      return { order, lines, createdContractLines, companyMappings };
    });

    expect(state.order).toMatchObject({
      id: result.pax8OrderId,
      integrationId: fixture.integration.id,
      partnerId: fixture.partner.id,
      orgId: fixture.org.id,
      pax8CompanyId: null,
      status: 'awaiting_details',
      source: 'quote',
      sourceQuoteId: fixture.quote.id,
      createdBy: fixture.user.id,
      error: PAX8_COMPANY_MAPPING_REQUIRED_ERROR,
    });
    expect(state.lines).toHaveLength(2);
    expect(state.companyMappings).toEqual([]);
    expect(state.lines.map((line) => line.quantity)).toEqual(['2.00', '3.00']);
    expect(state.lines.map((line) => line.billingTerm)).toEqual(['Monthly', 'Monthly']);
    expect(state.lines.every((line) => line.action === 'new_subscription')).toBe(true);
    expect(state.lines.every((line) => Array.isArray(line.provisioningDetails) && line.provisioningDetails.length === 0)).toBe(true);
    expect(new Set(state.lines.map((line) => line.contractLineId)).size).toBe(2);
    expect(state.lines.every((line) => state.createdContractLines.some((created) => created.id === line.contractLineId))).toBe(true);
    expect(state.createdContractLines.every((line) => line.catalogItemId === null)).toBe(true);
    expect(state.createdContractLines.every((line) => line.unitPrice === '19.95')).toBe(true);
  });

  runDb('captures a mapped company and leaves one-time fulfillment detached from contracts', async () => {
    const fixture = await seedPax8Quote({ recurrence: 'one_time', mappedCompany: true });

    const result = await withDbAccessContext(fixture.ctx, () => acceptQuote({
      quoteId: fixture.quote.id,
      signerName: 'A Customer',
    }));

    expect(result.contractIds).toEqual([]);
    const [order] = await withSystemDbAccessContext(() => db.select().from(pax8Orders)
      .where(eq(pax8Orders.id, result.pax8OrderId!)));
    const [line] = await withSystemDbAccessContext(() => db.select().from(pax8OrderLines)
      .where(eq(pax8OrderLines.orderId, result.pax8OrderId!)));
    const [mapping] = await withSystemDbAccessContext(() => db.select({
      status: pax8CompanyMappings.status,
      metadata: pax8CompanyMappings.metadata,
    }).from(pax8CompanyMappings).where(eq(pax8CompanyMappings.orgId, fixture.org.id)));
    expect(pax8CompanyOrderReadiness(mapping?.status, mapping?.metadata).orderReady).toBe(false);
    expect(order?.pax8CompanyId).toBe('company-1');
    expect(order?.error).toBeNull();
    expect(line).toMatchObject({
      sourceQuoteLineId: fixture.quoteLines[0]!.id,
      billingTerm: 'One-Time',
      quantity: '2.00',
      contractLineId: null,
    });
  });

  runDb('stages nothing when only a foreign partner has a product mapping', async () => {
    const fixture = await seedPax8Quote({ backed: false });
    await withSystemDbAccessContext(async () => {
      const foreignPartner = await createPartner();
      const [foreignCatalog] = await db.insert(catalogItems).values({
        partnerId: foreignPartner.id,
        itemType: 'software',
        name: 'Foreign product',
        billingType: 'recurring',
        billingFrequency: 'monthly',
        unitPrice: '5.00',
      }).returning();
      const [foreignIntegration] = await db.insert(pax8Integrations).values({
        partnerId: foreignPartner.id,
        name: 'Foreign Pax8',
        clientIdEncrypted: 'enc:foreign',
        clientSecretEncrypted: 'enc:foreign',
        tokenUrl: 'https://api.pax8.com/v1/token',
      }).returning();
      await db.insert(pax8ProductMappings).values({
        integrationId: foreignIntegration!.id,
        partnerId: foreignPartner.id,
        pax8ProductId: 'foreign-product',
        catalogItemId: foreignCatalog!.id,
      });
    });

    const result = await withDbAccessContext(fixture.ctx, () => acceptQuote({
      quoteId: fixture.quote.id,
      signerName: 'A Customer',
    }));

    expect(result.pax8OrderId).toBeNull();
    const orders = await withSystemDbAccessContext(() => db.select().from(pax8Orders)
      .where(eq(pax8Orders.sourceQuoteId, fixture.quote.id)));
    expect(orders).toEqual([]);
  });

  runDb('rolls contracts and staged order back together after a later failure', async () => {
    const fixture = await seedPax8Quote({ mappedCompany: true });
    let contractIds: string[] = [];
    let stagedOrderId: string | null = null;

    await expect(withDbAccessContext(fixture.ctx, async () => {
      const result = await acceptQuote({ quoteId: fixture.quote.id, signerName: 'A Customer' });
      contractIds = result.contractIds;
      stagedOrderId = result.pax8OrderId;
      const [insideOrder] = await db.select().from(pax8Orders)
        .where(eq(pax8Orders.id, result.pax8OrderId!));
      expect(insideOrder?.sourceQuoteId).toBe(fixture.quote.id);
      throw new Error('forced failure after Phase 5');
    })).rejects.toThrow('forced failure after Phase 5');

    expect(stagedOrderId).not.toBeNull();
    expect(contractIds).toHaveLength(1);
    const after = await withSystemDbAccessContext(async () => ({
      orders: await db.select().from(pax8Orders).where(eq(pax8Orders.sourceQuoteId, fixture.quote.id)),
      contracts: await db.select().from(contracts).where(inArray(contracts.id, contractIds)),
      quote: (await db.select().from(quotes).where(eq(quotes.id, fixture.quote.id)))[0],
    }));
    expect(after.orders).toEqual([]);
    expect(after.contracts).toEqual([]);
    expect(after.quote?.status).toBe('sent');
  });
});
