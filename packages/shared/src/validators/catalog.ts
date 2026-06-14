import { z } from 'zod';

export const catalogItemTypeSchema = z.enum(['hardware', 'software', 'service']);
export type CatalogItemType = z.infer<typeof catalogItemTypeSchema>;

export const catalogBillingTypeSchema = z.enum(['one_time', 'recurring']);
export type CatalogBillingType = z.infer<typeof catalogBillingTypeSchema>;

const money = z.number().nonnegative().multipleOf(0.01);

export const createCatalogItemSchema = z.object({
  itemType: catalogItemTypeSchema,
  name: z.string().min(1).max(255),
  sku: z.string().max(100).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  billingType: catalogBillingTypeSchema.default('one_time'),
  unitPrice: money,
  costBasis: money.nullable().optional(),
  markupPercent: z.number().min(0).max(100_000).multipleOf(0.01).nullable().optional(),
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
  markupPercent: z.number().min(0).max(100_000).multipleOf(0.01).nullable().optional(),
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
  quantity: z.number().positive().multipleOf(0.01),
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
  isActive: z.coerce.boolean().optional(),
  isBundle: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional()
});
export type ListCatalogQuery = z.infer<typeof listCatalogQuerySchema>;
