import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { quotes, quoteLines, quoteBlocks, quoteImages, quoteRecipients } from '../db/schema/quotes';
import { invoices } from '../db/schema/invoices';
import { organizations, partners, sites } from '../db/schema/orgs';
import { deviceGroups } from '../db/schema/devices';
import { contractTemplates, contractTemplateVersions } from '../db/schema/contractDocuments';
import { catalogItems } from '../db/schema/catalog';
import { pax8OrderLines, pax8Orders } from '../db/schema/pax8Orders';
import { listQuoteOrders } from './quoteOrderService';
import { computeLineTotal, resolveEffectiveTaxRate } from './invoiceMath';
import { vendorIdentityFromAttributes } from './catalogVendorIdentity';
import { resolvePrice, CatalogServiceError } from './catalogService';
import { buildBillToAddress, type BillToAddress } from './sellerSnapshot';
import { computeQuoteTotals, validateQuoteDeposit, toQuoteDepositConfig, type QuoteLineForMath } from './quoteMath';
import {
  QuoteServiceError,
  assertOrg,
  assertSite,
  assertQuoteAccess,
  isSupersedable,
  type QuoteActor,
} from './quoteTypes';
import { allocateQuoteCounter, formatQuoteNumber } from './quoteNumbers';
import { readOrgStampingDefaults, OrgCurrencyServiceError, type DbExecutor as OrgLockExecutor } from './orgCurrencyCore';

/**
 * Boundary mapping for the org SHARE barrier (#3778, review finding 1).
 * `orgCurrencyCore` is domain-neutral by design and throws its own
 * `OrgCurrencyServiceError`; this service's route boundary rethrows anything it
 * does not recognise, so an unmapped ORG_NOT_FOUND would surface as a 500
 * instead of the 404 this path returned before the barrier existed. Only
 * ORG_NOT_FOUND is translated — a serialization failure, a deadlock or a
 * genuine helper bug must keep its own identity.
 */
