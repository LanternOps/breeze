import { z } from 'zod';
import { BULK_ID_LIMIT } from '../constants';

// Bounded to numeric(12,2) (max 9,999,999,999.99) so out-of-range inputs fail
// fast with a 400 rather than overflowing at insert (DB-layer 500). Mirrors the
// money/quantity ceiling in validators/catalog.ts.
const money = z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01);
const positiveQty = z.number().positive().max(9_999_999_999.99).multipleOf(0.01);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const taxRate = z.number().min(0).max(1);

export const quoteStatusSchema = z.enum(['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted']);
export const quoteLineRecurrenceSchema = z.enum(['one_time', 'monthly', 'annual']);
export const quoteLineSourceTypeSchema = z.enum(['catalog', 'bundle', 'manual']);
export const quoteBlockTypeSchema = z.enum(['heading', 'rich_text', 'image', 'line_items', 'contract']);
export const quoteDepositTypeSchema = z.enum(['none', 'percent', 'selected_lines']);

// Whole-percent, 2dp, exclusive bounds per spec (100% = "no deposit" — rejected).
const depositPercent = z.number().gt(0).lt(100).multipleOf(0.01);

// Block content shapes, discriminated by blockType.
const headingContent = z.object({ text: z.string().min(1).max(300), level: z.number().int().min(1).max(3).default(2) });
const richTextContent = z.object({ html: z.string().max(50_000) });
const imageContent = z.object({ imageId: z.string().guid(), caption: z.string().max(500).optional(), width: z.number().int().min(50).max(2000).optional() });
// `showSubtotal` opts this pricing table into a per-table subtotal row (summed
// from its own lines, split by recurrence). Off by default so existing tables
// render unchanged.
const lineItemsContent = z.object({ label: z.string().max(200).optional(), showSubtotal: z.boolean().optional() });
// A rendered contract embedded in the quote: references a specific (immutable)
// published template version, plus manual-variable fill-ins keyed by
// contractVariableSchema's `name` (validated at render time, not here — a
// quote block shouldn't need to know a template's declared variable set to
// parse). `variableValues` defaults to {} so a fresh block round-trips without
// the caller pre-seeding an empty object.
const contractContent = z.object({
  templateId: z.string().guid(),
  templateVersionId: z.string().guid(),
  variableValues: z.record(z.string(), z.string().max(2000)).default({}),
  label: z.string().max(200).optional(),
});

export const quoteBlockInputSchema = z.discriminatedUnion('blockType', [
  z.object({ blockType: z.literal('heading'), content: headingContent }),
  z.object({ blockType: z.literal('rich_text'), content: richTextContent }),
  z.object({ blockType: z.literal('image'), content: imageContent }),
  z.object({ blockType: z.literal('line_items'), content: lineItemsContent }),
  z.object({ blockType: z.literal('contract'), content: contractContent }),
]);

export const quoteLineInputSchema = z.object({
  sourceType: quoteLineSourceTypeSchema,
  catalogItemId: z.string().guid().optional(),
  blockId: z.string().guid().optional(),
  // Title (mirrors catalog name). `description` is the optional blurb beneath it.
  // At least one must be non-empty (refined below) so a line is never blank.
  name: z.string().max(255).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  quantity: positiveQty,
  unitPrice: money,
  taxable: z.boolean(),
  customerVisible: z.boolean().default(true),
  recurrence: quoteLineRecurrenceSchema.default('one_time'),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
  billingFrequency: z.enum(['monthly', 'annual']).nullable().optional(),
  unitCost: money.nullable().optional(),
  sku: z.string().max(100).nullable().optional(),
  partNumber: z.string().max(100).nullable().optional(),
  depositEligible: z.boolean().default(false),
}).refine((d) => Boolean(d.name?.trim() || d.description?.trim()), {
  message: 'A line needs a name or a description', path: ['name'],
});

export const catalogQuoteLineSchema = z.object({ catalogItemId: z.string().guid(), quantity: positiveQty, blockId: z.string().guid().optional(), partNumber: z.string().max(100).nullable().optional() });
export const bundleQuoteLineSchema = z.object({ bundleId: z.string().guid(), quantity: positiveQty, blockId: z.string().guid().optional() });

export const updateQuoteLineSchema = z.object({
  name: z.string().max(255).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  quantity: positiveQty.optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  customerVisible: z.boolean().optional(),
  recurrence: quoteLineRecurrenceSchema.optional(),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  unitCost: money.nullable().optional(),
  sku: z.string().max(100).nullable().optional(),
  partNumber: z.string().max(100).nullable().optional(),
  // Attach/replace (guid) or clear (null) the line's product image. Must be a
  // quote_images row on the same quote — the service enforces ownership.
  imageId: z.string().guid().nullable().optional(),
  depositEligible: z.boolean().optional(),
});

