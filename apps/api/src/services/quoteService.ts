import { and, count, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteLines, quoteBlocks, quoteImages } from '../db/schema/quotes';
import { invoices } from '../db/schema/invoices';
import { organizations, partners } from '../db/schema/orgs';
import { contractTemplates, contractTemplateVersions } from '../db/schema/contractDocuments';
import { catalogItems } from '../db/schema/catalog';
import { pax8OrderLines, pax8Orders } from '../db/schema/pax8Orders';
import { computeLineTotal, resolveEffectiveTaxRate } from './invoiceMath';
import { buildBillToAddress, type BillToAddress } from './sellerSnapshot';
import { computeQuoteTotals, validateQuoteDeposit, toQuoteDepositConfig, type QuoteLineForMath } from './quoteMath';
import { QuoteServiceError, type QuoteActor } from './quoteTypes';
import { allocateQuoteCounter, formatQuoteNumber } from './quoteNumbers';
import { sanitizeRichTextHtml } from './richTextSanitize';
import type {
  CreateQuoteInput, CloneQuoteInput, UpdateQuoteInput, QuoteLineInput, QuoteBlockInput, ListQuotesQuery
} from '@breeze/shared';

// ---------------------------------------------------------------------------
// Actor guards. The RLS access context (withDbAccessContext) is established by
// the caller — the route middleware in production, the test harness in
// integration tests — exactly like invoiceService. The service itself uses the
// bare `db` proxy directly; it never opens its own context.
// ---------------------------------------------------------------------------

/**
 * Strip internal-only economics (unitCost/unit_cost) from quote lines before
 * returning them to customer-facing surfaces (public quote URL, portal, PDF).
 * sku and partNumber are acceptable on the customer document; unitCost is NOT,
 * and markup/net must never be derived from it on the customer side.
 */
export function toCustomerLines<T extends { unitCost: unknown }>(lines: T[]): Omit<T, 'unitCost'>[] {
  return lines.map(({ unitCost: _cost, ...rest }) => rest as Omit<T, 'unitCost'>);
}

/**
 * Attach a per-line `imageUrl` for the customer-facing portal + public proposal
 * views and drop the raw `imageId`/`catalogItemId` (internal identifiers the
 * customer document has no use for). A line gets a URL when it has EITHER a
 * per-line uploaded image or a snapshotted catalog item — the same
 * `imageId || catalogItemId` presence rule the web renderer's DocLineThumb uses;
 * the URL points at the quote-scoped `line-image/:lineId` asset route (which
 * resolves the actual source, see loadCustomerLineImage). Kept a pure mapper (no
 * DB) so it runs correctly on either the org-scoped portal path or the
 * system-scoped public path without a partner-axis RLS scoping hazard; a line
 * whose catalog item happens to have no image simply 404s and the client hides
 * the broken thumbnail, matching the preview's render-nothing-on-miss behaviour.
 */
export function attachCustomerLineImages<T extends { id: string; imageId: string | null; catalogItemId: string | null }>(
  lines: T[],
  buildLineImagePath: (lineId: string) => string,
): (Omit<T, 'imageId' | 'catalogItemId'> & { imageUrl: string | null })[] {
  return lines.map((line) => {
    const { imageId, catalogItemId, ...rest } = line;
    const hasImage = !!imageId || !!catalogItemId;
    return { ...(rest as Omit<T, 'imageId' | 'catalogItemId'>), imageUrl: hasImage ? buildLineImagePath(line.id) : null };
  });
}

/**
 * Sanitize every rich_text block's content.html at READ-serialization time —
 * defense in depth alongside the write-time sanitization in addBlock/updateBlock
 * below, covering rows written before this sanitizer existed (or by any future
 * write path that forgets to sanitize). Every place a quote's blocks leave the
 * API — the internal editor (getQuote, below), the portal, and the public accept
 * link — must route through this so no unsanitized author HTML is ever served.
 */
export function sanitizeQuoteBlocksForRead<T extends { blockType: string; content: unknown }>(blocks: T[]): T[] {
  return blocks.map((block) => {
    if (block.blockType !== 'rich_text') return block;
    const content = block.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) return block;
    const html = (content as Record<string, unknown>).html;
    if (typeof html !== 'string') return block;
    return { ...block, content: { ...(content as Record<string, unknown>), html: sanitizeRichTextHtml(html) } };
  });
}

/** Sanitize a rich_text block's content.html at WRITE time (addBlock/updateBlock) —
 * the primary defense; sanitizeQuoteBlocksForRead above is the secondary one.
 * Other block types pass through unchanged. */
function sanitizeBlockContentForWrite(input: QuoteBlockInput): QuoteBlockInput['content'] {
  if (input.blockType === 'rich_text') {
    return { ...input.content, html: sanitizeRichTextHtml(input.content.html) };
  }
  return input.content;
}

function resolvePartner(actor: QuoteActor): string {
  if (!actor.partnerId) {
    throw new QuoteServiceError('Partner could not be resolved', 403, 'PARTNER_UNRESOLVABLE');
  }
  return actor.partnerId;
}

function assertOrg(actor: QuoteActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new QuoteServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
}

/**
 * Site-axis guard mirroring `siteAccessCheck` (middleware/auth.ts). An actor with
 * no `allowedSiteIds` (undefined) is unrestricted — a no-op, so partner/system
 * callers and all-sites org users are unaffected. A site-restricted actor may only
 * touch a siteId in its allowlist; a null/undefined siteId (an org-level quote) is
 * DENIED, exactly as the auth closure denies a restricted caller for a null site.
 */
function assertSite(actor: QuoteActor, siteId: string | null | undefined): void {
  if (!actor.allowedSiteIds) return; // unrestricted
  if (!siteId || !actor.allowedSiteIds.includes(siteId)) {
    throw new QuoteServiceError('Site access denied', 403, 'SITE_DENIED');
  }
}

/**
 * Org + site guard for a loaded quote row. The single authorization chokepoint for
 * every quote path (CRUD via loadDraft, getQuote, and the pay-link path in
 * quotePay). Exported so quotePay can enforce the same site restriction that was
 * previously bypassable (org is enforced downstream in createInvoicePayLink; site
 * was not enforced anywhere on the quote).
 */
export function assertQuoteAccess(actor: QuoteActor, quote: { orgId: string; siteId: string | null }): void {
  assertOrg(actor, quote.orgId);
  assertSite(actor, quote.siteId);
}

/**
 * Recompute the header buckets (subtotal/tax/total + one-time/monthly/annual)
 * from the quote's current lines. Runs after EVERY line insert/update/delete
 * and after any header update (tax rate is the only header field that moves
 * totals). Routes per-line cents through the shared
 * computeLineTotal/toCents discipline (via computeQuoteTotals) so the header
 * totals are penny-consistent with the persisted line_total and with invoices.
 *
 * `dbc` lets a caller run the recompute inside its own transaction (updateQuote's
 * org reassignment) so a mid-flight failure can't commit the header move while
 * leaving totals computed under the old tax rate.
 */