async function lockOrgStampingDefaults(tx: OrgLockExecutor, orgId: string): Promise<{ currencyCode: string }> {
  try {
    return await readOrgStampingDefaults(tx, orgId);
  } catch (err) {
    if (err instanceof OrgCurrencyServiceError && err.code === 'ORG_NOT_FOUND') {
      throw new QuoteServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    throw err;
  }
}

import { isPgUniqueViolation } from '../utils/pgErrors';
import {
  sanitizeRichTextHtml,
  sanitizeRichTextHtmlWithReport,
  sanitizeInlineRichTextWithReport,
  sanitizePlainTextWithReport,
  richTextStripWarning,
  type RichTextSanitizeReport,
  type RichTextStripWarning,
} from './richTextSanitize';
import {
  quoteTableContentSchema,
  quoteCalloutContentSchema,
  isRepresentableInCurrency,
  minorUnitExponent,
  mergeQuoteLinePatch,
  quoteLineDeviceSetIssues,
  isQuoteLineSiteDeleted,
} from '@breeze/shared';
import type {
  CreateQuoteInput, CloneQuoteInput, UpdateQuoteInput, QuoteLineInput, QuoteBlockInput, ListQuotesQuery,
  QuoteTableContent, QuoteCalloutContent, QuoteDeviceSetType,
} from '@breeze/shared';
import {
  countQuoteDeviceSetLines,
  persistQuoteDeviceSetQuantities,
  toQuoteDeviceSetLine,
  type QuoteDeviceSetCount,
} from './quoteDeviceSet';

export interface QuoteDeviceSetDrift {
  lineId: string;
  description: string;
  storedQuantity: string;
  liveQuantity: number | null;
  reason?: 'org_retargeted';
  error?: 'GROUP_EVALUATION_FAILED' | 'GROUP_DELETED' | 'SITE_DELETED';
}

// ---------------------------------------------------------------------------
// Actor guards. The RLS access context (withDbAccessContext) is established by
// the caller — the route middleware in production, the test harness in
// integration tests — exactly like invoiceService. The service itself uses the
// bare `db` proxy directly; it never opens its own context.
// ---------------------------------------------------------------------------

/**
 * Customer-facing projection of a quote line (public quote URL, portal, PDF).
 * ALLOWLIST, not a strip: new internal columns (vendor identity, fulfillment,
 * economics) are excluded by default. sku/partNumber stay customer-visible by
 * design; unitCost and the procurement snapshot never leave the MSP surface.
 */
const CUSTOMER_LINE_FIELDS = [
  'id', 'quoteId', 'blockId', 'orgId', 'sourceType', 'catalogItemId', 'parentLineId',
  'name', 'description', 'quantity', 'unitPrice', 'taxable', 'customerVisible',
  'lineTotal', 'recurrence', 'termMonths', 'billingFrequency', 'depositEligible',
  'itemType', 'sku', 'partNumber', 'imageId', 'sortOrder', 'createdAt',
  'contractLineType', 'deviceRoles', 'deviceGroupName', 'siteName',
  'includedQuantity', 'overageMode', 'overageUnitPrice',
] as const;
export type CustomerQuoteLine<T> = Pick<T & Record<string, unknown>, (typeof CUSTOMER_LINE_FIELDS)[number] & keyof T>;
export function toCustomerLines<T extends Record<string, unknown>>(lines: T[]) {
  return lines.map((line) => Object.fromEntries(
    CUSTOMER_LINE_FIELDS.filter((f) => f in line).map((f) => [f, line[f]]),
  ) as CustomerQuoteLine<T>);
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
/**
 * Merge per-field reports for a repeated field (every table cell, every column
 * label) into ONE warning naming the field family — an author who pasted a
 * table into a 6x8 grid wants "tables aren't supported in cells", not 48
 * identical warnings (issue #3520).
 */
function mergeWarnings(field: string, reports: RichTextSanitizeReport[]): RichTextStripWarning[] {
  const removedTags = [...new Set(reports.flatMap((r) => r.removedTags))].sort();
  const warning = richTextStripWarning(field, { html: '', removedTags });
  return warning ? [warning] : [];
}

/** A block's sanitization result: the value to persist/serve, and what the
 * sanitizer removed on the way (empty array = nothing lost). */
interface SanitizedContent<T> {
  content: T;
  warnings: RichTextStripWarning[];
}

/** Per-field sanitization shared by write (sanitizeBlockContentForWrite) and
 * read (sanitizeQuoteBlocksForRead) for the 'table' block: every cell/label is
 * inline-only HTML (richTextSanitize's inline profile), caption is plain text.
 * Both paths go through this one function so the field map can't drift; only
 * the WRITE path consumes `warnings` (issue #3520). */
function sanitizeTableContent(c: QuoteTableContent): SanitizedContent<QuoteTableContent> {
  const labels = c.columns.map((col) => sanitizeInlineRichTextWithReport(col.label));
  const cells = c.rows.map((r) => r.cells.map(sanitizeInlineRichTextWithReport));
  const caption = c.caption ? sanitizePlainTextWithReport(c.caption) : null;
  return {
    content: {
      ...c,
      columns: c.columns.map((col, i) => ({ ...col, label: labels[i]!.html })),
      rows: cells.map((row) => ({ cells: row.map((cell) => cell.html) })),
      caption: caption ? caption.html : c.caption,
    },
    warnings: [
      ...mergeWarnings('content.columns[].label', labels),
      ...mergeWarnings('content.rows[].cells[]', cells.flat()),
      ...(caption ? mergeWarnings('content.caption', [caption]) : []),
    ],
  };
}

/** Per-field sanitization shared by write and read for the 'callout' block:
 * html uses the same 11-tag block profile as rich_text, title is plain text. */
function sanitizeCalloutContent(c: QuoteCalloutContent): SanitizedContent<QuoteCalloutContent> {
  const html = sanitizeRichTextHtmlWithReport(c.html);
  const title = c.title ? sanitizePlainTextWithReport(c.title) : null;
  return {
    content: { ...c, html: html.html, title: title ? title.html : c.title },
    warnings: [
      ...mergeWarnings('content.html', [html]),
      ...(title ? mergeWarnings('content.title', [title]) : []),
    ],
  };
}

// Canonical empty content substituted on read when a stored block's JSONB
// fails to safeParse against the Task 2 Zod shape (legacy row, direct write,
// or any future write path that forgets to validate) — a renderer must never
// see an out-of-contract shape (spec §4 read-path hardening).
const EMPTY_TABLE_CONTENT: QuoteTableContent = { columns: [], rows: [] };
const EMPTY_CALLOUT_CONTENT: QuoteCalloutContent = { variant: 'info', html: '' };

export function sanitizeQuoteBlocksForRead<T extends { blockType: string; content: unknown }>(blocks: T[]): T[] {
  return blocks.map((block) => {
    if (block.blockType === 'rich_text') {
      const content = block.content;
      if (!content || typeof content !== 'object' || Array.isArray(content)) return block;
      const html = (content as Record<string, unknown>).html;
      if (typeof html !== 'string') return block;
      return { ...block, content: { ...(content as Record<string, unknown>), html: sanitizeRichTextHtml(html) } };
    }
    if (block.blockType === 'table') {
      const parsed = quoteTableContentSchema.safeParse(block.content);
      return { ...block, content: parsed.success ? sanitizeTableContent(parsed.data).content : EMPTY_TABLE_CONTENT };
    }
    if (block.blockType === 'callout') {
      const parsed = quoteCalloutContentSchema.safeParse(block.content);
      return { ...block, content: parsed.success ? sanitizeCalloutContent(parsed.data).content : EMPTY_CALLOUT_CONTENT };
    }
    return block;
  });
}

/** Sanitize a block's content at WRITE time (addBlock/updateBlock) — the
 * primary defense; sanitizeQuoteBlocksForRead above is the secondary one.
 * Other block types pass through unchanged. Exported for direct unit testing.
 *
 * Returns the removed tags alongside the content so addBlock/updateBlock can
 * hand them to the caller instead of 200-ing over the loss (issue #3520). The
 * READ path deliberately stays silent — a legacy row must render, not warn. */
export function sanitizeBlockContentForWrite(input: QuoteBlockInput): SanitizedContent<QuoteBlockInput['content']> {
  if (input.blockType === 'rich_text') {
    const report = sanitizeRichTextHtmlWithReport(input.content.html);
    return {
      content: { ...input.content, html: report.html },
      warnings: mergeWarnings('content.html', [report]),
    };
  }
  if (input.blockType === 'table') return sanitizeTableContent(input.content);
  if (input.blockType === 'callout') return sanitizeCalloutContent(input.content);
  return { content: input.content, warnings: [] };
}

/**
 * Record a lossy block write server-side. Logged at the WRITE boundary (with
 * ids, never the raw HTML) rather than inside the sanitizer, where the read and
 * PDF-render paths would emit the same line on every page view (issue #3520).
 */
function logStrippedMarkup(op: string, quoteId: string, blockId: string, warnings: RichTextStripWarning[]): void {
  if (warnings.length === 0) return;
  console.warn(`[quoteService] ${op} removed unsupported markup`, {
    quoteId,
    blockId,
    warnings: warnings.map((w) => ({ field: w.field, removedTags: w.removedTags })),
  });
}

const errorIds = {
  QUOTE_LINEAGE_PARENT_MISSING: 'QUOTE_LINEAGE_PARENT_MISSING',
} as const;

function logError(errorId: typeof errorIds[keyof typeof errorIds], message: string, context: Record<string, unknown>): void {
  console.error(`[quoteService] ${errorId} ${message}`, context);
}

function resolvePartner(actor: QuoteActor): string {
  if (!actor.partnerId) {
    throw new QuoteServiceError('Partner could not be resolved', 403, 'PARTNER_UNRESOLVABLE');
  }
  return actor.partnerId;
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
    currencyCode: quotes.currencyCode,
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
  const totals = computeQuoteTotals(lines as QuoteLineForMath[], q?.taxRate ? parseFloat(q.taxRate) : null, deposit, q?.currencyCode);
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
  // FOR UPDATE: block/line/content mutators that use loadDraft share this lock,
  // serializing their draft edits against a concurrent send. writeQuoteImage is
  // the current exception: it inserts only an unreferenced image row, which is
  // safe today because that cannot change the rendered document. Any new content
  // mutator must come through loadDraft before writing.
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1).for('update');
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertQuoteAccess(actor, q);
  if (q.status !== 'draft') throw new QuoteServiceError('Quote is not a draft', 409, 'NOT_A_DRAFT');
  return q;
}

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lock-order anchor (#3774, mirrors invoiceService.lockDraftInvoice): SELECT
 * the QUOTE row FOR UPDATE as the FIRST statement of the enclosing
 * transaction, assert access + draft, and return the locked row. Every draft
 * line writer (add/update/remove, plus deleteBlock, which removes a section's
 * lines) takes this lock before touching quote_lines, then recomputes totals
 * inside the same transaction — and always computes lineTotal from the LOCKED
 * row's currencyCode. changeQuoteCurrency takes the identical lock, so a
 * restamp can never interleave between a writer's currency read and its line
 * write (no JPY-stamped quote carrying a USD-rounded line), and a line can
 * never phantom-insert past the restamp's "no monetary lines" check.
 */
async function lockDraftQuote(tx: DbExecutor, quoteId: string, actor: QuoteActor) {
  const [q] = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1).for('update');
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertQuoteAccess(actor, q);
  if (q.status !== 'draft') throw new QuoteServiceError('Quote is not a draft', 409, 'NOT_A_DRAFT');
  return q;
}

async function nextBlockSortOrder(quoteId: string, dbc: DbExecutor = db): Promise<number> {
  const rows = await dbc
    .select({ max: sql<number>`COALESCE(MAX(${quoteBlocks.sortOrder}), -1)` })
    .from(quoteBlocks)
    .where(eq(quoteBlocks.quoteId, quoteId));
  return Number(rows[0]?.max ?? -1) + 1;
}

async function nextLineSortOrder(quoteId: string, dbc: DbExecutor = db): Promise<number> {
  const rows = await dbc
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
  // A new quote is stamped with its ORGANIZATION's currency unless the caller
  // names one explicitly (spec §5 — the org, not the partner, owns document
  // currency; the partner inheritance shipped for #3200 predates per-org
  // currency, B3). No DB-default backstop: a missed stamp must fail loudly
  // (23502 once wave 2 drops the column default), never mint a silent USD quote.
  //
  // Creation barrier (#3778): the default read happens under an org SHARE lock
  // held until the INSERT commits (see readOrgStampingDefaults), so a
  // concurrent changeOrgCurrency either counts this quote in its in-lock
  // summary or this stamp is the NEW currency — never an old stamp committed
  // unseen. An explicit `input.currencyCode` is a source copy: no org reread.
  // Number at creation (not at send): techs reference the number while drafting
  // and in the list. A deleted draft leaves a counter gap, which the numbering
  // contract explicitly tolerates (see allocateQuoteCounter). sendQuote keeps
  // this number and only allocates for legacy drafts that predate it.
  const year = new Date().getUTCFullYear();
  const counter = await allocateQuoteCounter(partnerId, year);
  const quoteNumber = formatQuoteNumber('Q', year, counter);
  const [row] = await db.transaction(async (tx) => {
    const currencyCode = input.currencyCode
      ?? (await lockOrgStampingDefaults(tx, input.orgId)).currencyCode;
    return tx.insert(quotes).values({
      partnerId,
      orgId: input.orgId,
      siteId: input.siteId ?? null,
      quoteNumber,
      title: input.title?.trim() || null,
      currencyCode,
      taxRate,
      expiryDate: input.expiryDate ?? null,
      introNotes: input.introNotes ?? null,
      terms: input.terms ?? null,
      termsAndConditions: input.termsAndConditions ?? null,
      createdBy: actor.userId,
    }).returning();
  });
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

/** Internal revision overrides for the clone core — never exposed on a route. */
interface CloneRevisionOverrides {
  quoteNumber: string;
  revisionOfQuoteId: string;
  revisionNumber: number;
}

type CloneLineagePair =
  | { revisionOfQuoteId: null; revisionNumber: 1 }
  | { revisionOfQuoteId: string; revisionNumber: number };

/** Build the correlated lineage columns together so the DB CHECK is a backstop. */
function cloneLineagePair(revision?: CloneRevisionOverrides): CloneLineagePair {
  if (!revision) return { revisionOfQuoteId: null, revisionNumber: 1 };
  if (!revision.revisionOfQuoteId || !Number.isInteger(revision.revisionNumber) || revision.revisionNumber < 2) {
    throw new QuoteServiceError('Invalid quote revision lineage', 409, 'INVALID_STATE');
  }
  return {
    revisionOfQuoteId: revision.revisionOfQuoteId,
    revisionNumber: revision.revisionNumber,
  };
}

function assertRevisionCloneTarget(input: CloneQuoteInput, revision?: CloneRevisionOverrides): void {
  if (revision && input.orgId) {
    throw new QuoteServiceError('A revision cannot be retargeted to another organization', 409, 'INVALID_STATE');
  }
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
 *
 * @param revision Module-private lineage fields used only by reviseQuote.
 */
async function cloneQuoteCore(
  id: string,
  actor: QuoteActor,
  input: CloneQuoteInput = {},
  revision?: CloneRevisionOverrides,
) {
  assertRevisionCloneTarget(input, revision);
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
    const [target] = await db.select({ id: organizations.id, currencyCode: organizations.currencyCode })
      .from(organizations)
      .where(and(eq(organizations.id, targetOrgId), eq(organizations.partnerId, source.partnerId)))
      .limit(1);
    if (!target) throw new QuoteServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    // A clone carries its source's currency stamp verbatim, so a target org
    // billed in a different currency is a hard 400 — never a silent restamp and
    // never a conversion (spec §5; mirrors the §7 ticket-move guard).
    if (target.currencyCode !== source.currencyCode) {
      throw new QuoteServiceError(
        `target organization uses ${target.currencyCode}; this quote is in ${source.currencyCode} — clone within the same currency or recreate the quote`,
        400, 'CURRENCY_MISMATCH',
      );
    }
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

  let quoteNumber: string;
  if (revision) {
    quoteNumber = revision.quoteNumber;
  } else {
    const year = new Date().getUTCFullYear();
    const counter = await allocateQuoteCounter(source.partnerId, year);
    quoteNumber = formatQuoteNumber('Q', year, counter);
  }
  const quoteId = randomUUID();

  const imageIds = new Map(images.map((image) => [image.id, randomUUID()]));
  const blockIds = new Map(blocks.map((block) => [block.id, randomUUID()]));
  const lineIds = new Map(lines.map((line) => [line.id, randomUUID()]));
  const totals = computeQuoteTotals(
    lines as QuoteLineForMath[],
    taxRate ? parseFloat(taxRate) : null,
    toQuoteDepositConfig(source.depositType, source.depositPercent),
    source.currencyCode,
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
    let deviceSetDrift: QuoteDeviceSetDrift[] = [];
    if (orgChanged) {
      // #3778: re-verify the same-currency guard under the org SHARE barrier,
      // the FIRST statement of this transaction. The pre-transaction read above
      // is a fast-fail: a changeOrgCurrency committing between the two would
      // otherwise let a clone land on an org billing in another currency.
      const locked = await lockOrgStampingDefaults(tx, targetOrgId);
      if (locked.currencyCode !== source.currencyCode) {
        throw new QuoteServiceError(
          `target organization uses ${locked.currencyCode}; this quote is in ${source.currencyCode} — clone within the same currency or recreate the quote`,
          400, 'CURRENCY_MISMATCH',
        );
      }
    }
    const [cloned] = await tx.insert(quotes).values({
      id: quoteId,
      partnerId: source.partnerId,
      orgId: targetOrgId,
      siteId: orgChanged ? null : source.siteId,
      quoteNumber,
      ...cloneLineagePair(revision),
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
      // documentLocale deliberately NOT copied (stays NULL, like sellerSnapshot):
      // it is a send-time snapshot, stamped fresh when the clone is sent (#3777).
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
        procurementSource: line.procurementSource,
        vendorSku: line.vendorSku,
        manufacturer: line.manufacturer,
        imageId: line.imageId ? imageIds.get(line.imageId) ?? null : null,
        contractLineType: line.contractLineType,
        deviceRoles: line.deviceRoles,
        // Stamps are KEPT on a retargeted clone: they are what the amber
        // "re-select for this organization" chip renders, and what tells the
        // operator which group the line used to price.
        deviceGroupId: orgChanged ? null : line.deviceGroupId,
        deviceGroupName: line.deviceGroupName,
        siteId: orgChanged ? null : line.siteId,
        siteName: line.siteName,
        includedQuantity: line.includedQuantity,
        overageMode: line.overageMode,
        overageUnitPrice: line.overageUnitPrice,
        sortOrder: line.sortOrder,
      })));
    }

    if (orgChanged && lines.some((line) => line.contractLineType !== null && line.contractLineType !== undefined)) {
      deviceSetDrift = lines
        .filter((line) => line.deviceGroupId !== null || line.siteId !== null)
        .map((line) => ({
          lineId: lineIds.get(line.id)!,
          description: line.name ?? line.description ?? '',
          storedQuantity: line.quantity,
          liveQuantity: null,
          reason: 'org_retargeted' as const,
        }));

      const unscoped = await tx.select().from(quoteLines).where(and(
        eq(quoteLines.quoteId, quoteId),
        isNotNull(quoteLines.contractLineType),
        isNull(quoteLines.deviceGroupId),
        isNull(quoteLines.siteId),
      ));
      if (unscoped.length > 0) {
        const counts = await countQuoteDeviceSetLines(targetOrgId, unscoped.map(toQuoteDeviceSetLine));
        await persistQuoteDeviceSetQuantities(tx, quoteId, source.currencyCode, unscoped, counts);
      }
      await recomputeAndPersist(quoteId, tx);
    }

    return { ...cloned!, deviceSetDrift };
  });
}

