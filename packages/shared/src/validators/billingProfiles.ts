import { z } from 'zod';

const coverage = z.enum(['billable', 'included', 'non_billable']);
const rate = z.string().regex(/^\d{1,8}(\.\d{1,2})?$/).nullable();
const minimum = z.number().int().min(0).max(2147483647).nullable();
const profileFields = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().max(4000).nullable().optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  baseCoverage: coverage,
  baseHourlyRate: rate.optional(),
  baseMinimumMinutes: minimum.optional(),
  roundingIncrementMinutes: z.number().int().min(1).max(480).nullable().optional(),
  isDefault: z.boolean().optional(),
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
export const createProfileSchema = profileFields.extend({ rows: profileRowsSchema.shape.rows.optional() });
export const saveProfileSchema = profileFields.omit({ isDefault: true }).extend({
  rows: profileRowsSchema.shape.rows,
}).strict();
export type CreateProfileInput = z.infer<typeof createProfileSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type RowInput = z.infer<typeof profileRowSchema>;
export type SaveProfileInput = z.infer<typeof saveProfileSchema>;