async function recomputeAndPersist(quoteId: string, dbc: Pick<typeof db, 'select' | 'update'> = db): Promise<void> {
  const [q] = await dbc.select({
    taxRate: quotes.taxRate,
    depositType: quotes.depositType,
    depositPercent: quotes.depositPercent,
  }).from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  const lines = await dbc.select({
    quantity: quoteLines.quantity,
    unitPrice: quoteLines.unitPrice,
    taxable: quoteLines.taxable,
    customerVisible: quoteLines.customerVisible,
    recurrence: quoteLines.recurrence,
    depositEligible: quoteLines.depositEligible,
    itemType: quoteLines.itemType,
  }).from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
  const deposit = toQuoteDepositConfig(q?.depositType, q?.depositPercent);
  const totals = computeQuoteTotals(lines as QuoteLineForMath[], q?.taxRate ? parseFloat(q.taxRate) : null, deposit);
  await dbc.update(quotes).set({
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    oneTimeTotal: totals.oneTimeTotal,
    monthlyRecurringTotal: totals.monthlyRecurringTotal,
    annualRecurringTotal: totals.annualRecurringTotal,
    // Null when no deposit configured OR the config is currently unsatisfiable
    // (e.g. the last one-time line was deleted) — sendQuote re-validates hard.
    depositAmount: totals.depositDueTotal,
    updatedAt: new Date(),
  }).where(eq(quotes.id, quoteId));
}

/** Load a quote and assert it is owned/accessible AND still a draft (409 if not). */
async function loadDraft(quoteId: string, actor: QuoteActor) {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertQuoteAccess(actor, q);
  if (q.status !== 'draft') throw new QuoteServiceError('Quote is not a draft', 409, 'NOT_A_DRAFT');
  return q;
}

async function nextBlockSortOrder(quoteId: string): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`COALESCE(MAX(${quoteBlocks.sortOrder}), -1)` })
    .from(quoteBlocks)
    .where(eq(quoteBlocks.quoteId, quoteId));
  return Number(rows[0]?.max ?? -1) + 1;
}

async function nextLineSortOrder(quoteId: string): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`COALESCE(MAX(${quoteLines.sortOrder}), -1)` })
    .from(quoteLines)
    .where(eq(quoteLines.quoteId, quoteId));
  return Number(rows[0]?.max ?? -1) + 1;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Effective tax rate stamped onto a new quote, mirroring invoices'
 * `resolveEffectiveTaxRate` precedence: a tax-exempt customer wins (0), then the
 * org's own rate, then the partner's `default_tax_rate` (the "Invoice defaults →
 * Default tax rate" setting). Read in a SYSTEM context because the partner-axis
 * `partners` row is invisible to org-scoped request contexts — unlike invoices,
 * a quote has no later "issue" step to stamp the partner default, so the rate
 * must be resolved up front to show tax in the editor. Returns null (not an
 * all-zero fraction) when there is no tax, keeping a no-tax quote visually clean.
 */
async function resolveQuoteTaxRate(orgId: string, partnerId: string): Promise<string | null> {
  const rate = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [org] = await db.select({ taxExempt: organizations.taxExempt, taxRate: organizations.taxRate })
      .from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const [partner] = await db.select({ defaultTaxRate: partners.defaultTaxRate })
      .from(partners).where(eq(partners.id, partnerId)).limit(1);
    return resolveEffectiveTaxRate({
      taxExempt: org?.taxExempt ?? false,
      orgRate: org?.taxRate ?? null,
      partnerRate: partner?.defaultTaxRate ?? null,
    });
  }));
  return Number(rate) > 0 ? rate : null;
}

export async function createQuote(input: CreateQuoteInput, actor: QuoteActor) {
  const partnerId = resolvePartner(actor);
  assertOrg(actor, input.orgId);
  assertSite(actor, input.siteId ?? null);
  const taxRate = await resolveQuoteTaxRate(input.orgId, partnerId);
  // Number at creation (not at send): techs reference the number while drafting
  // and in the list. A deleted draft leaves a counter gap, which the numbering
  // contract explicitly tolerates (see allocateQuoteCounter). sendQuote keeps
  // this number and only allocates for legacy drafts that predate it.
  const year = new Date().getUTCFullYear();
  const counter = await allocateQuoteCounter(partnerId, year);
  const quoteNumber = formatQuoteNumber('Q', year, counter);
  const [row] = await db.insert(quotes).values({
    partnerId,
    orgId: input.orgId,
    siteId: input.siteId ?? null,
    quoteNumber,
    title: input.title?.trim() || null,
    currencyCode: input.currencyCode,
    taxRate,
    expiryDate: input.expiryDate ?? null,
    introNotes: input.introNotes ?? null,
    terms: input.terms ?? null,
    termsAndConditions: input.termsAndConditions ?? null,
    createdBy: actor.userId,
  }).returning();
  return row!;
}

/**
 * Remap a cloned quote's `coverPage.coverImageId` onto its freshly-cloned
 * `quoteImages` id (see the `imageIds` remap map in cloneQuote below) — mirrors
 * the image-block `content.imageId` remap in the same function. Every other
 * cover page field (title/enabled/preparedForName/showPreparedBy) is
 * document presentation, not customer- or image-specific, so it passes
 * through unchanged. A `null`/absent `coverPage`, or one with no
 * `coverImageId` set, is returned as-is.
 */
function remapCoverPageImageId(coverPage: unknown, imageIds: Map<string, string>): unknown {
  if (!coverPage || typeof coverPage !== 'object' || Array.isArray(coverPage)) return coverPage;
  const cp = coverPage as Record<string, unknown>;
  const sourceImageId = cp.coverImageId;
  if (typeof sourceImageId !== 'string') return coverPage;
  // Defensive fallback to null (rather than leaving the stale id) if the image
  // somehow isn't among the ones just cloned — a dangling reference is worse
  // than a missing cover image.
  return { ...cp, coverImageId: imageIds.get(sourceImageId) ?? null };
}

/**
 * Deep-copy an accessible quote into a new draft. Images and every aggregate
 * relationship receive fresh IDs because image rendering is constrained to
 * image.quote_id and line items can reference blocks, images, and parent lines.
 * Lifecycle, document, seller/customer snapshots, and expiry are intentionally
 * reset so an old accepted/expired quote is safe to revise and send again.
 *
 * `input` optionally retargets the clone to another organization of the same
 * partner and/or renames it. Retargeting clears the site and billToName (both
 * belong to the OLD customer) and re-resolves the tax rate for the new org —
 * the same precedence createQuote uses — so totals are correct for the new
 * customer; a same-org clone keeps the source rate verbatim (it may have been
 * hand-set via the API).
 */
