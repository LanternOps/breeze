// packages/shared/src/validators/workTypes.ts
import { z } from 'zod';

export const WORK_TYPE_NAME_MAX = 60;

const nameSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, { message: 'Name is required' })
  .refine((v) => v.length <= WORK_TYPE_NAME_MAX, {
    message: `Name must be ${WORK_TYPE_NAME_MAX} characters or fewer`,
  });

/**
 * A new work type is always active -- `isActive` is deliberately absent, and
 * zod strips it, so a client cannot create a pre-archived label.
 */
export const createWorkTypeSchema = z.object({
  name: nameSchema,
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const updateWorkTypeSchema = z
  .object({
    name: nameSchema.optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export type CreateWorkTypeInput = z.infer<typeof createWorkTypeSchema>;
export type UpdateWorkTypeInput = z.infer<typeof updateWorkTypeSchema>;
