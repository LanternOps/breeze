import { z } from 'zod';

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
const imageContent = z.object({ imageId: z.string().uuid(), caption: z.string().max(500).optional(), width: z.number().int().min(50).max(2000).optional() });
const lineItemsContent = z.object({ label: z.string().max(200).optional() });

export const quoteBlockInputSchema = z.discriminatedUnion('blockType', [
  z.object({ blockType: z.literal('heading'), content: headingContent }),
  z.object({ blockType: z.literal('rich_text'), content: richTextContent }),
  z.object({ blockType: z.literal('image'), content: imageContent }),
  z.object({ blockType: z.literal('line_items'), content: lineItemsContent }),
]);

export const quoteLineInputSchema = z.object({
  sourceType: quoteLineSourceTypeSchema,
  catalogItemId: z.string().uuid().optional(),
  blockId: z.string().uuid().optional(),
  description: z.string().min(1).max(2000),
  quantity: positiveQty,
  unitPrice: money,
  taxable: z.boolean(),
  customerVisible: z.boolean().default(true),
  recurrence: quoteLineRecurrenceSchema.default('one_time'),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
  billingFrequency: z.enum(['monthly', 'annual']).nullable().optional(),
});

export const catalogQuoteLineSchema = z.object({ catalogItemId: z.string().uuid(), quantity: positiveQty, blockId: z.string().uuid().optional() });
export const bundleQuoteLineSchema = z.object({ bundleId: z.string().uuid(), quantity: positiveQty, blockId: z.string().uuid().optional() });

export const updateQuoteLineSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  quantity: positiveQty.optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  customerVisible: z.boolean().optional(),
  recurrence: quoteLineRecurrenceSchema.optional(),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const createQuoteSchema = z.object({
  orgId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  currencyCode: z.string().length(3).default('USD'),
  expiryDate: isoDate.optional(),
  introNotes: z.string().max(5000).optional(),
  terms: z.string().max(20_000).optional(),
});

export const updateQuoteSchema = z.object({
  siteId: z.string().uuid().nullable().optional(),
  expiryDate: isoDate.nullable().optional(),
  introNotes: z.string().max(5000).nullable().optional(),
  terms: z.string().max(20_000).nullable().optional(),
  taxRate: taxRate.nullable().optional(),
  billToName: z.string().max(255).nullable().optional(),
});

export const reorderBlocksSchema = z.object({ blockIds: z.array(z.string().uuid()).min(1) });

export const listQuotesQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  status: quoteStatusSchema.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

export type QuoteLineInput = z.infer<typeof quoteLineInputSchema>;
export type QuoteBlockInput = z.infer<typeof quoteBlockInputSchema>;
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>;