export async function cloneQuote(id: string, actor: QuoteActor, input: CloneQuoteInput = {}) {
  const { quote: source, blocks, lines } = await getQuote(id, actor);
  const images = await db.select().from(quoteImages).where(eq(quoteImages.quoteId, id));

  const targetOrgId = input.orgId ?? source.orgId;
  const orgChanged = targetOrgId !== source.orgId;
  if (orgChanged) {
    assertOrg(actor, targetOrgId);
    // Retargeting lands the clone with a null site (the source's site belongs to
    // the OLD org), which a site-restricted caller can never see — deny exactly
    // as updateQuote's reassignment path does.
    assertSite(actor, null);
    // Same-partner guard. RLS hides other partners' orgs from this context, so a
    // cross-partner id resolves to "not found" rather than leaking existence.
    const [target] = await db.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.id, targetOrgId), eq(organizations.partnerId, source.partnerId)))
      .limit(1);
    if (!target) throw new QuoteServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    // Re-validate carried contract blocks against the NEW org: an org-owned
    // template from the source org is invalid for the target org (422), which
    // also prevents cloning a block that would later mint a cross-org
    // contract_documents → contract_templates FK. Partner-wide templates pass.
    await assertContractBlocksValidForOrg(blocks, { orgId: targetOrgId, partnerId: source.partnerId });
  }
  const taxRate = orgChanged
    ? await resolveQuoteTaxRate(targetOrgId, source.partnerId)
    : source.taxRate;
  const title = input.title !== undefined ? (input.title.trim() || null) : source.title;

  const year = new Date().getUTCFullYear();
  const counter = await allocateQuoteCounter(source.partnerId, year);
  const quoteNumber = formatQuoteNumber('Q', year, counter);
  const quoteId = randomUUID();

  const imageIds = new Map(images.map((image) => [image.id, randomUUID()]));
  const blockIds = new Map(blocks.map((block) => [block.id, randomUUID()]));
  const lineIds = new Map(lines.map((line) => [line.id, randomUUID()]));
  const totals = computeQuoteTotals(
    lines as QuoteLineForMath[],
    taxRate ? parseFloat(taxRate) : null,
    toQuoteDepositConfig(source.depositType, source.depositPercent),
  );

  // A clone must never mint a NEW orphan. Two source shapes produce one:
  //  - the source line is itself an orphan (block_id NULL — pre-#2553 rows, and
  //    prod quote 50a25127 cloned its orphan straight into becd81f4), or
  //  - its block is missing from `blockIds` (the old `?? null` silently nulled
  //    the line instead of failing loudly).
  // Both re-parent onto ONE fallback pricing section: the clone of the source's
  // earliest line_items block, or a fresh line_items block created in the SAME
  // transaction as the rest of the clone. resolveLineBlockId is deliberately NOT
  // reused here — it runs on the module-level `db`, outside this tx.
  const orphanedLines = lines.filter((line) => !line.blockId || !blockIds.has(line.blockId));
  // `blocks` comes back from getQuote ordered by sortOrder, so the first
  // line_items block IS the earliest one.
  const sourceDefaultBlock = blocks.find((block) => block.blockType === 'line_items');
  let fallbackBlockId: string | null = null;
  let fallbackBlock: typeof quoteBlocks.$inferInsert | null = null;
  if (orphanedLines.length > 0) {
    if (sourceDefaultBlock) {
      fallbackBlockId = blockIds.get(sourceDefaultBlock.id)!;
    } else {
      fallbackBlockId = randomUUID();
      fallbackBlock = {
        id: fallbackBlockId,
        quoteId,
        orgId: targetOrgId,
        blockType: 'line_items',
        content: {},
        sortOrder: blocks.reduce((max, block) => Math.max(max, block.sortOrder), -1) + 1,
      };
    }
  }

  return db.transaction(async (tx) => {
    const [cloned] = await tx.insert(quotes).values({
      id: quoteId,
      partnerId: source.partnerId,
      orgId: targetOrgId,
      siteId: orgChanged ? null : source.siteId,
      quoteNumber,
      title,
      status: 'draft',
      currencyCode: source.currencyCode,
      issueDate: null,
      expiryDate: null,
      acceptedAt: null,
      declinedAt: null,
      convertedAt: null,
      subtotal: totals.subtotal,
      taxRate,
      taxTotal: totals.taxTotal,
      total: totals.total,
      oneTimeTotal: totals.oneTimeTotal,
      monthlyRecurringTotal: totals.monthlyRecurringTotal,
      annualRecurringTotal: totals.annualRecurringTotal,
      depositType: source.depositType,
      depositPercent: source.depositPercent,
      depositAmount: totals.depositDueTotal,
      billToName: orgChanged ? null : source.billToName,
      billToAddress: null,
      billToTaxId: null,
      introNotes: source.introNotes,
      terms: source.terms,
      sellerSnapshot: null,
      // Cover page is document presentation, not customer-specific — carried
      // over verbatim (title/enabled/preparedForName/showPreparedBy) on both a
      // same-org and a retargeted clone. Its coverImageId is the one exception:
      // it references a quote_images row keyed to the OLD quote, and images get
      // fresh ids on clone (imageIds, above) — left unremapped it would point at
      // an id that doesn't exist under the new quote at all.
      coverPage: remapCoverPageImageId(source.coverPage, imageIds),
      termsAndConditions: source.termsAndConditions,
      declineReason: null,
      convertedInvoiceId: null,
      pdfDocumentRef: null,
      pdfSha256: null,
      sentAt: null,
      firstViewedAt: null,
      viewedAt: null,
      createdBy: actor.userId,
    }).returning();

    if (images.length > 0) {
      await tx.insert(quoteImages).values(images.map((image) => ({
        id: imageIds.get(image.id)!,
        quoteId,
        orgId: targetOrgId,
        imageData: image.imageData,
        mime: image.mime,
        byteSize: image.byteSize,
        sha256: image.sha256,
      })));
    }

    if (blocks.length > 0 || fallbackBlock) {
      const clonedBlocks = blocks.map((block) => {
        let content = block.content;
        if (block.blockType === 'image' && content && typeof content === 'object' && !Array.isArray(content)) {
          const sourceImageId = (content as Record<string, unknown>).imageId;
          const clonedImageId = typeof sourceImageId === 'string' ? imageIds.get(sourceImageId) : undefined;
          if (!clonedImageId) {
            throw new QuoteServiceError('Quote image could not be cloned', 409, 'IMAGE_NOT_FOUND');
          }
          content = { ...(content as Record<string, unknown>), imageId: clonedImageId };
        }
        return {
          id: blockIds.get(block.id)!,
          quoteId,
          orgId: targetOrgId,
          blockType: block.blockType,
          content,
          sortOrder: block.sortOrder,
        };
      });
      if (fallbackBlock) clonedBlocks.push(fallbackBlock as (typeof clonedBlocks)[number]);
      await tx.insert(quoteBlocks).values(clonedBlocks);
    }

    if (lines.length > 0) {
      await tx.insert(quoteLines).values(lines.map((line) => ({
        id: lineIds.get(line.id)!,
        quoteId,
        blockId: (line.blockId ? blockIds.get(line.blockId) : undefined) ?? fallbackBlockId!,
        orgId: targetOrgId,
        sourceType: line.sourceType,
        catalogItemId: line.catalogItemId,
        parentLineId: line.parentLineId ? lineIds.get(line.parentLineId) ?? null : null,
        name: line.name,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxable: line.taxable,
        customerVisible: line.customerVisible,
        lineTotal: line.lineTotal,
        recurrence: line.recurrence,
        termMonths: line.termMonths,
        billingFrequency: line.billingFrequency,
        unitCost: line.unitCost,
        depositEligible: line.depositEligible,
        itemType: line.itemType,
        sku: line.sku,
        partNumber: line.partNumber,
        imageId: line.imageId ? imageIds.get(line.imageId) ?? null : null,
        sortOrder: line.sortOrder,
      })));
    }

    return cloned!;
  });
}

