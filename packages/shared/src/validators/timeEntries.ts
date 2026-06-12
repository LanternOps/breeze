import { z } from 'zod';

export const billingStatusSchema = z.enum(['not_billed', 'billed', 'no_charge', 'contract']);
export type BillingStatus = z.infer<typeof billingStatusSchema>;

const CLOCK_SKEW_MS = 5 * 60_000;
const notFarFuture = (d: Date) => d.getTime() <= Date.now() + CLOCK_SKEW_MS;

export const createTimeEntrySchema = z.object({
  ticketId: z.string().uuid().optional(),
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
  ticketId: z.string().uuid().nullable().optional(),
  startedAt: z.coerce.date().refine(notFarFuture, { message: 'startedAt cannot be in the future' }).optional(),
  endedAt: z.coerce.date().optional(),
  description: z.string().max(10_000).nullable().optional(),
  isBillable: z.boolean().optional(),
  hourlyRate: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  billingStatus: billingStatusSchema.optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export const startTimerSchema = z.object({
  ticketId: z.string().uuid().optional(),
  description: z.string().max(10_000).optional()
});

export const stopTimerSchema = z.object({
  description: z.string().max(10_000).optional(),
  isBillable: z.boolean().optional()
});

export const listTimeEntriesQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  ticketId: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  running: z.coerce.boolean().optional(),
  billingStatus: billingStatusSchema.optional(),
  approved: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const bulkApproveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  approve: z.boolean().default(true)
}).refine((v) => new Set(v.ids).size === v.ids.length, {
  message: 'ids must be unique',
  path: ['ids']
});

export const timesheetQuerySchema = z.object({
  userId: z.string().uuid().optional(),
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

export const updateTicketPartSchema = ticketPartSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'At least one field is required' }
);

export const billablesExportQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  orgId: z.string().uuid().optional()
}).refine((v) => v.to.getTime() >= v.from.getTime(), { message: 'to must be on/after from', path: ['to'] })
  .refine((v) => v.to.getTime() - v.from.getTime() <= 366 * 24 * 60 * 60 * 1000, { message: 'Export window cannot exceed 366 days', path: ['to'] });

export type CreateTimeEntryInput = z.infer<typeof createTimeEntrySchema>;
export type UpdateTimeEntryInput = z.infer<typeof updateTimeEntrySchema>;
export type TicketPartInput = z.infer<typeof ticketPartSchema>;