export const createQuoteSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid().optional(),
  title: z.string().max(200).optional(),
  currencyCode: z.string().length(3).default('USD'),
  expiryDate: isoDate.optional(),
  introNotes: z.string().max(5000).optional(),
  terms: z.string().max(20_000).optional(),
  termsAndConditions: z.string().max(20_000).optional(),
});

// Optional retarget/rename for POST /quotes/:id/clone. Omitted fields fall back
// to the source quote. `.strict()` so a mis-keyed field is a 400, not silently
// ignored (mirrors sendBodySchema).
export const cloneQuoteSchema = z.object({
  orgId: z.string().guid().optional(),
  title: z.string().max(200).optional(),
}).strict();

// Enhanced-proposals cover page (docs/superpowers/specs/2026-07-16-contract-documents-and-enhanced-proposals-design.md).
// Stored as quotes.cover_page jsonb; `enabled: false` is a valid, minimal
// payload (the customer-visible cover page toggled off) — every other field
// is optional/nullable so a partial edit doesn't force re-sending the whole
// object. `showPreparedBy` defaults true so existing quotes (no stored
// cover_page yet) that opt in for the first time show the preparer by default.
export const coverPageSchema = z.object({
  enabled: z.boolean(),
  title: z.string().max(200).optional(),
  coverImageId: z.string().guid().nullable().optional(),
  preparedForName: z.string().max(255).nullable().optional(),
  showPreparedBy: z.boolean().default(true),
});

export type CoverPage = z.infer<typeof coverPageSchema>;

export const updateQuoteSchema = z.object({
  // Reassign the draft to another organization of the same partner. The service
  // clears the site, and clears the billToName override / re-resolves the tax
  // rate for the new org unless the same patch provides them (drafts only, like
  // every other header field here — see updateQuote in quoteService).
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  introNotes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(20_000).nullable().optional(),
  termsAndConditions: z.string().max(20_000).nullable().optional(),
  taxRate: taxRate.nullable().optional(),
  billToName: z.string().max(255).nullable().optional(),
  depositType: quoteDepositTypeSchema.optional(),
  depositPercent: depositPercent.nullable().optional(),
  // Null clears a previously-set cover page back to "none stored"; omitted
  // leaves it untouched (same convention as every other nullable field here).
  coverPage: coverPageSchema.nullable().optional(),
}).refine(
  // A percent value is only meaningful for a 'percent' deposit. Reject a patch
  // that pairs a non-percent type with a percent in the same request, so the
  // contradiction is caught at the boundary instead of being silently nulled by
  // the service. (A bare { depositPercent } patch is still allowed — the service
  // derives the type from the stored quote.)
  (d) => !(d.depositType && d.depositType !== 'percent' && d.depositPercent != null),
  { message: 'depositPercent is only valid when depositType is "percent"', path: ['depositPercent'] },
);

// A reorder payload must be a clean permutation of the existing ids, so the id
// list has to be unique — without this, a duplicated id (e.g. [A, A] for blocks
// [A, B]) passes a length+membership check, renumbers A twice, never touches B,
// and corrupts sort_order. Uniqueness is enforced here so both routes are
// covered; the service re-checks as defense in depth.
const uniqueReorderIds = z
  .array(z.string().guid())
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'ids must be unique' });
export const reorderBlocksSchema = z.object({ blockIds: uniqueReorderIds });
export const reorderLinesSchema = z.object({ lineIds: uniqueReorderIds });
export type ReorderLinesInput = z.infer<typeof reorderLinesSchema>;
export type ReorderBlocksInput = z.infer<typeof reorderBlocksSchema>;

// Move a line to a different pricing-table (line_items) block on the same
// quote. The service appends it to the end of the target block's sort order;
// bundle children follow their parent.
export const moveQuoteLineSchema = z.object({ blockId: z.string().guid() });
export type MoveQuoteLineInput = z.infer<typeof moveQuoteLineSchema>;

export const acceptQuoteSchema = z.object({
  signerName: z.string().min(1).max(255),
  signerEmail: z.string().email().max(255).optional(),
});

export const declineQuoteSchema = z.object({
  reason: z.string().max(5000).optional(),
});

export const listQuotesQuerySchema = z.object({
  orgId: z.string().guid().optional(),
  status: quoteStatusSchema.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().guid().optional(),
});

export const bulkQuoteIdsSchema = z.object({
  // capped at BULK_ID_LIMIT: each item runs sequentially in its own short transaction (conn-pool safety)
  ids: z.array(z.string().guid()).min(1).max(BULK_ID_LIMIT),
});

export type QuoteLineInput = z.infer<typeof quoteLineInputSchema>;
export type QuoteBlockInput = z.infer<typeof quoteBlockInputSchema>;
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type CloneQuoteInput = z.infer<typeof cloneQuoteSchema>;
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>;
export type AcceptQuoteInput = z.infer<typeof acceptQuoteSchema>;
export type DeclineQuoteInput = z.infer<typeof declineQuoteSchema>;