export async function getQuote(id: string, actor: QuoteActor) {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertQuoteAccess(actor, q);
  const blocks = sanitizeQuoteBlocksForRead(
    await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder)
  );
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder);
  // Quote acceptance returns the staged order id once, but the technician may
  // reload or open the converted quote later. Keep discoverability in the quote
  // read model itself. The quote access check runs first, and the lookup repeats
  // the partner + org axes in addition to relying on the tables' forced RLS.
  const [pax8OrderSummary] = await db.select({ pax8OrderId: pax8Orders.id }).from(pax8Orders).where(and(
    eq(pax8Orders.sourceQuoteId, id),
    eq(pax8Orders.partnerId, q.partnerId),
    eq(pax8Orders.orgId, q.orgId),
  )).orderBy(desc(pax8Orders.createdAt)).limit(1);
  const [pax8OrderLineSummary] = pax8OrderSummary
    ? await db.select({ count: count(pax8OrderLines.id) }).from(pax8OrderLines).where(and(
        eq(pax8OrderLines.orderId, pax8OrderSummary.pax8OrderId),
        eq(pax8OrderLines.partnerId, q.partnerId),
        eq(pax8OrderLines.orgId, q.orgId),
      ))
    : [];
  // dueOnAcceptanceTotal is a derived (non-persisted) figure: the amount accept
  // actually invoices (one-time lines only — recurring is deferred to the Phase 4
  // contract). Computed from the canonical quoteMath so it stays penny-consistent
  // with quoteAcceptService's invoice, and so the UI can advertise an accurate
  // "due on acceptance" instead of the recurring-inclusive `total` (see #bug).
  const totals = computeQuoteTotals(
    lines as QuoteLineForMath[],
    q.taxRate ? parseFloat(q.taxRate) : null,
    toQuoteDepositConfig(q.depositType, q.depositPercent),
  );
  // Resolve the customer "bill to" for display. Keyed on quote STATUS, not on
  // whether the frozen fields happen to be populated:
  //  - A NON-DRAFT quote carries its own frozen snapshot, written at send time
  //    from the org's Billing settings. Return it VERBATIM — never re-derive from
  //    the live org — so the issued document stays immutable even if the org's
  //    billing address is edited afterwards. (An org with no address at send time
  //    froze an all-null block; that blank is the correct, immutable record.)
  //  - A DRAFT has no frozen snapshot yet, so fall back to the SAME org columns
  //    the send path will freeze, surfacing the customer name + address on the
  //    draft's preview/PDF instead of a blank block. A tech-entered billToName
  //    override still wins over the org name.
  const frozenAddress = (q.billToAddress as BillToAddress | null) ?? null;
  let billTo: { name: string | null; address: BillToAddress | null; taxId: string | null };
  if (q.status === 'draft') {
    const [org] = await db
      .select({
        name: organizations.name,
        taxId: organizations.taxId,
        billingAddressLine1: organizations.billingAddressLine1,
        billingAddressLine2: organizations.billingAddressLine2,
        billingAddressCity: organizations.billingAddressCity,
        billingAddressRegion: organizations.billingAddressRegion,
        billingAddressPostalCode: organizations.billingAddressPostalCode,
        billingAddressCountry: organizations.billingAddressCountry,
      })
      .from(organizations)
      .where(eq(organizations.id, q.orgId))
      .limit(1);
    if (!org) {
      // getQuote just read this quote in the SAME context, so its org should be
      // visible too — an unreadable org is anomalous. Mirror the send path's
      // telemetry (quoteLifecycle) rather than let a blank bill-to be silent.
      console.error(`[quoteService] org ${q.orgId} not readable while resolving draft bill-to for quote ${q.id} — showing an empty bill-to`);
    }
    const hasFrozenAddress = !!frozenAddress
      && Object.values(frozenAddress).some((v) => typeof v === 'string' && v.trim().length > 0);
    billTo = {
      name: q.billToName?.trim() ? q.billToName : (org?.name ?? null),
      address: hasFrozenAddress ? frozenAddress : buildBillToAddress(org),
      taxId: q.billToTaxId ?? org?.taxId ?? null,
    };
  } else {
    billTo = {
      name: q.billToName ?? null,
      address: frozenAddress,
      taxId: q.billToTaxId ?? null,
    };
  }
  return {
    quote: {
      ...q,
      dueOnAcceptanceTotal: totals.dueOnAcceptanceTotal,
      depositDueTotal: totals.depositDueTotal,
      categoryBreakdown: totals.categoryBreakdown,
    },
    blocks,
    lines,
    billTo,
    pax8OrderId: pax8OrderSummary?.pax8OrderId ?? null,
    pax8OrderLineCount: Number(pax8OrderLineSummary?.count ?? 0),
  };
}