/**
 * Public clone surface. Revision overrides stay inside this module; the
 * runtime check also rejects an untyped JavaScript caller attempting the old
 * four-argument form.
 */
export async function cloneQuote(id: string, actor: QuoteActor, input: CloneQuoteInput = {}) {
  const unsupportedRevision = arguments[3] as CloneRevisionOverrides | undefined;
  assertRevisionCloneTarget(input, unsupportedRevision);
  if (unsupportedRevision) {
    throw new QuoteServiceError('Quote revision overrides are internal', 409, 'INVALID_STATE');
  }
  return cloneQuoteCore(id, actor, input);
}

/**
 * Walk parent links to the lineage root with a 100-hop cycle guard. The ceiling
 * is data-dependent: a legitimate lineage deeper than 100 revisions is also
 * rejected rather than risking an unbounded walk through corrupt cyclic data.
 */
async function resolveQuoteLineageRoot(
  quote: typeof quotes.$inferSelect,
): Promise<typeof quotes.$inferSelect> {
  let current = quote;
  for (let hop = 0; hop < 100 && current.revisionOfQuoteId; hop++) {
    const [parent] = await db.select().from(quotes)
      .where(eq(quotes.id, current.revisionOfQuoteId)).limit(1);
    if (!parent) throw new QuoteServiceError('Quote lineage is corrupt', 409, 'INVALID_STATE');
    current = parent;
  }
  if (current.revisionOfQuoteId) {
    throw new QuoteServiceError('Quote lineage is corrupt', 409, 'INVALID_STATE');
  }
  return current;
}

/**
 * Create a linked draft revision without touching the live parent. The parent
 * stays live until this revision is SENT — sendQuote flips it to 'superseded'
 * atomically with the child's draft→sent claim.
 */
