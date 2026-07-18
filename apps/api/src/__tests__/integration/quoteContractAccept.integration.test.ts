/**
 * Executed contract-document snapshot on accept (Task 15, spec 2026-07-16).
 *
 * Proves, against real Postgres, that accepting a quote which embeds a contract
 * block:
 *   1. folds the contract part (template-version sha + resolved variables) into
 *      the stored quote_acceptances.quote_sha256 — recomputed here it must match;
 *   2. persists exactly one contract_documents row linked to the acceptance AND
 *      the first created billing contract, with a valid %PDF- payload whose
 *      sha256 matches the stored column;
 *   3. a second accept 409s (the quote is already converted) and leaves exactly
 *      ONE document row — the snapshot is at-most-once, same as the acceptance.
 *
 * Fresh seed per test (no memoization): integration/setup.ts TRUNCATE CASCADEs
 * the tenant tables in beforeEach, so a cached fixture would be vacuous.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { quotes, quoteBlocks, quoteLines } from '../../db/schema/quotes';
import { quoteAcceptances } from '../../db/schema/quotes';
import { contractTemplates, contractTemplateVersions, contractDocuments } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import { loadContractBlockRenderData } from '../../services/contractTemplateRender';
import { buildContractHashParts } from '../../services/contractDocumentService';
import { computeQuoteSha256 } from '../../services/quoteContentHash';
import type { QuoteActor } from '../../services/quoteTypes';

const runDb = it.runIf(!!process.env.DATABASE_URL);
function ctxFor(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], userId: null };
}
function actorFor(orgId: string, partnerId: string): QuoteActor {
  return { userId: null, partnerId, accessibleOrgIds: [orgId] };
}

const TEMPLATE_SHA = 'a'.repeat(64);
const BODY_HTML = '<h3>Master Services Agreement</h3><p>This agreement is effective {{dates.effective}} for {{client.name}}.</p>';

async function seedQuoteWithContractBlock() {
  const { partner, org, templateId, versionId } = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // Org-owned authored template + published version (matches contract_documents'
    // NOT NULL RESTRICT FKs). declaredVariables:[] so the send-time variable gate
    // does not block sendQuote below.
    const [template] = await db.insert(contractTemplates)
      .values({ orgId: org.id, partnerId: null, name: 'Integration MSA' })
      .returning({ id: contractTemplates.id });
    const [version] = await db.insert(contractTemplateVersions)
      .values({
        templateId: template!.id, orgId: org.id, partnerId: null, versionNumber: 1,
        status: 'published', sourceType: 'authored', bodyHtml: BODY_HTML,
        sha256: TEMPLATE_SHA, declaredVariables: [], publishedAt: new Date(),
      })
      .returning({ id: contractTemplateVersions.id });
    return { partner, org, templateId: template!.id, versionId: version!.id };
  });

  const ctx = ctxFor(org.id, partner.id);
  const actor = actorFor(org.id, partner.id);

  const created = await withDbAccessContext(ctx, () =>
    createQuote({ orgId: org.id, currencyCode: 'USD' }, actor));
  // A monthly recurring line → exactly one draft billing contract on accept.
  await withDbAccessContext(ctx, () => addManualLine(created.id, {
    sourceType: 'manual', description: 'Managed services', quantity: 3, unitPrice: 50,
    taxable: false, customerVisible: true, recurrence: 'monthly',
  } as any, actor));
  await withDbAccessContext(ctx, () => sendQuote(created.id, actor));

  // Insert the contract block AFTER send (via system context) so sendQuote's
  // contract validation path is not exercised here — this test targets accept.
  await withSystemDbAccessContext(() => db.insert(quoteBlocks).values({
    quoteId: created.id, orgId: org.id, blockType: 'contract',
    content: { templateId, templateVersionId: versionId, variableValues: {} }, sortOrder: 1,
  }));

  return { partner, org, ctx, quoteId: created.id, templateId, versionId };
}

describe('quote accept → executed contract document', () => {
  runDb('folds the contract part into the acceptance hash and snapshots a linked, valid-PDF document', async () => {
    const { org, quoteId } = await seedQuoteWithContractBlock();

    // Pre-fetch render data OUTSIDE the accept (system-context read of the pinned
    // version) — the route's responsibility in production.
    const blocks = await withSystemDbAccessContext(() =>
      db.select({ id: quoteBlocks.id, blockType: quoteBlocks.blockType, content: quoteBlocks.content })
        .from(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId)).orderBy(quoteBlocks.sortOrder));
    const renderData = await loadContractBlockRenderData(blocks);
    expect(renderData).toHaveLength(1);

    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      acceptQuote({ quoteId, signerName: 'Jane Buyer', contractRenderData: renderData })));

    expect(res.contractIds).toHaveLength(1);
    expect(res.contractDocumentIds).toHaveLength(1);

    // (1) Stored acceptance hash matches a recompute that folds the contract part.
    const effectiveDate = new Date().toISOString().slice(0, 10);
    const [q] = await withSystemDbAccessContext(() => db.select().from(quotes).where(eq(quotes.id, quoteId)));
    const blocks2 = await withSystemDbAccessContext(() =>
      db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId)).orderBy(quoteBlocks.sortOrder));
    const lines2 = await withSystemDbAccessContext(() =>
      db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId)).orderBy(quoteLines.sortOrder));
    const parts = buildContractHashParts(blocks2 as any, renderData, q as any, effectiveDate);
    const expectedHash = computeQuoteSha256(q as any, blocks2 as any, lines2 as any, parts);

    const [acc] = await withSystemDbAccessContext(() =>
      db.select().from(quoteAcceptances).where(eq(quoteAcceptances.id, res.acceptanceId)));
    expect(acc!.quoteSha256).toBe(expectedHash);
    // Sanity: the fold actually changed the hash vs. the contract-free canonical.
    expect(acc!.quoteSha256).not.toBe(computeQuoteSha256(q as any, blocks2 as any, lines2 as any, []));

    // (2) One contract_documents row, linked to the acceptance + first contract,
    //     valid PDF magic, sha256 over the stored bytes.
    const docs = await withSystemDbAccessContext(() =>
      db.select().from(contractDocuments).where(eq(contractDocuments.quoteAcceptanceId, res.acceptanceId)));
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc.orgId).toBe(org.id);
    expect(doc.quoteId).toBe(quoteId);
    expect(doc.contractId).toBe(res.contractIds[0]); // deterministic first billing contract
    const pdf = doc.pdfData as Buffer;
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(doc.byteSize).toBe(pdf.length);
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(doc.sha256);
    // Authored → rendered_html is the substituted body: header preserved, every
    // {{token}} resolved (client.name + dates.effective), no raw placeholder left.
    expect(doc.renderedHtml).toContain('Master Services Agreement');
    expect(doc.renderedHtml).toContain('effective ');
    expect(doc.renderedHtml).not.toContain('{{');
  });

  runDb('a second accept 409s and leaves exactly one contract_documents row', async () => {
    const { quoteId } = await seedQuoteWithContractBlock();

    const blocks = await withSystemDbAccessContext(() =>
      db.select({ id: quoteBlocks.id, blockType: quoteBlocks.blockType, content: quoteBlocks.content })
        .from(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId)).orderBy(quoteBlocks.sortOrder));
    const renderData = await loadContractBlockRenderData(blocks);

    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      acceptQuote({ quoteId, signerName: 'Jane Buyer', contractRenderData: renderData })));

    // Second accept: quote is now 'converted' → INVALID_STATE 409.
    await expect(
      runOutsideDbContext(() => withSystemDbAccessContext(() =>
        acceptQuote({ quoteId, signerName: 'Jane Again', contractRenderData: renderData }))),
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });

    const docs = await withSystemDbAccessContext(() =>
      db.select({ id: contractDocuments.id }).from(contractDocuments).where(eq(contractDocuments.quoteId, quoteId)));
    expect(docs).toHaveLength(1);
  });
});