export async function listQuotes(query: ListQuotesQuery, actor: QuoteActor) {
  const conds = [] as Array<ReturnType<typeof eq>>;
  if (query.orgId) { assertOrg(actor, query.orgId); conds.push(eq(quotes.orgId, query.orgId)); }
  if (query.status) conds.push(eq(quotes.status, query.status as never));
  // Site-restricted callers only see quotes assigned to a site in their allowlist.
  // `siteId IN (...)` is false for NULL, so null-site (org-level) quotes are
  // excluded — consistent with assertSite denying a restricted caller a null site.
  if (actor.allowedSiteIds) conds.push(inArray(quotes.siteId, actor.allowedSiteIds) as ReturnType<typeof eq>);
  // Deterministic keyset: order by (createdAt, id) desc; cursor is the last row's id.
  if (query.cursor) {
    const [c] = await db.select({ createdAt: quotes.createdAt }).from(quotes).where(eq(quotes.id, query.cursor)).limit(1);
    if (c) {
      conds.push(or(
        lt(quotes.createdAt, c.createdAt),
        and(eq(quotes.createdAt, c.createdAt), lt(quotes.id, query.cursor))
      ) as ReturnType<typeof eq>);
    }
  }
  // Left-join the converted invoice so the list badge can reflect the invoice's
  // money state (deposit paid/unpaid). The join is null for unconverted quotes;
  // the mapped fields then stay null and the UI shows the plain "Deposit" chip.
  const rows = await db.select({
    quote: quotes,
    invoiceDepositDue: invoices.depositDue,
    invoiceAmountPaid: invoices.amountPaid,
  }).from(quotes)
    .leftJoin(invoices, eq(invoices.id, quotes.convertedInvoiceId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(quotes.createdAt), desc(quotes.id))
    .limit(query.limit);
  return rows.map((r) => ({ ...r.quote, invoiceDepositDue: r.invoiceDepositDue, invoiceAmountPaid: r.invoiceAmountPaid }));
}

/** Draft-only header edit. Only provided fields are written; nullable fields can be
 *  explicitly cleared with null. A tax-rate change triggers a totals recompute.
 *
 *  `orgId` reassigns the draft to another organization of the same partner:
 *  the site is cleared (it belongs to the old customer), the billToName
 *  override is cleared and the tax rate re-resolved for the new org (each
 *  unless the same patch sets a fresh value explicitly), and the denormalized
 *  org_id on blocks/lines/images is moved in the same transaction so
 *  RLS-scoped readers never see a half-moved quote. */
export async function updateQuote(id: string, input: UpdateQuoteInput, actor: QuoteActor) {
  const q = await loadDraft(id, actor);
  // A site-restricted caller may not move the quote to a site it can't access
  // (nor clear it to null, which a restricted caller can never see).
  if (input.siteId !== undefined) assertSite(actor, input.siteId);
  const orgChanged = input.orgId !== undefined && input.orgId !== q.orgId;
  // Re-resolved org tax default; undefined = org unchanged (keep current rate).
  let orgTaxRate: string | null | undefined;
  if (orgChanged) {
    const targetOrgId = input.orgId!;
    assertOrg(actor, targetOrgId);
    // Reassignment clears the site, and a site-restricted caller can never see a
    // null-site quote — deny exactly as assertSite would for an explicit null.
    assertSite(actor, null);
    // Same-partner guard; RLS hides other partners' orgs so a cross-partner id
    // resolves to "not found" rather than leaking existence.
    const [target] = await db.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.id, targetOrgId), eq(organizations.partnerId, q.partnerId)))
      .limit(1);
    if (!target) throw new QuoteServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    if (input.taxRate === undefined) orgTaxRate = await resolveQuoteTaxRate(targetOrgId, q.partnerId);
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.siteId !== undefined) set.siteId = input.siteId;
  if (input.title !== undefined) set.title = input.title === null ? null : input.title.trim() || null;
  if (input.expiryDate !== undefined) set.expiryDate = input.expiryDate;
  if (input.introNotes !== undefined) set.introNotes = input.introNotes;
  if (input.terms !== undefined) set.terms = input.terms;
  if (input.termsAndConditions !== undefined) set.termsAndConditions = input.termsAndConditions;
  if (input.billToName !== undefined) set.billToName = input.billToName;
  // Numeric tax_rate takes a fixed-string value; null clears it.
  if (input.taxRate !== undefined) set.taxRate = input.taxRate === null ? null : Number(input.taxRate).toFixed(5);
  if (input.coverPage !== undefined) {
    // Ownership check mirrors updateLine's imageId guard: coverImageId must be a
    // quote_images row on THIS quote, or a caller could point the cover at
    // another tenant's image and exfiltrate its bytes through the customer
    // document/PDF. Only checked when a cover page object with a non-null
    // coverImageId is being set — `null` (clear the whole cover page) skips it.
    if (input.coverPage !== null && input.coverPage.coverImageId) {
      const [img] = await db.select({ id: quoteImages.id }).from(quoteImages)
        .where(and(eq(quoteImages.id, input.coverPage.coverImageId), eq(quoteImages.quoteId, id))).limit(1);
      if (!img) throw new QuoteServiceError('Cover image not found on this quote', 404, 'IMAGE_NOT_FOUND');
    }
    set.coverPage = input.coverPage;
  }
  if (input.depositType !== undefined || input.depositPercent !== undefined) {
    const lines = await db.select({
      quantity: quoteLines.quantity, unitPrice: quoteLines.unitPrice,
      taxable: quoteLines.taxable, customerVisible: quoteLines.customerVisible,
      recurrence: quoteLines.recurrence, depositEligible: quoteLines.depositEligible,
    }).from(quoteLines).where(eq(quoteLines.quoteId, id));
    const nextType = input.depositType ?? q.depositType;
    const nextPercent = input.depositPercent !== undefined ? input.depositPercent : q.depositPercent;
    // Include an in-flight taxRate change from THIS SAME patch — a deposit
    // validated against the stale persisted rate could pass here and then fail
    // (or silently mis-total) once the new tax rate lands via recomputeAndPersist.
    // An org change re-resolves the rate too (orgTaxRate) and must be coherent
    // the same way.
    const effectiveTaxRate = input.taxRate !== undefined
      ? input.taxRate
      : orgTaxRate !== undefined
        ? (orgTaxRate ? parseFloat(orgTaxRate) : null)
        : (q.taxRate ? parseFloat(q.taxRate) : null);
    const check = validateQuoteDeposit(
      lines as QuoteLineForMath[],
      effectiveTaxRate === null ? null : Number(effectiveTaxRate),
      toQuoteDepositConfig(nextType, nextPercent),
    );
    if (!check.ok) throw new QuoteServiceError(check.message, 400, check.code);
    set.depositType = nextType;
    set.depositPercent = nextType === 'percent' && nextPercent != null ? Number(nextPercent).toFixed(2) : null;
  }
  if (orgChanged) {
    const targetOrgId = input.orgId!;
    set.orgId = targetOrgId;
    // The site belongs to the OLD org — always cleared, even if the same patch
    // named one (a site can't be validated against the new org here).
    set.siteId = null;
    // A billToName override referenced the old customer; drop it so the draft
    // bill-to falls back to the new org's name/address, unless this same patch
    // sets a fresh override explicitly.
    if (input.billToName === undefined) set.billToName = null;
    if (orgTaxRate !== undefined) set.taxRate = orgTaxRate;
    // Re-validate carried contract blocks against the NEW org before moving the
    // quote onto it: an org-owned template embedded under the old org is invalid
    // (422) for the target org — carrying it would expose another org's private
    // legal template and create a cross-org contract_documents → contract_templates
    // FK that aborts GDPR erasure. Partner-wide templates (org_id NULL) pass.
    const contractBlocks = await db.select({ blockType: quoteBlocks.blockType, content: quoteBlocks.content })
      .from(quoteBlocks)
      .where(and(eq(quoteBlocks.quoteId, id), eq(quoteBlocks.blockType, 'contract')));
    await db.transaction(async (tx) => {
      await assertContractBlocksValidForOrg(contractBlocks, { orgId: targetOrgId, partnerId: q.partnerId }, tx);
      await tx.update(quotes).set(set).where(eq(quotes.id, id));
      // Move the denormalized org_id on every child row in the same transaction.
      await tx.update(quoteBlocks).set({ orgId: targetOrgId }).where(eq(quoteBlocks.quoteId, id));
      await tx.update(quoteLines).set({ orgId: targetOrgId }).where(eq(quoteLines.quoteId, id));
      await tx.update(quoteImages).set({ orgId: targetOrgId }).where(eq(quoteImages.quoteId, id));
      // Recompute INSIDE the transaction: a failure here must roll back the org
      // move too, never commit the quote onto the new org with totals still
      // computed under the old tax rate.
      await recomputeAndPersist(id, tx);
    });
  } else {
    await db.update(quotes).set(set).where(eq(quotes.id, id));
    await recomputeAndPersist(id);
  }
  const [updated] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return updated!;
}