export async function reviseQuote(id: string, actor: QuoteActor) {
  const { quote: parentRow } = await getQuote(id, actor);
  // Lock the parent for the rest of this transaction and re-read its status.
  // getQuote's snapshot is unlocked, so a customer accept committing between
  // that read and the clone insert would otherwise let a revision draft attach
  // to an ACCEPTED quote — precisely the state PARENT_CONVERTED exists to
  // prevent, and one nothing downstream would flag. This row lock serializes
  // the revision decision against acceptQuote and sendQuote's parent flip.
  // Every gate below reads the LOCKED status, never the snapshot.
  const [locked] = await db.select({ status: quotes.status }).from(quotes)
    .where(eq(quotes.id, parentRow.id)).limit(1).for('update');
  if (!locked) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  const parent = { ...parentRow, status: locked.status };
  if (parent.status === 'draft') {
    throw new QuoteServiceError('This quote is still a draft — edit it directly', 409, 'INVALID_STATE');
  }
  if (parent.status === 'converted' || parent.status === 'accepted') {
    throw new QuoteServiceError(
      'This quote was accepted — changes go through its invoice or contract',
      409,
      'PARENT_CONVERTED',
    );
  }
  if (parent.status === 'superseded') {
    const [successor] = await db.select({ id: quotes.id }).from(quotes)
      .where(eq(quotes.revisionOfQuoteId, parent.id)).limit(1);
    throw new QuoteServiceError(
      successor
        ? 'This quote was already replaced — revise the newer version'
        : 'This quote is marked as superseded, but its replacement could not be found',
      409,
      'ALREADY_SUPERSEDED',
      successor ? { successorQuoteId: successor.id } : undefined,
    );
  }
  // The shared revisable set deliberately excludes accepted/converted because
  // those settled outcomes already have an invoice or contract behind them.
  if (!isSupersedable(parent.status)) {
    throw new QuoteServiceError(`Cannot revise a quote in status ${parent.status}`, 409, 'INVALID_STATE');
  }
  if (!parent.quoteNumber) {
    throw new QuoteServiceError('This quote has no quote number and cannot be revised', 409, 'INVALID_STATE');
  }
  // Linearity is enforced by quotes_revision_of_uq. This pre-check is only a
  // TOCTOU-racy convenience for a friendlier 409 carrying revisionQuoteId; the
  // unique constraint remains the invariant under concurrent revision attempts.
  const [existing] = await db.select({ id: quotes.id, status: quotes.status }).from(quotes)
    .where(eq(quotes.revisionOfQuoteId, parent.id)).limit(1);
  if (existing) {
    throw new QuoteServiceError(
      'A revision of this quote is already in progress',
      409,
      'REVISION_IN_PROGRESS',
      { revisionQuoteId: existing.id },
    );
  }
  const root = await resolveQuoteLineageRoot(parent);
  if (!root.quoteNumber) {
    throw new QuoteServiceError('The root quote has no quote number and cannot be revised', 409, 'INVALID_STATE');
  }
  const revisionNumber = parent.revisionNumber + 1;
  try {
    return await cloneQuoteCore(id, actor, {}, {
      quoteNumber: `${root.quoteNumber}-R${revisionNumber}`,
      revisionOfQuoteId: parent.id,
      revisionNumber,
    });
  } catch (err) {
    if (isPgUniqueViolation(err, 'quotes_revision_of_uq')) {
      const [existingRevision] = await db.select({ id: quotes.id }).from(quotes)
        .where(eq(quotes.revisionOfQuoteId, parent.id)).limit(1);
      throw new QuoteServiceError(
        'A revision of this quote is already in progress',
        409,
        'REVISION_IN_PROGRESS',
        existingRevision ? { revisionQuoteId: existingRevision.id } : undefined,
      );
    }
    throw err;
  }
}

