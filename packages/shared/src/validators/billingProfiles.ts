import { z } from 'zod';

const coverage = z.enum(['billable', 'included', 'non_billable']);
const rate = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/).nullable();
const minimum = z.number().int().min(0).max(2147483647).nullable();
// AI chargeback (#7608): the client price for AI usage lives on the card.
export const AI_COVERAGES = ['billable', 'included', 'non_billable'] as const;
export const aiCoverageSchema = z.enum(AI_COVERAGES);
export type AiCoverage = z.infer<typeof aiCoverageSchema>;
/** Percent over Breeze's metered cost, 0–1000, 2 dp. Applies only on a USD card. */
export const aiMarkupPercentSchema = z.string().regex(/^\d{1,4}(\.\d{1,2})?$/)
  .refine((value) => Number(value) <= 1000, { message: 'Markup must be at most 1000%' })
  .nullable();
/** Client price per million tokens, in the card's currency. */
const pricePerM = z.string().regex(/^\d{1,8}(\.\d{1,6})?$/);
export const aiRateRowSchema = z.object({
  /** Matched against ai_invocations.served_model (the model that actually served). */
  modelId: z.string().trim().min(1).max(200),
  inputPricePerM: pricePerM,
  outputPricePerM: pricePerM,
  cacheReadPricePerM: pricePerM,
  cacheWritePricePerM: pricePerM,
  notes: z.string().max(4000).nullable().optional(),
});
export const aiRateRowsSchema = z.array(aiRateRowSchema).max(200)
  .refine((rows) => new Set(rows.map((row) => row.modelId)).size === rows.length, { message: 'Duplicate model' });
export type AiRateRowInput = z.infer<typeof aiRateRowSchema>;
const profileFields = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().max(4000).nullable().optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  baseCoverage: coverage,
  baseHourlyRate: rate.optional(),
  baseMinimumMinutes: minimum.optional(),
  roundingIncrementMinutes: z.number().int().min(1).max(480).nullable().optional(),
  isDefault: z.boolean().optional(),
  aiCoverage: aiCoverageSchema.optional(),
  aiMarkupPercent: aiMarkupPercentSchema.optional(),
});
export const updateProfileSchema = profileFields.partial().extend({ isActive: z.boolean().optional() })
  .refine(input => Object.keys(input).length > 0, { message: 'At least one field is required' });
export const profileRowSchema = z.object({
  workTypeId: z.string().uuid(), coverage,
  hourlyRate: rate, minimumMinutes: minimum,
  notes: z.string().max(4000).nullable().optional(),
}).refine(row => row.coverage === 'billable' || (row.hourlyRate === null && row.minimumMinutes === null), {
  message: 'Only billable rows may have a rate or minimum',
});
export const profileRowsSchema = z.object({ rows: z.array(profileRowSchema).max(1000) });
// Creation and the Rates drawer both save a complete card in one request.
export const createProfileSchema = profileFields.extend({
  rows: profileRowsSchema.shape.rows.optional(),
  aiRates: aiRateRowsSchema.optional(),
});
export const saveProfileSchema = profileFields.omit({ isDefault: true }).extend({
  rows: profileRowsSchema.shape.rows,
  // Absent = leave the card's AI price list unchanged; [] = clear it.
  aiRates: aiRateRowsSchema.optional(),
}).strict();
export type CreateProfileInput = z.infer<typeof createProfileSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type RowInput = z.infer<typeof profileRowSchema>;
export type SaveProfileInput = z.infer<typeof saveProfileSchema>;
