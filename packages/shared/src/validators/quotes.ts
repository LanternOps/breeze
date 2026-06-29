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
export const quoteBlockTypeSchema = z.enum(['heading', 'rich_text', 'image', 'line_items']);

// Block content shapes, discriminated by blockType.
const headingContent = z.object({ text: z.string().min(1).max(300), level: z.number().int().min(1).max(3).default(2) });
const richTextContent = z.object({ html: z.string().max(50_000) });
const imageContent = z.object({ imageId: z.string().guid(), caption: z.string().max(500).optional(), width: z.number().int().min(50).max(2000).optional() });
const lineItemsContent = z.object({ label: z.string().max(200).optional() });

export const quoteBlockInputSchema = z.discriminatedUnion('blockType', [
  z.object({ blockType: z.literal('heading'), content: headingContent }),
  z.object({ blockType: z.literal('rich_text'), content: richTextContent }),
  z.object({ blockType: z.literal('image'), content: imageContent }),
  z.object({ blockType: z.literal('line_items'), content: lineItemsContent }),
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
});

export const createQuoteSchema = z.object({
  orgId: z.string().guid(),
  siteId: z.string().guid().optional(),
  currencyCode: z.string().length(3).default('USD'),
  expiryDate: isoDate.optional(),
  introNotes: z.string().max(5000).optional(),
  terms: z.string().max(20_000).optional(),
  termsAndConditions: z.string().max(20_000).optional(),
});

export const updateQuoteSchema = z.object({
  siteId: z.string().guid().nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  introNotes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(20_000).nullable().optional(),
  termsAndConditions: z.string().max(20_000).nullable().optional(),
  taxRate: taxRate.nullable().optional(),
  billToName: z.string().max(255).nullable().optional(),
});

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
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>;
export type AcceptQuoteInput = z.infer<typeof acceptQuoteSchema>;
export type DeclineQuoteInput = z.infer<typeof declineQuoteSchema>;
