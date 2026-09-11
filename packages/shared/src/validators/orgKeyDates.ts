import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const keyDateKindSchema = z.enum([
  'insurance_renewal',
  'vendor_contract_end',
  'compliance_deadline',
  'audit',
  'other',
]);

export const createKeyDateSchema = z.object({
  label: z.string().min(1).max(200),
  kind: keyDateKindSchema.default('other'),
  date: isoDate,
  recursAnnually: z.boolean().default(false),
  remindDaysBefore: z.number().int().min(0).max(365).nullable().optional(),
  ownerUserId: z.string().guid().nullable().optional(),
  portalVisible: z.boolean().default(false),
  notes: z.string().max(4000).nullable().optional(),
});
// Longhand rather than `createKeyDateSchema.partial()`: under zod 4, `.partial()`
// keeps the create-time defaults firing, so a PATCH of `{ notes }` would also
// reset kind/recursAnnually/portalVisible. Update fields carry no defaults.
export const updateKeyDateSchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    kind: keyDateKindSchema.optional(),
    date: isoDate.optional(),
    recursAnnually: z.boolean().optional(),
    remindDaysBefore: z.number().int().min(0).max(365).nullable().optional(),
    ownerUserId: z.string().guid().nullable().optional(),
    portalVisible: z.boolean().optional(),
    notes: z.string().max(4000).nullable().optional(),
  })
  .strict();

export type CreateKeyDateInput = z.infer<typeof createKeyDateSchema>;
export type UpdateKeyDateInput = z.infer<typeof updateKeyDateSchema>;