export async function deleteDraftQuote(id: string, actor: QuoteActor) {
  await loadDraft(id, actor);
  await db.delete(quotes).where(eq(quotes.id, id)); // blocks/lines cascade
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * Validate a `contract` block's content BEFORE insert/update: the referenced
 * template version must exist and belong to the named template, be
 * `status='published'` (drafts are never embeddable — they can still change),
 * the template itself must not be archived, and the template must be visible
 * to THIS quote's org/partner — org-owned → same org as the quote; partner-
 * owned → same partner as the quote (Partner-Wide First, epic #2135). Every
 * violation collapses to a single 422 INVALID_CONTRACT_TEMPLATE so a caller
 * can't distinguish "wrong template" from "not published yet" from
 * "not yours" — none of those distinctions are actionable without also
 * leaking the existence of another tenant's template.
 */
/** Narrow a `contract` block's stored `content` to its template reference, or
 *  null if the shape is unexpected (defensive — the block was validated on
 *  write). Used by the org-change paths to re-validate carried contract blocks. */
function parseContractBlockRef(content: unknown): { templateId: string; templateVersionId: string } | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const c = content as Record<string, unknown>;
  if (typeof c.templateId !== 'string' || typeof c.templateVersionId !== 'string') return null;
  return { templateId: c.templateId, templateVersionId: c.templateVersionId };
}

/** Re-validate every `contract` block on a quote against a (possibly new) target
 *  org. Called from the clone-retarget and draft org-reassignment paths: an
 *  org-owned template embedded under the SOURCE org is neither visible nor valid
 *  under the TARGET org, and carrying it verbatim both exposes another org's
 *  private legal template AND creates a cross-org contract_documents →
 *  contract_templates FK that aborts GDPR org erasure. Partner-wide templates
 *  (org_id NULL) stay valid because clone/reassign never crosses partners. */
async function assertContractBlocksValidForOrg(
  blocks: Array<{ blockType: string; content: unknown }>,
  target: { orgId: string; partnerId: string },
  dbc: Pick<typeof db, 'select'> = db,
): Promise<void> {
  for (const block of blocks) {
    if (block.blockType !== 'contract') continue;
    const ref = parseContractBlockRef(block.content);
    if (ref) await assertContractBlockValid(ref, target, dbc);
  }
}

async function assertContractBlockValid(
  content: { templateId: string; templateVersionId: string },
  quote: { orgId: string; partnerId: string },
  dbc: Pick<typeof db, 'select'> = db,
): Promise<void> {
  const [version] = await dbc.select({
    templateId: contractTemplateVersions.templateId,
    status: contractTemplateVersions.status,
  }).from(contractTemplateVersions).where(eq(contractTemplateVersions.id, content.templateVersionId)).limit(1);
  if (!version || version.templateId !== content.templateId || version.status !== 'published') {
    throw new QuoteServiceError('Contract template version is not published', 422, 'INVALID_CONTRACT_TEMPLATE');
  }
  const [template] = await dbc.select({
    status: contractTemplates.status,
    orgId: contractTemplates.orgId,
    partnerId: contractTemplates.partnerId,
  }).from(contractTemplates).where(eq(contractTemplates.id, content.templateId)).limit(1);
  if (!template || template.status === 'archived') {
    throw new QuoteServiceError('Contract template is archived or no longer exists', 422, 'INVALID_CONTRACT_TEMPLATE');
  }
  // XOR ownership (contract_templates_one_owner_chk): org-owned templates are
  // visible only to that org; partner-wide templates (orgId NULL) are visible
  // to every org of that partner.
  const visible = template.orgId !== null ? template.orgId === quote.orgId : template.partnerId === quote.partnerId;
  if (!visible) {
    throw new QuoteServiceError('Contract template is not visible to this organization', 422, 'INVALID_CONTRACT_TEMPLATE');
  }
}

export async function addBlock(quoteId: string, input: QuoteBlockInput, actor: QuoteActor) {
  const q = await loadDraft(quoteId, actor);
  if (input.blockType === 'contract') {
    await assertContractBlockValid(input.content, q);
  }
  const sortOrder = await nextBlockSortOrder(quoteId);
  const [row] = await db.insert(quoteBlocks).values({
    quoteId,
    orgId: q.orgId,
    blockType: input.blockType,
    content: sanitizeBlockContentForWrite(input),
    sortOrder,
  }).returning();
  return row!;
}

/**
 * Update a block's content in place (heading text/level, rich-text html, image
 * caption/width, or a line_items section title). The block type is immutable —
 * the request must restate the existing type so the discriminated-union content
 * shape is validated, and a mismatch is rejected. Content edits never touch
 * lines, so no totals recompute is needed.
 */
export async function updateBlock(quoteId: string, blockId: string, input: QuoteBlockInput, actor: QuoteActor) {
  const q = await loadDraft(quoteId, actor);
  const [existing] = await db.select({ blockType: quoteBlocks.blockType })
    .from(quoteBlocks)
    .where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, quoteId)))
    .limit(1);
  if (!existing) throw new QuoteServiceError('Block not found', 404, 'BLOCK_NOT_FOUND');
  if (existing.blockType !== input.blockType) {
    throw new QuoteServiceError('Block type cannot be changed', 400, 'BLOCK_TYPE_MISMATCH');
  }
  if (input.blockType === 'contract') {
    await assertContractBlockValid(input.content, q);
  }
  const [row] = await db.update(quoteBlocks)
    .set({ content: sanitizeBlockContentForWrite(input) })
    .where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, quoteId)))
    .returning();
  return row!;
}

/**
 * Delete a block and any lines attached to it. Deleting the block's lines first
 * (rather than relying solely on a DB cascade) keeps a pricing-table section's
 * removal atomic at the app layer — removing a line_items block also removes its
 * lines, never orphaning them — and lets recomputeAndPersist re-derive the
 * header totals from the lines that remain.
 */
