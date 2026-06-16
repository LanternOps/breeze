import { z } from 'zod';

export const billingStatusSchema = z.enum(['not_billed', 'billed', 'no_charge', 'contract']);
export type BillingStatus = z.infer<typeof billingStatusSchema>;

const CLOCK_SKEW_MS = 5 * 60_000;
const notFarFuture = (d: Date) => d.getTime() <= Date.now() + CLOCK_SKEW_MS;

export const createTimeEntrySchema = z.object({
  ticketId: z.string().guid().optional(),
  startedAt: z.coerce.date().refine(notFarFuture, { message: 'startedAt cannot be in the future' }),
  endedAt: z.coerce.date(),
  description: z.string().max(10_000).optional(),
  isBillable: z.boolean().optional(),
  hourlyRate: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  billingStatus: billingStatusSchema.optional()
}).refine((v) => v.endedAt.getTime() > v.startedAt.getTime(), {
  message: 'endedAt must be after startedAt',
  path: ['endedAt']
});

export const updateTimeEntrySchema = z.object({
  ticketId: z.string().guid().nullable().optional(),
  startedAt: z.coerce.date().refine(notFarFuture, { message: 'startedAt cannot be in the future' }).optional(),
  endedAt: z.coerce.date().optional(),
  description: z.string().max(10_000).nullable().optional(),
  isBillable: z.boolean().optional(),
  hourlyRate: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  billingStatus: billingStatusSchema.optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export const startTimerSchema = z.object({
  ticketId: z.string().guid().optional(),
  description: z.string().max(10_000).optional()
});

export const stopTimerSchema = z.object({
  description: z.string().max(10_000).optional(),
  isBillable: z.boolean().optional()
});

export const listTimeEntriesQuerySchema = z.object({
  userId: z.string().guid().optional(),
  ticketId: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  running: z.coerce.boolean().optional(),
  billingStatus: billingStatusSchema.optional(),
  approved: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const bulkApproveSchema = z.object({
  ids: z.array(z.string().guid()).min(1).max(200),
  approve: z.boolean().default(true)
}).refine((v) => new Set(v.ids).size === v.ids.length, {
  message: 'ids must be unique',
  path: ['ids']
});

export const timesheetQuerySchema = z.object({
  userId: z.string().guid().optional(),
  weekStart: z.coerce.date()
});

export const ticketPartSchema = z.object({
  description: z.string().min(1).max(2_000),
  partNumber: z.string().max(100).optional(),
  vendor: z.string().max(100).optional(),
  quantity: z.number().positive().multipleOf(0.01),
  unitPrice: z.number().nonnegative().multipleOf(0.01).default(0),
  costBasis: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  isBillable: z.boolean().optional(),
  billingStatus: billingStatusSchema.optional(),
  notes: z.string().max(10_000).optional()
});

// PATCH body: every field optional, and crucially NO default injected. v4's
// .partial() now applies child .default()s (unlike v3), so leaving unitPrice's
// create-time .default(0) would silently reset the stored unit price to 0 on any
// partial update that omits it — and would defeat the at-least-one-field guard.
// Re-declare unitPrice without its default for the update variant.
export const updateTicketPartSchema = ticketPartSchema
  .extend({ unitPrice: z.number().nonnegative().multipleOf(0.01).optional() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export const billablesExportQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  orgId: z.string().guid().optional()
}).refine((v) => v.to.getTime() >= v.from.getTime(), { message: 'to must be on/after from', path: ['to'] })
  .refine((v) => v.to.getTime() - v.from.getTime() <= 366 * 24 * 60 * 60 * 1000, { message: 'Export window cannot exceed 366 days', path: ['to'] });

export type CreateTimeEntryInput = z.infer<typeof createTimeEntrySchema>;
export type UpdateTimeEntryInput = z.infer<typeof updateTimeEntrySchema>;
export type TicketPartInput = z.infer<typeof ticketPartSchema>;
