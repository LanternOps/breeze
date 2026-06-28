import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteLines, quoteBlocks } from '../db/schema/quotes';
import { organizations, partners } from '../db/schema/orgs';
import { catalogItems } from '../db/schema/catalog';
import { computeLineTotal, resolveEffectiveTaxRate } from './invoiceMath';
import { computeQuoteTotals, type QuoteLineForMath } from './quoteMath';
import { QuoteServiceError, type QuoteActor } from './quoteTypes';
import type {
  CreateQuoteInput, UpdateQuoteInput, QuoteLineInput, QuoteBlockInput, ListQuotesQuery
} from '@breeze/shared';

// ---------------------------------------------------------------------------
// Actor guards. The RLS access context (withDbAccessContext) is established by
// the caller — the route middleware in production, the test harness in
// integration tests — exactly like invoiceService. The service itself uses the
// bare `db` proxy directly; it never opens its own context.
// ---------------------------------------------------------------------------

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
 * Recompute the header buckets (subtotal/tax/total + one-time/monthly/annual)
 * from the quote's current lines. Runs after EVERY line insert/update/delete
 * and after any header update (tax rate is the only header field that moves
 * totals). Routes per-line cents through the shared
 * computeLineTotal/toCents discipline (via computeQuoteTotals) so the header
 * totals are penny-consistent with the persisted line_total and with invoices.
 */
async function recomputeAndPersist(quoteId: string): Promise<void> {
  const [q] = await db.select({ taxRate: quotes.taxRate }).from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  const lines = await db.select({
    quantity: quoteLines.quantity,
    unitPrice: quoteLines.unitPrice,
    taxable: quoteLines.taxable,
    customerVisible: quoteLines.customerVisible,
    recurrence: quoteLines.recurrence,
  }).from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
  const totals = computeQuoteTotals(lines as QuoteLineForMath[], q?.taxRate ? parseFloat(q.taxRate) : null);
  await db.update(quotes).set({
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    oneTimeTotal: totals.oneTimeTotal,
    monthlyRecurringTotal: totals.monthlyRecurringTotal,
    annualRecurringTotal: totals.annualRecurringTotal,
    updatedAt: new Date(),
  }).where(eq(quotes.id, quoteId));
}

/** Load a quote and assert it is owned/accessible AND still a draft (409 if not). */
async function loadDraft(quoteId: string, actor: QuoteActor) {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertOrg(actor, q.orgId);
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
  const taxRate = await resolveQuoteTaxRate(input.orgId, partnerId);
  const [row] = await db.insert(quotes).values({
    partnerId,
    orgId: input.orgId,
    siteId: input.siteId ?? null,
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

export async function getQuote(id: string, actor: QuoteActor) {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertOrg(actor, q.orgId);
  const blocks = await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder);
  const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder);
  // dueOnAcceptanceTotal is a derived (non-persisted) figure: the amount accept
  // actually invoices (one-time lines only — recurring is deferred to the Phase 4
  // contract). Computed from the canonical quoteMath so it stays penny-consistent
  // with quoteAcceptService's invoice, and so the UI can advertise an accurate
  // "due on acceptance" instead of the recurring-inclusive `total` (see #bug).
  const totals = computeQuoteTotals(lines as QuoteLineForMath[], q.taxRate ? parseFloat(q.taxRate) : null);
  return { quote: { ...q, dueOnAcceptanceTotal: totals.dueOnAcceptanceTotal }, blocks, lines };
}

export async function listQuotes(query: ListQuotesQuery, actor: QuoteActor) {
  const conds = [] as Array<ReturnType<typeof eq>>;
  if (query.orgId) { assertOrg(actor, query.orgId); conds.push(eq(quotes.orgId, query.orgId)); }
  if (query.status) conds.push(eq(quotes.status, query.status as never));
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
  const rows = await db.select().from(quotes)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(quotes.createdAt), desc(quotes.id))
    .limit(query.limit);
  return rows;
}

/** Draft-only header edit. Only provided fields are written; nullable fields can be
 *  explicitly cleared with null. A tax-rate change triggers a totals recompute. */
export async function updateQuote(id: string, input: UpdateQuoteInput, actor: QuoteActor) {
  await loadDraft(id, actor);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.siteId !== undefined) set.siteId = input.siteId;
  if (input.expiryDate !== undefined) set.expiryDate = input.expiryDate;
  if (input.introNotes !== undefined) set.introNotes = input.introNotes;
  if (input.terms !== undefined) set.terms = input.terms;
  if (input.termsAndConditions !== undefined) set.termsAndConditions = input.termsAndConditions;
  if (input.billToName !== undefined) set.billToName = input.billToName;
  // Numeric tax_rate takes a fixed-string value; null clears it.
  if (input.taxRate !== undefined) set.taxRate = input.taxRate === null ? null : Number(input.taxRate).toFixed(5);
  await db.update(quotes).set(set).where(eq(quotes.id, id));
  await recomputeAndPersist(id);
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

export async function addBlock(quoteId: string, input: QuoteBlockInput, actor: QuoteActor) {
  const q = await loadDraft(quoteId, actor);
  const sortOrder = await nextBlockSortOrder(quoteId);
  const [row] = await db.insert(quoteBlocks).values({
    quoteId,
    orgId: q.orgId,
    blockType: input.blockType,
    content: input.content,
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
  await loadDraft(quoteId, actor);
  const [existing] = await db.select({ blockType: quoteBlocks.blockType })
    .from(quoteBlocks)
    .where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, quoteId)))
    .limit(1);
  if (!existing) throw new QuoteServiceError('Block not found', 404, 'BLOCK_NOT_FOUND');
  if (existing.blockType !== input.blockType) {
    throw new QuoteServiceError('Block type cannot be changed', 400, 'BLOCK_TYPE_MISMATCH');
  }
  const [row] = await db.update(quoteBlocks)
    .set({ content: input.content })
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

export async function addManualLine(quoteId: string, input: QuoteLineInput, actor: QuoteActor) {
  const q = await loadDraft(quoteId, actor);
  const quantity = String(input.quantity);
  const unitPrice = Number(input.unitPrice).toFixed(2);
  const sortOrder = await nextLineSortOrder(quoteId);
  const [row] = await db.insert(quoteLines).values({
    quoteId,
    orgId: q.orgId,
    blockId: input.blockId ?? null,
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
  actor: QuoteActor
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
  const sortOrder = await nextLineSortOrder(quoteId);
  const [row] = await db.insert(quoteLines).values({
    quoteId,
    orgId: q.orgId,
    blockId: blockId ?? null,
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