export async function deleteBlock(quoteId: string, blockId: string, actor: QuoteActor) {
  await loadDraft(quoteId, actor);
  await db.delete(quoteLines).where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.blockId, blockId)));
  await db.delete(quoteBlocks).where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, quoteId)));
  await recomputeAndPersist(quoteId);
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/**
 * Resolve the block a new line should live in. A caller-supplied blockId is used
 * as-is; when it's omitted (the API / MCP add-line path — the web editor always
 * passes one), the line is attached to the quote's default pricing section: the
 * earliest existing line_items block, or a fresh one created on demand.
 *
 * Without this, a blockId-less line became an "orphan" — counted in the totals
 * and drawn in the PDF's trailing table, but NEVER rendered in the editor (which
 * only walks line_items blocks). The result was a quote showing a real dollar
 * total while the builder said "No content yet", uneditable from the UI (#2553).
 */
async function resolveLineBlockId(quoteId: string, orgId: string, blockId: string | null | undefined): Promise<string> {
  if (blockId) return blockId;
  const [existing] = await db
    .select({ id: quoteBlocks.id })
    .from(quoteBlocks)
    .where(and(eq(quoteBlocks.quoteId, quoteId), eq(quoteBlocks.blockType, 'line_items')))
    .orderBy(quoteBlocks.sortOrder)
    .limit(1);
  if (existing) return existing.id;
  const sortOrder = await nextBlockSortOrder(quoteId);
  const [block] = await db
    .insert(quoteBlocks)
    .values({ quoteId, orgId, blockType: 'line_items', content: {}, sortOrder })
    .returning({ id: quoteBlocks.id });
  return block!.id;
}

export async function addManualLine(quoteId: string, input: QuoteLineInput, actor: QuoteActor) {
  const q = await loadDraft(quoteId, actor);
  const quantity = String(input.quantity);
  const unitPrice = Number(input.unitPrice).toFixed(2);
  const blockId = await resolveLineBlockId(quoteId, q.orgId, input.blockId);
  const sortOrder = await nextLineSortOrder(quoteId);
  const [row] = await db.insert(quoteLines).values({
    quoteId,
    orgId: q.orgId,
    blockId,
    sourceType: input.sourceType,
    catalogItemId: input.catalogItemId ?? null,
    name: input.name ?? null,
    description: input.description ?? null,
    quantity,
    unitPrice,
    taxable: input.taxable,
    customerVisible: input.customerVisible,
    lineTotal: computeLineTotal(quantity, unitPrice),
    recurrence: input.recurrence,
    termMonths: input.termMonths ?? null,
    billingFrequency: input.billingFrequency ?? null,
    unitCost: input.unitCost != null ? Number(input.unitCost).toFixed(2) : null,
    sku: input.sku ?? null,
    partNumber: input.partNumber ?? null,
    depositEligible: input.depositEligible ?? false,
    itemType: null,
    sortOrder,
  }).returning();
  await recomputeAndPersist(quoteId);
  return row!;
}

/**
 * Add a line sourced from a catalog item, snapshotting price/recurrence/term/
 * frequency/description/taxable at add-time so a later catalog edit never
 * mutates an existing quote line. recurrence is derived from the item's
 * billing model: a recurring item bills annually if billing_frequency is
 * 'annual', otherwise monthly; a one-time item is 'one_time'.
 */
export async function addCatalogLine(
  quoteId: string,
  catalogItemId: string,
  quantity: number,
  blockId: string | undefined,
  actor: QuoteActor,
  options?: { partNumber?: string | null }
) {
  const q = await loadDraft(quoteId, actor);
  // Scope the catalog lookup to the quote's OWN partner. catalog_items is
  // partner-axis RLS, which contains a foreign item for a partner-scope caller —
  // but under SYSTEM scope the partner predicate short-circuits, so without this
  // explicit filter a system-scope request could snapshot another partner's
  // catalog item (name/price/taxable/billingType) into the quote line and bind a
  // foreign catalog_item_id FK. Mirrors invoiceService → catalogService's
  // getOwnedItemOr404(id, partnerId): a foreign item resolves to not-found
  // regardless of read scope.
  const [item] = await db.select().from(catalogItems)
    .where(and(eq(catalogItems.id, catalogItemId), eq(catalogItems.partnerId, q.partnerId)))
    .limit(1);
  if (!item) throw new QuoteServiceError('Catalog item not found', 404, 'CATALOG_ITEM_NOT_FOUND');
  // Phase 1 recurrence is monthly|annual only; quarterly is not offered (dropped
  // from the catalog Zod enum). The DB enum retains 'quarterly' for a future phase.
  const recurrence = item.billingType === 'recurring'
    ? (item.billingFrequency === 'annual' ? 'annual' : 'monthly')
    : 'one_time';
  const qty = String(quantity);
  const resolvedBlockId = await resolveLineBlockId(quoteId, q.orgId, blockId);
  const sortOrder = await nextLineSortOrder(quoteId);
  const [row] = await db.insert(quoteLines).values({
    quoteId,
    orgId: q.orgId,
    blockId: resolvedBlockId,
    sourceType: 'catalog',
    catalogItemId,
    // Mirror the catalog item: its name is the line title, its description the blurb.
    name: item.name,
    description: item.description ?? null,
    quantity: qty,
    unitPrice: item.unitPrice,
    taxable: item.taxable,
    customerVisible: true,
    lineTotal: computeLineTotal(qty, item.unitPrice),
    recurrence,
    termMonths: item.commitmentTermMonths ?? null,
    billingFrequency: item.billingFrequency ?? null,
    // Snapshot internal economics from the catalog item at add-time so a later
    // catalog edit never mutates existing quote line cost/sku data.
    unitCost: item.costBasis ?? null,
    sku: item.sku ?? null,
    partNumber: options?.partNumber ?? null,
    // Deposit eligibility defaults from the catalog item's type — hardware is the
    // one category a deposit typically secures (custom order, restocking risk).
    // itemType is snapshotted at add-time so a later catalog recategorization
    // never reshuffles an existing quote's category breakdown or deposit math.
    depositEligible: item.itemType === 'hardware',
    itemType: item.itemType,
    sortOrder,
  }).returning();
  await recomputeAndPersist(quoteId);
  return row!;
}

