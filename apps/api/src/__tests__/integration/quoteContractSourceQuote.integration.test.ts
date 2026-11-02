/**
 * #10361 — a contract created by a quote accept carries a durable link back to
 * its quote (contracts.source_quote_id), so the operator can find the pending
 * draft from either side.
 *
 * Real Postgres, because the parts that matter are database facts: the
 * same-tenant composite FK, ON DELETE SET NULL, the migration backfill and the
 * org/RLS scoping of the two reads (listContracts enrichment + the
 * sourceQuoteId filter the quote detail uses).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { quotes, quoteBlocks } from '../../db/schema/quotes';
import { contracts, contractLines } from '../../db/schema/contracts';
import { contractTemplates, contractTemplateVersions, contractDocuments, pax8Integrations, pax8Orders, pax8OrderLines } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { createContract, getContract, listContracts } from '../../services/contractService';
import { loadContractBlockRenderData } from '../../services/contractTemplateRender';
import { replayMigration } from './replayMigration';
import type { QuoteActor } from '../../services/quoteTypes';
import type { ContractActor } from '../../services/contractTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION = '2027-01-18-181000-contracts-source-quote.sql';

function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function quoteActor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}
function contractActor(orgId: string, partnerId: string): ContractActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}

async function seedOrg() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    return { partner, org };
  });
}

/** A sent quote with one monthly and one annual line → two draft contracts on accept. */
async function seedSentRecurringQuote(orgId: string, partnerId: string) {
  const ctx = ctxFor(orgId, partnerId);
  const actor = quoteActor(orgId, partnerId);
  const created = await withDbAccessContext(ctx, () => createQuote({ orgId, currencyCode: 'USD' }, actor));
  await withDbAccessContext(ctx, () => addManualLine(created.id, {
    sourceType: 'manual', description: 'Managed services', quantity: 3, unitPrice: 50,
    taxable: false, customerVisible: true, recurrence: 'monthly',
  } as any, actor));
  await withDbAccessContext(ctx, () => addManualLine(created.id, {
    sourceType: 'manual', description: 'Annual licence', quantity: 1, unitPrice: 1200,
    taxable: false, customerVisible: true, recurrence: 'annual',
  } as any, actor));
  await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
  return created.id;
}