export async function getQuote(id: string, actor: QuoteActor) {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertQuoteAccess(actor, q);
  const blocks = sanitizeQuoteBlocksForRead(
    await db.select().from(quoteBlocks).where(eq(quoteBlocks.quoteId, id)).orderBy(quoteBlocks.sortOrder)
  );
  const joinedLines = await db.select({
    line: quoteLines,
    deviceGroup: { id: deviceGroups.id, name: deviceGroups.name, type: deviceGroups.type },
    site: { id: sites.id, name: sites.name },
  }).from(quoteLines)
    .leftJoin(deviceGroups, and(eq(quoteLines.deviceGroupId, deviceGroups.id), eq(quoteLines.orgId, deviceGroups.orgId)))
    .leftJoin(sites, and(eq(quoteLines.siteId, sites.id), eq(quoteLines.orgId, sites.orgId)))
    .where(eq(quoteLines.quoteId, id)).orderBy(quoteLines.sortOrder);
  const lines = joinedLines.map(({ line, deviceGroup, site }) => ({
    ...line,
    deviceGroup: deviceGroup?.id ? deviceGroup : null,
    site: site?.id ? site : null,
    // A stamped name with a null id: the thing this line prices is gone.
    descriptorUnresolved: Boolean(
      (line.deviceGroupId === null && line.deviceGroupName !== null)
      || isQuoteLineSiteDeleted(line),
    ),
  }));
  // Quote acceptance returns the staged order id once, but the technician may
  // reload or open the converted quote later. Keep discoverability in the quote
  // read model itself. The quote access check runs first, and the lookup repeats
  // the partner + org axes in addition to relying on the tables' forced RLS.
  const [pax8OrderSummary] = await db.select({
    pax8OrderId: pax8Orders.id,
    status: pax8Orders.status,
  }).from(pax8Orders).where(and(
    eq(pax8Orders.sourceQuoteId, id),
    eq(pax8Orders.partnerId, q.partnerId),
    eq(pax8Orders.orgId, q.orgId),
  )).orderBy(desc(pax8Orders.createdAt)).limit(1);
  // Line-level detail (not just a count) so the order breakdown can cross-
  // reference each quote line against its own submit outcome — a partially
  // failed order must not read as uniformly "staged" or "ordered".
  const pax8LineRows = pax8OrderSummary
    ? await db.select({
        sourceQuoteLineId: pax8OrderLines.sourceQuoteLineId,
        submitState: pax8OrderLines.submitState,
        quantity: pax8OrderLines.quantity,
      }).from(pax8OrderLines).where(and(
        eq(pax8OrderLines.orderId, pax8OrderSummary.pax8OrderId),
        eq(pax8OrderLines.partnerId, q.partnerId),
        eq(pax8OrderLines.orgId, q.orgId),
      ))
    : [];
  const revisionOf = q.revisionOfQuoteId ? await (async () => {
    const [parent] = await db.select({ id: quotes.id, quoteNumber: quotes.quoteNumber, siteId: quotes.siteId })
      .from(quotes).where(eq(quotes.id, q.revisionOfQuoteId!)).limit(1);
    if (!parent) {
      logError(
        errorIds.QUOTE_LINEAGE_PARENT_MISSING,
        'linked quote parent could not be read',
        { quoteId: q.id, revisionOfQuoteId: q.revisionOfQuoteId },
      );
      return null;
    }
    // Match assertSite semantics without turning an authorized read of q into a
    // 403 for an inaccessible linked quote. Check before loading recipient PII.
    if (actor.allowedSiteIds && (!parent.siteId || !actor.allowedSiteIds.includes(parent.siteId))) return null;
    // The composite (revision_of_quote_id, org_id) FK guarantees same-org
    // lineage under every DB context; no separate org-axis filter is needed.
    const recipients = await db.select({ email: quoteRecipients.email }).from(quoteRecipients)
      .where(eq(quoteRecipients.quoteId, parent.id)).orderBy(quoteRecipients.createdAt);
    return { id: parent.id, quoteNumber: parent.quoteNumber, recipients: recipients.map((r) => r.email) };
  })() : null;
  const [successorRow] = await db.select({
    id: quotes.id,
    quoteNumber: quotes.quoteNumber,
    status: quotes.status,
    siteId: quotes.siteId,
  })
    .from(quotes).where(eq(quotes.revisionOfQuoteId, q.id)).limit(1);
  const successor = successorRow
    && (!actor.allowedSiteIds || (!!successorRow.siteId && actor.allowedSiteIds.includes(successorRow.siteId)))
    ? { id: successorRow.id, quoteNumber: successorRow.quoteNumber, status: successorRow.status }
    : null;
  // Procurement order tracking (Task 11): every PO header + its line-level
  // allocations recorded against this quote, so the editor can show fulfillment
  // status alongside the pax8 auto-order summary above.
  const orders = await listQuoteOrders(id);
  // dueOnAcceptanceTotal is a derived (non-persisted) figure: the amount accept
  // actually invoices (one-time lines only — recurring is deferred to the Phase 4
  // contract). Computed from the canonical quoteMath so it stays penny-consistent
  // with quoteAcceptService's invoice, and so the UI can advertise an accurate
  // "due on acceptance" instead of the recurring-inclusive `total` (see #bug).
  const totals = computeQuoteTotals(
    lines as QuoteLineForMath[],
    q.taxRate ? parseFloat(q.taxRate) : null,
    toQuoteDepositConfig(q.depositType, q.depositPercent),
    q.currencyCode,
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
    orders,
    pax8OrderId: pax8OrderSummary?.pax8OrderId ?? null,
    pax8OrderLineCount: pax8LineRows.length,
    pax8Order: pax8OrderSummary
      ? { id: pax8OrderSummary.pax8OrderId, status: pax8OrderSummary.status, lines: pax8LineRows }
      : null,
    revisionOf,
    successor,
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
  let deviceSetDrift: QuoteDeviceSetDrift[] = [];
  // A site-restricted caller may not move the quote to a site it can't access
  // (nor clear it to null, which a restricted caller can never see).
  if (input.siteId !== undefined) assertSite(actor, input.siteId);
  const orgChanged = input.orgId !== undefined && input.orgId !== q.orgId;
  // Re-resolved org tax default; undefined = org unchanged (keep current rate).
  let orgTaxRate: string | null | undefined;
  if (orgChanged) {
    if (q.revisionOfQuoteId != null) {
      throw new QuoteServiceError(
        'A revision draft cannot be moved to another organization',
        409,
        'INVALID_STATE',
      );
    }
    const targetOrgId = input.orgId!;
    assertOrg(actor, targetOrgId);
    // Reassignment clears the site, and a site-restricted caller can never see a
    // null-site quote — deny exactly as assertSite would for an explicit null.
    assertSite(actor, null);
    // Same-partner guard; RLS hides other partners' orgs so a cross-partner id
    // resolves to "not found" rather than leaking existence.
    const [target] = await db.select({ id: organizations.id, currencyCode: organizations.currencyCode })
      .from(organizations)
      .where(and(eq(organizations.id, targetOrgId), eq(organizations.partnerId, q.partnerId)))
      .limit(1);
    if (!target) throw new QuoteServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    // The draft keeps its currency stamp across an org move, so a target org
    // billed in a different currency is a hard 400 — never a silent restamp and
    // never a conversion (spec §5; mirrors the §7 ticket-move guard).
    if (target.currencyCode !== q.currencyCode) {
      throw new QuoteServiceError(
        `target organization uses ${target.currencyCode}; this quote is in ${q.currencyCode} — reassign within the same currency or recreate the quote`,
        400, 'CURRENCY_MISMATCH',
      );
    }
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
      q.currencyCode,
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
      // #3205 W05 decision 7: defer THIS constraint BY NAME, never ALL. The
      // parent's org_id update and the children's are separate statements, and
      // quote_lines_quote_org_fk is checked at end-of-statement. Naming the one
      // constraint keeps every other deferrable FK checking at statement
      // boundaries, so unrelated tenancy violations fail where they happen.
      await tx.execute(sql`SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED`);
      // #3778: re-verify the same-currency guard under the org SHARE barrier as
      // the first data read of this transaction (the pre-transaction check above
      // is a fast-fail only). SET CONSTRAINTS above takes no row/table lock.
      const lockedTarget = await lockOrgStampingDefaults(tx, targetOrgId);
      if (lockedTarget.currencyCode !== q.currencyCode) {
        throw new QuoteServiceError(
          `target organization uses ${lockedTarget.currencyCode}; this quote is in ${q.currencyCode} — reassign within the same currency or recreate the quote`,
          400, 'CURRENCY_MISMATCH',
        );
      }
      await assertContractBlocksValidForOrg(contractBlocks, { orgId: targetOrgId, partnerId: q.partnerId }, tx);
      await tx.update(quotes).set(set).where(eq(quotes.id, id));
      // Move the denormalized org_id on every child row in the same transaction.
      await tx.update(quoteBlocks).set({ orgId: targetOrgId }).where(eq(quoteBlocks.quoteId, id));
      // Scoped ids belong to the OLD org. Clear them in the SAME statement that
      // moves org_id so the two immediate descriptor FKs never observe a
      // cross-org pair; stamps and quantities deliberately survive.
      const cleared = await tx.update(quoteLines)
        .set({ orgId: targetOrgId, deviceGroupId: null, siteId: null })
        .where(and(
          eq(quoteLines.quoteId, id),
          or(isNotNull(quoteLines.deviceGroupId), isNotNull(quoteLines.siteId)),
        ))
        .returning({
          id: quoteLines.id,
          name: quoteLines.name,
          description: quoteLines.description,
          quantity: quoteLines.quantity,
        });
      deviceSetDrift = cleared.map((line) => ({
        lineId: line.id,
        description: line.name ?? line.description ?? '',
        storedQuantity: line.quantity,
        liveQuantity: null,
        reason: 'org_retargeted' as const,
      }));
      // The remaining lines carry no org-owned descriptor ids and can now move.
      await tx.update(quoteLines).set({ orgId: targetOrgId }).where(eq(quoteLines.quoteId, id));
      await tx.update(quoteImages).set({ orgId: targetOrgId }).where(eq(quoteImages.quoteId, id));

      // Unscoped descriptors name nothing org-owned, so their count from the
      // previous organization is meaningless. Re-derive in the target org.
      const unscoped = await tx.select().from(quoteLines).where(and(
        eq(quoteLines.quoteId, id),
        isNotNull(quoteLines.contractLineType),
        isNull(quoteLines.deviceGroupId),
        isNull(quoteLines.siteId),
      ));
      if (unscoped.length > 0) {
        const counts = await countQuoteDeviceSetLines(targetOrgId, unscoped.map(toQuoteDeviceSetLine));
        await persistQuoteDeviceSetQuantities(tx, id, q.currencyCode, unscoped, counts);
      }
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
  return { ...updated!, deviceSetDrift };
}

export async function deleteDraftQuote(id: string, actor: QuoteActor) {
  await loadDraft(id, actor);
  await db.delete(quotes).where(eq(quotes.id, id)); // blocks/lines cascade
}

/**
 * Draft-only atomic change-currency operation (multi-currency wave 2, #3774).
 * A draft's stamped currency is immutable through every other mutation path —
 * updateQuoteSchema never admitted currencyCode — so this is the ONLY way the
 * stamp moves, and only while the quote is a draft. With monetary lines
 * present the change is refused (CURRENCY_LOCKED 409) unless the caller opts
 * into `clearLines`, which deletes the quote's lines (blocks stay — an empty
 * line-items block is valid) and restamps in ONE transaction, or into
 * `reprice` (wave 3, #3775), which re-resolves catalog-sourced lines from the
 * price book in the new currency (see repriceQuoteCatalogLines). Amounts are
 * never converted or reinterpreted.
 */
export async function changeQuoteCurrency(
  quoteId: string,
  input: { currencyCode: string; clearLines?: boolean; reprice?: boolean },
  actor: QuoteActor
) {
  return db.transaction(async (tx) => {
    // Quote row lock FIRST (document → lines, the same order the accept path
    // takes). Every line writer takes the same lock via lockDraftQuote, so a
    // concurrent send/accept/line write serializes against the restamp
    // instead of observing a half-changed draft.
    const q = await lockDraftQuote(tx, quoteId, actor);
    if (q.currencyCode === input.currencyCode) return q; // no-op restamp

    const lineRows = await tx.select({
      id: quoteLines.id, sourceType: quoteLines.sourceType, catalogItemId: quoteLines.catalogItemId,
      parentLineId: quoteLines.parentLineId, quantity: quoteLines.quantity,
    }).from(quoteLines).where(eq(quoteLines.quoteId, quoteId)).orderBy(quoteLines.id);
    // #3205 W05 / W04 decision 15: repriceQuoteCatalogLines writes only
    // unit_price, line_total and unit_cost — it cannot re-derive a hand-entered
    // overage rate, which would otherwise survive the restamp in the OLD
    // currency.
    // clearLines deletes every line (the stamped one included), so the lock
    // only matters when lines survive the restamp (reprice / no-op paths).
    const [stamped] = input.clearLines
      ? [undefined]
      : await tx.select({ id: quoteLines.id }).from(quoteLines)
        .where(and(eq(quoteLines.quoteId, quoteId), isNotNull(quoteLines.overageUnitPrice))).limit(1);
    if (stamped) {
      throw new QuoteServiceError(
        'This quote has a hand-entered overage price; clear it before changing the currency',
        409,
        'CURRENCY_LOCKED',
      );
    }
    if (lineRows.length > 0) {
      if (input.reprice) {
        await repriceQuoteCatalogLines(tx, q, lineRows, input.currencyCode, actor);
      } else if (!input.clearLines) {
        throw new QuoteServiceError(
          `Quote has ${lineRows.length} line(s) priced in ${q.currencyCode} — pass clearLines to remove them, or delete the draft`,
          409, 'CURRENCY_LOCKED'
        );
      } else {
        await tx.delete(quoteLines).where(eq(quoteLines.quoteId, quoteId));
      }
    }

    await tx.update(quotes).set({ currencyCode: input.currencyCode, updatedAt: new Date() }).where(eq(quotes.id, quoteId));
    // Lines are either gone, never existed, or already repriced in the NEW
    // currency: totals recompute inside the same transaction as the restamp.
    await recomputeAndPersist(quoteId, tx);
    const [updated] = await tx.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
    return updated!;
  });
}

/**
 * Multi-currency wave 3 (#3775): `reprice` re-resolves every catalog-sourced
 * line from the price book in the TARGET currency on the already-locked tx
 * (quote row → lines → catalog plain SELECTs — no new lock edge). Only
 * `sourceType === 'catalog'` lines with a catalog item are repriceable: bundle
 * parents/children and manual lines carry amounts the price book cannot
 * re-derive, so their presence refuses the whole operation (CURRENCY_LOCKED —
 * the caller must clearLines instead). A single price-book gap aborts the
 * transaction (NO_PRICE_FOR_CURRENCY, naming the item) — never a partial
 * reprice, never a converted number.
 */
async function repriceQuoteCatalogLines(
  tx: DbExecutor,
  q: { orgId: string; partnerId: string },
  lines: Array<{ id: string; sourceType: string; catalogItemId: string | null; parentLineId: string | null; quantity: string }>,
  currencyCode: string,
  actor: QuoteActor
): Promise<void> {
  const repriceable = lines.filter((l) => l.sourceType === 'catalog' && l.catalogItemId !== null && l.parentLineId === null);
  const rest = lines.length - repriceable.length;
  if (rest > 0) {
    throw new QuoteServiceError(`${rest} non-catalog line(s) have no price in the new currency — remove all lines first, or keep the current currency`, 409, 'CURRENCY_LOCKED');
  }
  const catalogActor = { userId: actor.userId, partnerId: q.partnerId, accessibleOrgIds: actor.accessibleOrgIds };
  for (const line of repriceable) {
    let resolved;
    try {
      resolved = await resolvePrice(line.catalogItemId!, currencyCode, q.orgId, catalogActor, tx);
    } catch (err) {
      if (err instanceof CatalogServiceError && (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE')) {
          throw new QuoteServiceError(err.message, 409, err.code);
      }
      throw err;
    }
    await tx.update(quoteLines).set({
      unitPrice: resolved.unitPrice,
      lineTotal: computeLineTotal(line.quantity, resolved.unitPrice, currencyCode),
      // Cost is only meaningful in the line's currency (no conversion).
      unitCost: resolved.marginAvailable ? resolved.costBasis : null,
    }).where(eq(quoteLines.id, line.id));
  }
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
  const { content, warnings } = sanitizeBlockContentForWrite(input);
  const [row] = await db.insert(quoteBlocks).values({
    quoteId,
    orgId: q.orgId,
    blockType: input.blockType,
    content,
    sortOrder,
  }).returning();
  logStrippedMarkup('addBlock', quoteId, row!.id, warnings);
  return { ...row!, warnings };
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
  const { content, warnings } = sanitizeBlockContentForWrite(input);
  const [row] = await db.update(quoteBlocks)
    .set({ content })
    .where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, quoteId)))
    .returning();
  logStrippedMarkup('updateBlock', quoteId, blockId, warnings);
  return { ...row!, warnings };
}

