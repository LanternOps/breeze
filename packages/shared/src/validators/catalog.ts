import { z } from 'zod';

export const catalogItemTypeSchema = z.enum(['hardware', 'software', 'service']);
export type CatalogItemType = z.infer<typeof catalogItemTypeSchema>;

export const catalogBillingTypeSchema = z.enum(['one_time', 'recurring']);
export type CatalogBillingType = z.infer<typeof catalogBillingTypeSchema>;

// Bounded to numeric(12,2) (max 9,999,999,999.99) so out-of-range inputs fail
// fast with a 400 rather than overflowing at insert (DB-layer 500).
const money = z.number().nonnegative().max(9_999_999_999.99).multipleOf(0.01);

// markup_percent is numeric(6,2) in the schema (max 9999.99). Cap here so values
// in the 10000+ range are rejected up front instead of overflowing on insert.
const markupPercent = z.number().min(0).max(9999.99).multipleOf(0.01);

// Bundle component quantity is numeric(12,2) (max 9,999,999,999.99) in the schema.
// Match the money ceiling so an oversized quantity is rejected with a 400 rather
// than overflowing at insert (DB-layer 500).
const bundleQuantity = z.number().positive().max(9_999_999_999.99).multipleOf(0.01);

export const createCatalogItemSchema = z.object({
  itemType: catalogItemTypeSchema,
  name: z.string().min(1).max(255),
  sku: z.string().max(100).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  billingType: catalogBillingTypeSchema.default('one_time'),
  unitPrice: money,
  costBasis: money.nullable().optional(),
  markupPercent: markupPercent.nullable().optional(),
  unitOfMeasure: z.string().max(50).default('each'),
  taxable: z.boolean().default(true),
  taxCategory: z.string().max(100).nullable().optional(),
  isBundle: z.boolean().default(false),
  attributes: z.record(z.string(), z.unknown()).default({})
});
export type CreateCatalogItemInput = z.infer<typeof createCatalogItemSchema>;

export const updateCatalogItemSchema = z.object({
  itemType: catalogItemTypeSchema.optional(),
  name: z.string().min(1).max(255).optional(),
  sku: z.string().max(100).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  billingType: catalogBillingTypeSchema.optional(),
  unitPrice: money.optional(),
  costBasis: money.nullable().optional(),
  markupPercent: markupPercent.nullable().optional(),
  unitOfMeasure: z.string().max(50).optional(),
  taxable: z.boolean().optional(),
  taxCategory: z.string().max(100).nullable().optional(),
  isBundle: z.boolean().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
export type UpdateCatalogItemInput = z.infer<typeof updateCatalogItemSchema>;

export const orgPriceOverrideSchema = z.object({ unitPrice: money });
export type OrgPriceOverrideInput = z.infer<typeof orgPriceOverrideSchema>;

export const bundleComponentSchema = z.object({
  componentItemId: z.string().uuid(),
  quantity: bundleQuantity,
  showOnInvoice: z.boolean().default(false),
  revenueAllocation: money.nullable().optional()
});
export type BundleComponentInput = z.infer<typeof bundleComponentSchema>;

export const setBundleComponentsSchema = z.object({
  components: z.array(bundleComponentSchema).max(200)
});
export type SetBundleComponentsInput = z.infer<typeof setBundleComponentsSchema>;

export const listCatalogQuerySchema = z.object({
  itemType: catalogItemTypeSchema.optional(),
  // Tri-state boolean query params: z.coerce.boolean() uses JS truthiness, so the
  // strings "false"/"0" would coerce to true. Use the repo's enum-string idiom
  // (see apps/api/src/routes/alerts/schemas.ts) and transform to a real boolean so
  // ?isActive=false correctly filters for inactive items.
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  isBundle: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional()
});
export type ListCatalogQuery = z.infer<typeof listCatalogQuerySchema>;