export async function updateLine(
  quoteId: string,
  lineId: string,
  input: {
    name?: string | null; description?: string | null; quantity?: number; unitPrice?: number;
    taxable?: boolean; customerVisible?: boolean;
    recurrence?: 'one_time' | 'monthly' | 'annual';
    termMonths?: number | null; sortOrder?: number;
    unitCost?: number | null; sku?: string | null; partNumber?: string | null;
    imageId?: string | null;
    depositEligible?: boolean;
  },
  actor: QuoteActor
) {
  await loadDraft(quoteId, actor);
  const [existing] = await db.select().from(quoteLines)
    .where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId))).limit(1);
  if (!existing) throw new QuoteServiceError('Line not found', 404, 'LINE_NOT_FOUND');
  const quantity = input.quantity != null ? String(input.quantity) : existing.quantity;
  const unitPrice = input.unitPrice != null ? Number(input.unitPrice).toFixed(2) : existing.unitPrice;
  const set: Record<string, unknown> = {
    // name/description are independently patchable; undefined leaves them as-is,
    // an explicit null clears them (the refine on the route schema keeps ≥1 set).
    name: input.name !== undefined ? input.name : existing.name,
    description: input.description !== undefined ? input.description : existing.description,
    quantity,
    unitPrice,
    taxable: input.taxable ?? existing.taxable,
    customerVisible: input.customerVisible ?? existing.customerVisible,
    recurrence: input.recurrence ?? existing.recurrence,
    lineTotal: computeLineTotal(quantity, unitPrice),
  };
  if (input.termMonths !== undefined) set.termMonths = input.termMonths;
  if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
  if (input.unitCost !== undefined) set.unitCost = input.unitCost != null ? Number(input.unitCost).toFixed(2) : null;
  if (input.sku !== undefined) set.sku = input.sku;
  if (input.partNumber !== undefined) set.partNumber = input.partNumber;
  if (input.depositEligible !== undefined) set.depositEligible = input.depositEligible;
  if (input.imageId !== undefined) {
    // Ownership check: the image must be a quote_images row on THIS quote, or a
    // caller could point a line at another tenant's image and exfiltrate its
    // bytes through the customer document/PDF.
    if (input.imageId !== null) {
      const [img] = await db.select({ id: quoteImages.id }).from(quoteImages)
        .where(and(eq(quoteImages.id, input.imageId), eq(quoteImages.quoteId, quoteId))).limit(1);
      if (!img) throw new QuoteServiceError('Image not found on this quote', 404, 'IMAGE_NOT_FOUND');
    }
    set.imageId = input.imageId;
  }
  await db.update(quoteLines).set(set).where(eq(quoteLines.id, lineId));
  await recomputeAndPersist(quoteId);
  const [updated] = await db.select().from(quoteLines).where(eq(quoteLines.id, lineId)).limit(1);
  return updated!;
}

export async function removeLine(quoteId: string, lineId: string, actor: QuoteActor) {
  await loadDraft(quoteId, actor);
  await db.delete(quoteLines).where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId)));
  await recomputeAndPersist(quoteId);
}

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

export async function reorderBlocks(quoteId: string, blockIds: string[], actor: QuoteActor) {
  await loadDraft(quoteId, actor);
  const existing = await db.select({ id: quoteBlocks.id }).from(quoteBlocks).where(eq(quoteBlocks.quoteId, quoteId));
  const existingSet = new Set(existing.map(r => r.id));
  // Use the deduped set size so a duplicated id (e.g. [A, A]) can't masquerade as
  // a full permutation — that would renumber A twice and orphan another block's
  // sort_order. (The zod schema also rejects duplicates; this is defense in depth.)
  if (new Set(blockIds).size !== existing.length || !blockIds.every(id => existingSet.has(id))) {
    throw new QuoteServiceError('Block IDs do not match quote blocks', 400, 'REORDER_IDS_MISMATCH');
  }
  await db.transaction(async (tx) => {
    for (const [i, id] of blockIds.entries()) {
      await tx.update(quoteBlocks).set({ sortOrder: i }).where(and(eq(quoteBlocks.id, id), eq(quoteBlocks.quoteId, quoteId)));
    }
  });
}

export async function reorderLines(quoteId: string, blockId: string, lineIds: string[], actor: QuoteActor) {
  await loadDraft(quoteId, actor);
  const [block] = await db.select({ id: quoteBlocks.id }).from(quoteBlocks)
    .where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, quoteId)))
    .limit(1);
  if (!block) throw new QuoteServiceError('Block not found', 404, 'BLOCK_NOT_FOUND');
  const existing = await db.select({ id: quoteLines.id }).from(quoteLines)
    .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.blockId, blockId)));
  const existingSet = new Set(existing.map(r => r.id));
  // Deduped size guards against a duplicated id passing the permutation check
  // (see reorderBlocks). The zod schema also rejects duplicates.
  if (new Set(lineIds).size !== existing.length || !lineIds.every(id => existingSet.has(id))) {
    throw new QuoteServiceError('Line IDs do not match block lines', 400, 'REORDER_IDS_MISMATCH');
  }
  await db.transaction(async (tx) => {
    for (const [i, id] of lineIds.entries()) {
      await tx.update(quoteLines).set({ sortOrder: i }).where(and(eq(quoteLines.id, id), eq(quoteLines.quoteId, quoteId), eq(quoteLines.blockId, blockId)));
    }
  });
}

/**
 * Move a line to a different line_items block on the SAME quote, appending it
 * (and any bundle children, preserving their relative order) to the end of the
 * target block's sort order. Bundle children can never be moved independently
 * — they ride with their parent. Totals are untouched: a move changes no
 * amounts, so there is no recomputeAndPersist here.
 */
export async function moveLineToBlock(
  quoteId: string,
  lineId: string,
  targetBlockId: string,
  actor: QuoteActor
) {
  await loadDraft(quoteId, actor);
  const [line] = await db.select().from(quoteLines)
    .where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId))).limit(1);
  if (!line) throw new QuoteServiceError('Line not found', 404, 'LINE_NOT_FOUND');
  if (line.parentLineId) {
    throw new QuoteServiceError('Bundle child lines move with their parent', 400, 'LINE_IS_BUNDLE_CHILD');
  }
  const [block] = await db.select({ id: quoteBlocks.id, blockType: quoteBlocks.blockType })
    .from(quoteBlocks)
    .where(and(eq(quoteBlocks.id, targetBlockId), eq(quoteBlocks.quoteId, quoteId))).limit(1);
  if (!block) throw new QuoteServiceError('Block not found', 404, 'BLOCK_NOT_FOUND');
  if (block.blockType !== 'line_items') {
    throw new QuoteServiceError('Target block is not a pricing table', 400, 'BLOCK_NOT_LINE_ITEMS');
  }
  if (line.blockId === targetBlockId) return line; // already there — no-op

  const [maxRow] = await db
    .select({ max: sql<number>`COALESCE(MAX(${quoteLines.sortOrder}), -1)` })
    .from(quoteLines)
    .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.blockId, targetBlockId)));
  const base = Number(maxRow?.max ?? -1) + 1;

  await db.transaction(async (tx) => {
    await tx.update(quoteLines).set({ blockId: targetBlockId, sortOrder: base })
      .where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId)));
    const children = await tx.select({ id: quoteLines.id }).from(quoteLines)
      .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.parentLineId, lineId)))
      .orderBy(quoteLines.sortOrder);
    for (const [i, child] of children.entries()) {
      await tx.update(quoteLines).set({ blockId: targetBlockId, sortOrder: base + 1 + i })
        .where(eq(quoteLines.id, child.id));
    }
  });

  const [updated] = await db.select().from(quoteLines).where(eq(quoteLines.id, lineId)).limit(1);
  return updated!;
}