/**
 * Delete a block and any lines attached to it. Deleting the block's lines first
 * (rather than relying solely on a DB cascade) keeps a pricing-table section's
 * removal atomic at the app layer — removing a line_items block also removes its
 * lines, never orphaning them — and lets recomputeAndPersist re-derive the
 * header totals from the lines that remain.
 */
export async function deleteBlock(quoteId: string, blockId: string, actor: QuoteActor) {
  await db.transaction(async (tx) => {
    await lockDraftQuote(tx, quoteId, actor); // removes lines + recomputes → takes the quote lock first
    await tx.delete(quoteLines).where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.blockId, blockId)));
    await tx.delete(quoteBlocks).where(and(eq(quoteBlocks.id, blockId), eq(quoteBlocks.quoteId, quoteId)));
    await recomputeAndPersist(quoteId, tx);
  });
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
async function resolveLineBlockId(quoteId: string, orgId: string, blockId: string | null | undefined, dbc: DbExecutor = db): Promise<string> {
  if (blockId) return blockId;
  const [existing] = await dbc
    .select({ id: quoteBlocks.id })
    .from(quoteBlocks)
    .where(and(eq(quoteBlocks.quoteId, quoteId), eq(quoteBlocks.blockType, 'line_items')))
    .orderBy(quoteBlocks.sortOrder)
    .limit(1);
  if (existing) return existing.id;
  const sortOrder = await nextBlockSortOrder(quoteId, dbc);
  const [block] = await dbc
    .insert(quoteBlocks)
    .values({ quoteId, orgId, blockType: 'line_items', content: {}, sortOrder })
    .returning({ id: quoteBlocks.id });
  return block!.id;
}

/**
 * Wave-6 release gate (W6-G2-1): hand-entered money on a quote line must be
 * representable in the QUOTE's stamped currency (¥100.50 is refused, never
 * silently rounded — owner-fixed: no conversion, snapshots rule).
 */
function assertRepresentable(value: string, currencyCode: string): void {
  if (!isRepresentableInCurrency(value, currencyCode)) {
    throw new QuoteServiceError(
      `${value} is not representable in ${currencyCode} — this currency has ${minorUnitExponent(currencyCode)} decimal place(s)`,
      400, 'PRICE_NOT_REPRESENTABLE'
    );
  }
}

/** #3205 W05: resolve and STAMP a device group in the quote's org. Same shape as
 *  contractService's assertGroupInOrg — the stamp is what survives the FK's
 *  ON DELETE SET NULL and lets a deleted reference be detected. */
async function assertQuoteGroupInOrg(tx: DbExecutor, groupId: string, orgId: string) {
  const [row] = await tx.select({ id: deviceGroups.id, name: deviceGroups.name, type: deviceGroups.type })
    .from(deviceGroups).where(and(eq(deviceGroups.id, groupId), eq(deviceGroups.orgId, orgId))).limit(1);
  if (!row) throw new QuoteServiceError('Device group does not belong to this organization', 400, 'GROUP_NOT_IN_ORG');
  return row;
}

async function assertQuoteSiteInOrg(tx: DbExecutor, siteId: string, orgId: string) {
  const [row] = await tx.select({ id: sites.id, name: sites.name })
    .from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).limit(1);
  if (!row) throw new QuoteServiceError('Site does not belong to this organization', 400, 'SITE_NOT_IN_ORG');
  return row;
}