describe('#10361 contracts.source_quote_id', () => {
  runDb('accept stamps source_quote_id on EVERY contract it creates (monthly and annual)', async () => {
    const { partner, org } = await seedOrg();
    const quoteId = await seedSentRecurringQuote(org.id, partner.id);

    const res = await withDbAccessContext(ctxFor(org.id, partner.id), () =>
      acceptQuote({ quoteId, signerName: 'Jane Buyer' }));
    expect(res.contractIds).toHaveLength(2);

    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: contracts.id, sourceQuoteId: contracts.sourceQuoteId, status: contracts.status })
        .from(contracts).where(eq(contracts.orgId, org.id)));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('draft');
      expect(r.sourceQuoteId).toBe(quoteId);
    }
  });

  runDb('listContracts names the source quote, and filters by it without leaking a hand-built draft', async () => {
    const { partner, org } = await seedOrg();
    const quoteId = await seedSentRecurringQuote(org.id, partner.id);
    const ctx = ctxFor(org.id, partner.id);
    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId, signerName: 'Jane Buyer' }));
    const handBuilt = await withDbAccessContext(ctx, () => createContract({
      orgId: org.id, name: 'Hand-built draft', billingTiming: 'advance', intervalMonths: 1,
      startDate: '2026-11-01', currencyCode: 'USD',
    } as any, contractActor(org.id, partner.id)));

    const [q] = await withSystemDbAccessContext(() =>
      db.select({ quoteNumber: quotes.quoteNumber }).from(quotes).where(eq(quotes.id, quoteId)));
    expect(q!.quoteNumber).toBeTruthy();

    const all = await withDbAccessContext(ctx, () => listContracts({ orgId: org.id }, contractActor(org.id, partner.id)));
    const byId = new Map(all.map((c) => [c.id, c]));
    for (const id of res.contractIds) {
      expect(byId.get(id)?.sourceQuote).toEqual({ id: quoteId, quoteNumber: q!.quoteNumber });
    }
    expect(byId.get(handBuilt.id)?.sourceQuote).toBeNull();

    const fromQuote = await withDbAccessContext(ctx, () =>
      listContracts({ orgId: org.id, sourceQuoteId: quoteId }, contractActor(org.id, partner.id)));
    expect(fromQuote.map((c) => c.id).sort()).toEqual([...res.contractIds].sort());

    // The contract page's read (includeRelated) names the quote too, so a draft
    // with no executed agreement still shows where it came from.
    const page = await withDbAccessContext(ctx, () =>
      getContract(res.contractIds[0]!, contractActor(org.id, partner.id), { includeRelated: true }));
    expect(page.sourceQuote).toEqual({ id: quoteId, quoteNumber: q!.quoteNumber });
    const handPage = await withDbAccessContext(ctx, () =>
      getContract(handBuilt.id, contractActor(org.id, partner.id), { includeRelated: true }));
    expect(handPage.sourceQuote).toBeNull();
  });

  runDb('another org cannot read the link: its context sees no contracts for the quote', async () => {
    const { partner, org } = await seedOrg();
    const other = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    const quoteId = await seedSentRecurringQuote(org.id, partner.id);
    await withDbAccessContext(ctxFor(org.id, partner.id), () => acceptQuote({ quoteId, signerName: 'Jane Buyer' }));

    const seen = await withDbAccessContext(ctxFor(other.id, partner.id), () =>
      listContracts({ sourceQuoteId: quoteId }, contractActor(other.id, partner.id)));
    expect(seen).toEqual([]);
  });

  runDb('a site-restricted reader learns the source quote only when it may read that quote', async () => {
    const { partner, org } = await seedOrg();
    const site = await withSystemDbAccessContext(() => createSite({ orgId: org.id }));
    const quoteId = await seedSentRecurringQuote(org.id, partner.id);
    const ctx = ctxFor(org.id, partner.id);
    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId, signerName: 'Jane Buyer' }));
    const contractId = res.contractIds[0]!;
    // Give the contract a line on the reader's site so the contract itself is visible to them.
    await withSystemDbAccessContext(() => db.insert(contractLines).values({
      contractId, orgId: org.id, lineType: 'per_device', description: 'Site endpoints',
      unitPrice: '10.00', siteId: site.id, siteName: site.name, taxable: false, sortOrder: 9,
    }));
    const restricted: ContractActor = { ...contractActor(org.id, partner.id), allowedSiteIds: [site.id] };

    // The quote has no site: a site-restricted actor may not read it (assertSite), so the list must not name it.
    const hidden = await withDbAccessContext(ctx, () => listContracts({ orgId: org.id }, restricted));
    const row = hidden.find((c) => c.id === contractId);
    expect(row).toBeDefined();
    expect(row!.sourceQuote).toBeNull();

    // Once the quote sits on the reader's site, it is theirs to see.
    await withSystemDbAccessContext(() => db.update(quotes).set({ siteId: site.id }).where(eq(quotes.id, quoteId)));
    const shown = await withDbAccessContext(ctx, () => listContracts({ orgId: org.id }, restricted));
    expect(shown.find((c) => c.id === contractId)!.sourceQuote?.id).toBe(quoteId);
  });

  runDb('the FK is same-tenant: a contract cannot point at another org\'s quote', async () => {
    const { partner, org } = await seedOrg();
    const other = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    const otherQuote = await withDbAccessContext(ctxFor(other.id, partner.id), () =>
      createQuote({ orgId: other.id, currencyCode: 'USD' }, quoteActor(other.id, partner.id)));
    const mine = await withDbAccessContext(ctxFor(org.id, partner.id), () => createContract({
      orgId: org.id, name: 'Mine', billingTiming: 'advance', intervalMonths: 1,
      startDate: '2026-11-01', currencyCode: 'USD',
    } as any, contractActor(org.id, partner.id)));

    // Assert on the constraint name: a bare toThrow() would also pass on any
    // malformed update (it did, before the column existed).
    const err = await withSystemDbAccessContext(() =>
      db.update(contracts).set({ sourceQuoteId: otherQuote.id }).where(eq(contracts.id, mine.id)))
      .then(() => null, (e: unknown) => e);
    const cause = (err as { cause?: { constraint_name?: string } } | null)?.cause;
    expect(cause?.constraint_name).toBe('contracts_source_quote_org_fkey');
  });

  runDb('deleting the quote clears only the link (ON DELETE SET NULL), never the contract', async () => {
    const { partner, org } = await seedOrg();
    const quoteId = await seedSentRecurringQuote(org.id, partner.id);
    const res = await withDbAccessContext(ctxFor(org.id, partner.id), () => acceptQuote({ quoteId, signerName: 'Jane Buyer' }));

    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM quotes WHERE id = ${quoteId}`));

    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: contracts.id, sourceQuoteId: contracts.sourceQuoteId }).from(contracts).where(eq(contracts.orgId, org.id)));
    expect(rows.map((r) => r.id).sort()).toEqual([...res.contractIds].sort());
    expect(rows.every((r) => r.sourceQuoteId === null)).toBe(true);
  });

  runDb('the migration backfills a pre-existing quote contract from its executed agreement', async () => {
    const { partner, org } = await seedOrg();
    const ctx = ctxFor(org.id, partner.id);
    const actor = quoteActor(org.id, partner.id);
    const created = await withDbAccessContext(ctx, () => createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(created.id, {
      sourceType: 'manual', description: 'Managed services', quantity: 3, unitPrice: 50,
      taxable: false, customerVisible: true, recurrence: 'monthly',
    } as any, actor));
    await withDbAccessContext(ctx, () => sendQuote(created.id, actor));
    await withSystemDbAccessContext(async () => {
      const [template] = await db.insert(contractTemplates)
        .values({ orgId: org.id, partnerId: null, name: 'Backfill MSA' }).returning({ id: contractTemplates.id });
      const [version] = await db.insert(contractTemplateVersions).values({
        templateId: template!.id, orgId: org.id, partnerId: null, versionNumber: 1, status: 'published',
        sourceType: 'authored', bodyHtml: '<p>MSA for {{client.name}}</p>', sha256: 'b'.repeat(64),
        declaredVariables: [], publishedAt: new Date(),
      }).returning({ id: contractTemplateVersions.id });
      await db.insert(quoteBlocks).values({
        quoteId: created.id, orgId: org.id, blockType: 'contract',
        content: { templateId: template!.id, templateVersionId: version!.id, variableValues: {} }, sortOrder: 1,
      });
    });
    const blocks = await withSystemDbAccessContext(() =>
      db.select({ id: quoteBlocks.id, blockType: quoteBlocks.blockType, content: quoteBlocks.content })
        .from(quoteBlocks).where(eq(quoteBlocks.quoteId, created.id)).orderBy(quoteBlocks.sortOrder));
    const renderData = await loadContractBlockRenderData(blocks);
    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      acceptQuote({ quoteId: created.id, signerName: 'Jane Buyer', contractRenderData: renderData })));
    const contractId = res.contractIds[0]!;
    const [doc] = await withSystemDbAccessContext(() =>
      db.select({ contractId: contractDocuments.contractId }).from(contractDocuments)
        .where(eq(contractDocuments.quoteId, created.id)));
    expect(doc!.contractId).toBe(contractId);

    // Simulate a contract created before this column existed, then replay.
    await withSystemDbAccessContext(() =>
      db.update(contracts).set({ sourceQuoteId: null }).where(eq(contracts.id, contractId)));
    await replayMigration(MIGRATION);

    const [row] = await withSystemDbAccessContext(() =>
      db.select({ sourceQuoteId: contracts.sourceQuoteId }).from(contracts).where(eq(contracts.id, contractId)));
    expect(row!.sourceQuoteId).toBe(created.id);
  });

  runDb('the migration backfills from a Pax8 order (the annual contract too) and never overwrites a link', async () => {
    // Cross-org pairing cannot be built here: pax8_order_lines_contract_line_org_fkey
    // already pins a Pax8 line to a contract line of its own org, and the
    // backfill re-checks the org on both joins.
    const { partner, org } = await seedOrg();
    const ctx = ctxFor(org.id, partner.id);
    const quoteId = await seedSentRecurringQuote(org.id, partner.id);
    const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId, signerName: 'Jane Buyer' }));
    expect(res.contractIds).toHaveLength(2);
    const [monthlyId, annualId] = res.contractIds as [string, string];

    const keepQuoteId = await withSystemDbAccessContext(async () => {
      const [integration] = await db.insert(pax8Integrations).values({
        partnerId: partner.id, name: 'Backfill test', clientIdEncrypted: 'enc:c', clientSecretEncrypted: 'enc:s',
        tokenUrl: 'https://api.pax8.com/v1/token', isActive: true,
      }).returning({ id: pax8Integrations.id });
      const [order] = await db.insert(pax8Orders).values({
        integrationId: integration!.id, partnerId: partner.id, orgId: org.id, status: 'awaiting_details',
        source: 'quote', sourceQuoteId: quoteId, dedupeKey: `quote:${quoteId}`,
      }).returning({ id: pax8Orders.id });
      // One Pax8 line per contract, each pointing at that contract's line.
      for (const contractId of [monthlyId, annualId]) {
        const [line] = await db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.contractId, contractId));
        await db.insert(pax8OrderLines).values({
          orderId: order!.id, partnerId: partner.id, orgId: org.id, action: 'new_subscription',
          pax8ProductId: 'prod-1', billingTerm: 'Annual', quantity: '1', contractLineId: line!.id,
        });
      }
      // Pre-column state for the annual contract; the monthly one carries a
      // DIFFERENT (valid, same-org) link the backfill must leave alone.
      const keep = await createQuote({ orgId: org.id, currencyCode: 'USD' }, quoteActor(org.id, partner.id));
      await db.update(contracts).set({ sourceQuoteId: keep.id }).where(eq(contracts.id, monthlyId));
      await db.update(contracts).set({ sourceQuoteId: null }).where(eq(contracts.id, annualId));
      return keep.id;
    });

    await replayMigration(MIGRATION);

    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: contracts.id, sourceQuoteId: contracts.sourceQuoteId }).from(contracts).where(eq(contracts.orgId, org.id)));
    const byId = new Map(rows.map((r) => [r.id, r.sourceQuoteId]));
    expect(byId.get(annualId)).toBe(quoteId);
    expect(byId.get(monthlyId)).toBe(keepQuoteId);
  });
});
