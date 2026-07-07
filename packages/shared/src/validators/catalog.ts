import { z } from 'zod';

export const catalogItemTypeSchema = z.enum(['hardware', 'software', 'service']);
export type CatalogItemType = z.infer<typeof catalogItemTypeSchema>;

export const catalogBillingTypeSchema = z.enum(['one_time', 'recurring']);
export type CatalogBillingType = z.infer<typeof catalogBillingTypeSchema>;

export const catalogBillingFrequencySchema = z.enum(['monthly', 'annual']);
export type CatalogBillingFrequency = z.infer<typeof catalogBillingFrequencySchema>;

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

// AI enrichment provenance stored on a catalog item as `attributes.enrichment`.
// Defined here (above createCatalogItemSchema) so the create boundary can
// validate the known sub-key's shape; also reused on the enrich response path.
export const enrichmentProvenanceSchema = z.object({
  source: z.literal('ai_enrich'),
  model: z.string().max(100),
  query: z.string().max(200),
  // Bounded passthrough of exactly what the AI returned (the "suggestion").
  suggestion: z.record(z.string(), z.unknown()).refine(
    (v) => JSON.stringify(v).length <= 20_000,
    { message: 'enrichment suggestion is too large' }
  ),
  enrichedAt: z.string().max(40),
  enrichedBy: z.string().max(100),
});
export type EnrichmentProvenance = z.infer<typeof enrichmentProvenanceSchema>;

export const createCatalogItemSchema = z.object({
  itemType: catalogItemTypeSchema,
  name: z.string().min(1).max(255),
  sku: z.string().max(100).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  billingType: catalogBillingTypeSchema.default('one_time'),
  billingFrequency: catalogBillingFrequencySchema.nullable().optional(),
  commitmentTermMonths: z.number().int().min(1).max(120).nullable().optional(),
  unitPrice: money,
  costBasis: money.nullable().optional(),
  markupPercent: markupPercent.nullable().optional(),
  unitOfMeasure: z.string().max(50).default('each'),
  taxable: z.boolean().default(true),
  taxCategory: z.string().max(100).nullable().optional(),
  isBundle: z.boolean().default(false),
  // AI provenance is stored as attributes.enrichment (see CatalogItemEditorDrawer).
  // Validate that known sub-key's shape at the write boundary so a malformed
  // provenance object can't be persisted, while still allowing forward-compatible
  // extra keys via .catchall(). The serialized-size refine bounds the whole map
  // (the enrichmentProvenanceSchema's own 20k suggestion cap also applies here).
  attributes: z.object({
    enrichment: enrichmentProvenanceSchema.optional(),
  })
    .catchall(z.unknown())
    .refine((v) => JSON.stringify(v).length <= 60_000, { message: 'attributes payload is too large' })
    .default({})
});
export type CreateCatalogItemInput = z.infer<typeof createCatalogItemSchema>;

export const updateCatalogItemSchema = z.object({
  itemType: catalogItemTypeSchema.optional(),
  name: z.string().min(1).max(255).optional(),
  sku: z.string().max(100).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  billingType: catalogBillingTypeSchema.optional(),
  billingFrequency: catalogBillingFrequencySchema.nullable().optional(),
  commitmentTermMonths: z.number().int().min(1).max(120).nullable().optional(),
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
  componentItemId: z.string().guid(),
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
  cursor: z.string().guid().optional()
});
export type ListCatalogQuery = z.infer<typeof listCatalogQuerySchema>;

export const enrichRequestSchema = z.object({
  query: z.string().min(1).max(200),
  hint: catalogItemTypeSchema.optional(),
});
export type EnrichRequest = z.infer<typeof enrichRequestSchema>;

export const enrichDraftSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(10_000).nullable(),
  itemType: catalogItemTypeSchema,
  unitOfMeasure: z.string().max(50),
  taxable: z.boolean(),
  taxCategory: z.string().max(100).nullable(),
});
export type EnrichDraft = z.infer<typeof enrichDraftSchema>;

// enrichmentProvenanceSchema / EnrichmentProvenance are defined above
// createCatalogItemSchema so the create boundary can reference them.

export const enrichResponseSchema = z.object({
  draft: enrichDraftSchema,
  priceGuidance: z.string().max(120).nullable(),
  // Best-effort single-unit acquisition-cost estimate (what the MSP would pay,
  // not MSRP). Advisory: hosts may pre-fill an internal cost field with it, but
  // it must never be committed anywhere without the user able to review it.
  estimatedCost: z.number().min(0).nullable(),
  provenance: enrichmentProvenanceSchema,
});
export type EnrichResponse = z.infer<typeof enrichResponseSchema>;

// "Polish with AI": presentation-only clean-up of a name and/or description the
// user already has. Unlike enrich, this does NO web search and is contractually
// forbidden from changing any factual detail — it only fixes grammar, casing,
// spacing, structure, and strips distributor noise. Used by the catalog item
// editor, quote line editor, and invoice line editor.
export const polishTextRequestSchema = z.object({
  name: z.string().max(255).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
}).refine(
  (d) => Boolean(d.name?.trim()) || Boolean(d.description?.trim()),
  { message: 'Provide a name or description to polish' },
);
export type PolishTextRequest = z.infer<typeof polishTextRequestSchema>;

// A before/after diff of the numeric "fact" tokens (numbers, measurements,
// prices, and the digit runs inside model/part numbers). `added` are tokens the
// polished text has that the input did not — the genuinely risky, over-claiming
// direction. `removed` are tokens the input had that the polished text dropped —
// usually stripped distributor noise (order codes, pack counts). Canonicalized
// (lowercased, unit-normalized) so they read as hints, not exact source spans.
export const polishFactChangesSchema = z.object({
  added: z.array(z.string()).max(50),
  removed: z.array(z.string()).max(50),
});
export type PolishFactChanges = z.infer<typeof polishFactChangesSchema>;

export const polishTextResponseSchema = z.object({
  name: z.string().max(255).nullable(),
  description: z.string().max(10_000).nullable(),
  // True when the polished text differs from the input (lets the UI skip a
  // no-op "nothing changed" preview).
  changed: z.boolean(),
  // True when the fact guard detected a possible numeric/unit change the AI
  // could not avoid (e.g. it stripped a digit-bearing distributor code, or it
  // may have altered a spec). The polished text is still returned — the guard is
  // ADVISORY, not blocking — but the UI must warn the user to review the
  // before/after carefully before applying. `factChanges` lists what differs.
  factWarning: z.boolean(),
  factChanges: polishFactChangesSchema.nullable(),
});
export type PolishTextResponse = z.infer<typeof polishTextResponseSchema>;