export async function addManualLine(quoteId: string, input: QuoteLineInput, actor: QuoteActor) {
  return db.transaction(async (tx) => {
    const q = await lockDraftQuote(tx, quoteId, actor);
    const unitPrice = Number(input.unitPrice).toFixed(2);
    assertRepresentable(unitPrice, q.currencyCode);
    // #3205 W05: the device-set descriptor. Resolve + stamp the references, then
    // DERIVE the quantity from the same helpers that will bill it (decision 5).
    const setType = input.contractLineType ?? null;
    const group = setType === 'per_device_group' && input.deviceGroupId
      ? await assertQuoteGroupInOrg(tx, input.deviceGroupId, q.orgId) : null;
    const site = setType && input.siteId ? await assertQuoteSiteInOrg(tx, input.siteId, q.orgId) : null;
    const overageUnitPrice = input.overageUnitPrice != null ? Number(input.overageUnitPrice).toFixed(2) : null;
    if (overageUnitPrice != null) assertRepresentable(overageUnitPrice, q.currencyCode);
    const includedQuantity = input.includedQuantity != null ? Number(input.includedQuantity).toFixed(2) : null;

    let quantity = String(input.quantity);
    if (setType) {
      const [count] = await countQuoteDeviceSetLines(q.orgId, [{
        id: 'new', description: input.name ?? input.description ?? '',
        contractLineType: setType, deviceRoles: input.deviceRoles ?? null,
        deviceGroupId: group?.id ?? null, deviceGroupName: group?.name ?? null,
        siteId: site?.id ?? null, siteName: site?.name ?? null,
        includedQuantity, overageMode: input.overageMode ?? null, overageUnitPrice,
      }]);
      // Refusing to create a line whose number cannot be computed is better than
      // creating one at zero: a zero from a FAILED count is indistinguishable
      // from the legitimate new-customer zero.
      if (count!.error) {
        throw new QuoteServiceError(
          'This device set could not be counted right now — check the device group and try again',
          400, 'DEVICE_SET_UNCOUNTABLE', { reason: count!.error, groupName: group?.name ?? null },
        );
      }
      quantity = count!.billed.toFixed(2);
    }
    if (input.unitCost != null) assertRepresentable(Number(input.unitCost).toFixed(2), q.currencyCode);
    const blockId = await resolveLineBlockId(quoteId, q.orgId, input.blockId, tx);
    const sortOrder = await nextLineSortOrder(quoteId, tx);
    const [row] = await tx.insert(quoteLines).values({
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
      lineTotal: computeLineTotal(quantity, unitPrice, q.currencyCode),
      recurrence: input.recurrence,
      termMonths: input.termMonths ?? null,
      billingFrequency: input.billingFrequency ?? null,
      contractLineType: setType,
      deviceRoles: setType === 'per_device_role' ? (input.deviceRoles ?? null) : null,
      deviceGroupId: group?.id ?? null,
      deviceGroupName: group?.name ?? null,
      siteId: site?.id ?? null,
      siteName: site?.name ?? null,
      includedQuantity,
      overageMode: input.overageMode ?? null,
      overageUnitPrice,
      unitCost: input.unitCost != null ? Number(input.unitCost).toFixed(2) : null,
      sku: input.sku ?? null,
      partNumber: input.partNumber ?? null,
      procurementSource: input.procurementSource ?? null,
      vendorSku: input.vendorSku ?? null,
      manufacturer: input.manufacturer ?? null,
      depositEligible: input.depositEligible ?? false,
      itemType: null,
      sortOrder,
    }).returning();
    await recomputeAndPersist(quoteId, tx);
    return row!;
  });
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
  return db.transaction(async (tx) => {
    const q = await lockDraftQuote(tx, quoteId, actor);
    // Scope the catalog lookup to the quote's OWN partner. catalog_items is
    // partner-axis RLS, which contains a foreign item for a partner-scope caller —
    // but under SYSTEM scope the partner predicate short-circuits, so without this
    // explicit filter a system-scope request could snapshot another partner's
    // catalog item (name/price/taxable/billingType) into the quote line and bind a
    // foreign catalog_item_id FK. Mirrors invoiceService → catalogService's
    // getOwnedItemOr404(id, partnerId): a foreign item resolves to not-found
    // regardless of read scope.
    const [item] = await tx.select().from(catalogItems)
      .where(and(eq(catalogItems.id, catalogItemId), eq(catalogItems.partnerId, q.partnerId)))
      .limit(1);
    if (!item) throw new QuoteServiceError('Catalog item not found', 404, 'CATALOG_ITEM_NOT_FOUND');
    // Multi-currency wave 3 (#3775, B3): the sell price comes from the price book
    // (org override in the quote's currency → catalog_item_prices row for that
    // currency), never from the deprecated catalog_items.unit_price mirror and
    // never converted. Resolved on the already-locked tx (quote → lines → catalog
    // plain SELECTs — no new lock edge). A gap is a typed 409 so the caller can
    // fall back to a manual line.
    let resolved;
    try {
      resolved = await resolvePrice(
        catalogItemId,
        q.currencyCode,
        q.orgId,
        { userId: actor.userId, partnerId: q.partnerId, accessibleOrgIds: actor.accessibleOrgIds },
        tx
      );
    } catch (err) {
      if (err instanceof CatalogServiceError && (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE')) {
          throw new QuoteServiceError(err.message, 409, err.code);
      }
      throw err;
    }
    const vendor = vendorIdentityFromAttributes(item.attributes);
    // Phase 1 recurrence is monthly|annual only; quarterly is not offered (dropped
    // from the catalog Zod enum). The DB enum retains 'quarterly' for a future phase.
    const recurrence = item.billingType === 'recurring'
      ? (item.billingFrequency === 'annual' ? 'annual' : 'monthly')
      : 'one_time';
    const qty = String(quantity);
    const resolvedBlockId = await resolveLineBlockId(quoteId, q.orgId, blockId, tx);
    const sortOrder = await nextLineSortOrder(quoteId, tx);
    const [row] = await tx.insert(quoteLines).values({
      quoteId,
      orgId: q.orgId,
      blockId: resolvedBlockId,
      sourceType: 'catalog',
      catalogItemId,
      // Mirror the catalog item: its name is the line title, its description the blurb.
      name: item.name,
      description: item.description ?? null,
      quantity: qty,
      unitPrice: resolved.unitPrice,
      taxable: resolved.taxable,
      customerVisible: true,
      lineTotal: computeLineTotal(qty, resolved.unitPrice, q.currencyCode),
      recurrence,
      termMonths: item.commitmentTermMonths ?? null,
      billingFrequency: item.billingFrequency ?? null,
      // Snapshot internal economics from the catalog item at add-time so a later
      // catalog edit never mutates existing quote line cost/sku data. Cost is
      // only meaningful in the line's currency: when the item's cost_currency
      // differs from the quote currency the margin is unavailable (no conversion).
      unitCost: resolved.marginAvailable ? resolved.costBasis : null,
      sku: item.sku ?? null,
      partNumber: options?.partNumber ?? vendor.mfgPartNo,
      procurementSource: vendor.procurementSource,
      vendorSku: vendor.vendorSku,
      manufacturer: vendor.manufacturer,
      // Deposit eligibility defaults from the catalog item's type — hardware is the
      // one category a deposit typically secures (custom order, restocking risk).
      // itemType is snapshotted at add-time so a later catalog recategorization
      // never reshuffles an existing quote's category breakdown or deposit math.
      depositEligible: item.itemType === 'hardware',
      itemType: item.itemType,
      sortOrder,
    }).returning();
    await recomputeAndPersist(quoteId, tx);
    return row!;
  });
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
    procurementSource?: string | null; vendorSku?: string | null; manufacturer?: string | null;
    imageId?: string | null;
    depositEligible?: boolean;
    deviceRoles?: string[];
    deviceGroupId?: string;
    siteId?: string | null;
    includedQuantity?: number | null;
    overageMode?: 'bill' | 'flag' | null;
    overageUnitPrice?: number | null;
  },
  actor: QuoteActor
) {
  return db.transaction(async (tx) => {
    const q = await lockDraftQuote(tx, quoteId, actor);
    const [existing] = await tx.select().from(quoteLines)
      .where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId))).limit(1);
    if (!existing) throw new QuoteServiceError('Line not found', 404, 'LINE_NOT_FOUND');
    // #3205 W05. A patch naming contractLineType is already a 400 at the
    // .strict() schema edge, so the service never sees one.
    if (existing.contractLineType && input.quantity !== undefined) {
      // The schema cannot enforce this stateful rule because a PATCH carries no
      // contractLineType and only the service knows what the stored line IS.
      throw new QuoteServiceError(
        'quantity is derived from the live device count on a device-set line — use POST /quotes/:id/lines/refresh-device-counts',
        400, 'INVALID_LINE_PATCH', { issues: [{ path: 'quantity', message: 'quantity is server-derived on a device-set line' }] },
      );
    }
    const descriptorKeys = [
      'deviceRoles', 'deviceGroupId', 'siteId', 'includedQuantity', 'overageMode', 'overageUnitPrice',
    ] as const;
    if (!existing.contractLineType) {
      const invalidDescriptorKeys = descriptorKeys.filter((key) =>
        Object.prototype.hasOwnProperty.call(input, key));
      if (invalidDescriptorKeys.length > 0) {
        throw new QuoteServiceError(
          'this line has no device set',
          400,
          'INVALID_LINE_PATCH',
          {
            issues: invalidDescriptorKeys.map((path) => ({
              path,
              message: 'device-set fields are only valid on a device-set line',
            })),
          },
        );
      }
    }
    const quantity = input.quantity != null ? String(input.quantity) : existing.quantity;
    const unitPrice = input.unitPrice != null ? Number(input.unitPrice).toFixed(2) : existing.unitPrice;
    if (input.unitPrice != null) assertRepresentable(unitPrice, q.currencyCode);
    if (input.unitCost != null) assertRepresentable(Number(input.unitCost).toFixed(2), q.currencyCode);
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
      lineTotal: computeLineTotal(quantity, unitPrice, q.currencyCode),
    };
    if (input.termMonths !== undefined) set.termMonths = input.termMonths;
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
    if (input.unitCost !== undefined) set.unitCost = input.unitCost != null ? Number(input.unitCost).toFixed(2) : null;
    if (input.sku !== undefined) set.sku = input.sku;
    if (input.partNumber !== undefined) set.partNumber = input.partNumber;
    if (input.procurementSource !== undefined) set.procurementSource = input.procurementSource;
    if (input.vendorSku !== undefined) set.vendorSku = input.vendorSku;
    if (input.manufacturer !== undefined) set.manufacturer = input.manufacturer;
    if (input.depositEligible !== undefined) set.depositEligible = input.depositEligible;
    if (existing.contractLineType) {
      const persisted = {
        ...existing,
        includedQuantity: existing.includedQuantity == null ? null : Number(existing.includedQuantity),
        overageUnitPrice: existing.overageUnitPrice == null ? null : Number(existing.overageUnitPrice),
      };
      const merged = mergeQuoteLinePatch(persisted as never, input as never);

      // Resolve moved references before validating the final persisted shape so
      // adding a site to an org-wide line validates against its fresh stamp.
      if (input.deviceGroupId !== undefined && input.deviceGroupId !== existing.deviceGroupId) {
        const group = await assertQuoteGroupInOrg(tx, input.deviceGroupId, q.orgId);
        set.deviceGroupId = group.id;
        set.deviceGroupName = group.name;
        merged.deviceGroupId = group.id;
        merged.deviceGroupName = group.name;
      }
      if (Object.prototype.hasOwnProperty.call(input, 'siteId') && input.siteId !== existing.siteId) {
        const site = input.siteId ? await assertQuoteSiteInOrg(tx, input.siteId, q.orgId) : null;
        set.siteId = site?.id ?? null;
        set.siteName = site?.name ?? null;
        merged.siteId = site?.id ?? null;
        merged.siteName = site?.name ?? null;
      }

      const issues = quoteLineDeviceSetIssues(merged, { mode: 'persisted' });
      if (issues.length > 0) {
        throw new QuoteServiceError('Invalid line patch', 400, 'INVALID_LINE_PATCH', { issues });
      }

      for (const key of ['deviceRoles', 'includedQuantity', 'overageMode', 'overageUnitPrice'] as const) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
        const value = input[key];
        set[key] = key === 'includedQuantity' || key === 'overageUnitPrice'
          ? (value == null ? null : Number(value).toFixed(2))
          : (value ?? null);
      }
      if (set.overageUnitPrice) assertRepresentable(set.overageUnitPrice as string, q.currencyCode);

      // A descriptor change is the one mutation that explicitly re-counts this
      // line; unrelated edits retain the persisted estimate.
      const descriptorTouched = descriptorKeys
        .some((key) => Object.prototype.hasOwnProperty.call(input, key));
      if (descriptorTouched) {
        const valueFor = <T>(key: string, fallback: T): T =>
          (Object.prototype.hasOwnProperty.call(set, key) ? set[key] : fallback) as T;
        const [count] = await countQuoteDeviceSetLines(q.orgId, [{
          id: lineId,
          description: (set.name as string | null) ?? existing.name ?? existing.description ?? '',
          contractLineType: existing.contractLineType as QuoteDeviceSetType,
          deviceRoles: valueFor<string[] | null>('deviceRoles', existing.deviceRoles),
          deviceGroupId: valueFor<string | null>('deviceGroupId', existing.deviceGroupId),
          deviceGroupName: valueFor<string | null>('deviceGroupName', existing.deviceGroupName),
          siteId: valueFor<string | null>('siteId', existing.siteId),
          siteName: valueFor<string | null>('siteName', existing.siteName),
          includedQuantity: valueFor<string | null>('includedQuantity', existing.includedQuantity),
          overageMode: valueFor<'bill' | 'flag' | null>('overageMode', existing.overageMode as 'bill' | 'flag' | null),
          overageUnitPrice: valueFor<string | null>('overageUnitPrice', existing.overageUnitPrice),
        }]);
        if (count!.error) {
          throw new QuoteServiceError(
            'This device set could not be counted right now', 400, 'DEVICE_SET_UNCOUNTABLE', { reason: count!.error },
          );
        }
        set.quantity = count!.billed.toFixed(2);
        set.lineTotal = computeLineTotal(
          set.quantity as string, (set.unitPrice as string) ?? existing.unitPrice, q.currencyCode,
        );
      }
    }
    if (input.imageId !== undefined) {
      // Ownership check: the image must be a quote_images row on THIS quote, or a
      // caller could point a line at another tenant's image and exfiltrate its
      // bytes through the customer document/PDF.
      if (input.imageId !== null) {
        const [img] = await tx.select({ id: quoteImages.id }).from(quoteImages)
          .where(and(eq(quoteImages.id, input.imageId), eq(quoteImages.quoteId, quoteId))).limit(1);
        if (!img) throw new QuoteServiceError('Image not found on this quote', 404, 'IMAGE_NOT_FOUND');
      }
      set.imageId = input.imageId;
    }
    await tx.update(quoteLines).set(set).where(eq(quoteLines.id, lineId));
    await recomputeAndPersist(quoteId, tx);
    const [updated] = await tx.select().from(quoteLines).where(eq(quoteLines.id, lineId)).limit(1);
    return updated!;
  });
}

/** #3205 W05, decision 6: the explicit, auditable refresh. Drafts only — a
 *  sent quote's lines are immutable. A quantity never moves as a side effect of
 *  an unrelated edit. */
export async function refreshQuoteDeviceCounts(
  quoteId: string, actor: QuoteActor,
): Promise<QuoteDeviceSetCount[]> {
  return db.transaction(async (tx) => {
    let q;
    try {
      q = await lockDraftQuote(tx, quoteId, actor);
    } catch (err) {
      // This endpoint exposes INVALID_STATE for status conflicts, matching the
      // endpoint contract while retaining lockDraftQuote's standard guard.
      if (err instanceof QuoteServiceError && err.code === 'NOT_A_DRAFT') {
        throw new QuoteServiceError('Quote is not a draft', 409, 'INVALID_STATE');
      }
      throw err;
    }
    const rows = await tx.select().from(quoteLines)
      .where(and(eq(quoteLines.quoteId, quoteId), isNotNull(quoteLines.contractLineType)));
    if (rows.length === 0) return [];
    const counts = await countQuoteDeviceSetLines(q.orgId, rows.map(toQuoteDeviceSetLine));
    await persistQuoteDeviceSetQuantities(tx, quoteId, q.currencyCode, rows, counts);
    await recomputeAndPersist(quoteId, tx);
    return counts;
  });
}

/** Advisory live counts for the editor's staleness chip and the send-time drift
 *  report. READ-ONLY and available in any status — it changes nothing, so a
 *  sent quote can be inspected without being repriced. */
export async function quoteDeviceSetEstimate(
  quoteId: string, actor: QuoteActor,
): Promise<QuoteDeviceSetCount[]> {
  const [q] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  if (!q) throw new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND');
  assertQuoteAccess(actor, q);
  const rows = await db.select().from(quoteLines)
    .where(and(eq(quoteLines.quoteId, quoteId), isNotNull(quoteLines.contractLineType)));
  return countQuoteDeviceSetLines(q.orgId, rows.map(toQuoteDeviceSetLine));
}

export async function removeLine(quoteId: string, lineId: string, actor: QuoteActor) {
  await db.transaction(async (tx) => {
    await lockDraftQuote(tx, quoteId, actor);
    await tx.delete(quoteLines).where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId)));
    await recomputeAndPersist(quoteId, tx);
  });
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
