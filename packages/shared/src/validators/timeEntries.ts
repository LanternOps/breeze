import { z } from 'zod';
import { optionalQueryBoolean } from './queryParams';

export const billingStatusSchema = z.enum(['not_billed', 'billed', 'no_charge', 'contract']);
export type BillingStatus = z.infer<typeof billingStatusSchema>;

const CLOCK_SKEW_MS = 5 * 60_000;
const notFarFuture = (d: Date) => d.getTime() <= Date.now() + CLOCK_SKEW_MS;

// Currency is never accepted from the client on entries or parts: the server
// stamps `currency_code` once (ticket org currency at creation / first attach,
// partner currency when a standalone entry first carries a rate) and never
// restamps it (multi-currency spec §7). Editing hourlyRate/unitPrice does not
// change the snapshot; billed rows reject monetary edits (ENTRY_BILLED / PART_BILLED).
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
  running: optionalQueryBoolean,
  billingStatus: billingStatusSchema.optional(),
  approved: optionalQueryBoolean,
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

// No currency field by design — see the note above createTimeEntrySchema.
export const ticketPartSchema = z.object({
  description: z.string().min(1).max(2_000),
  partNumber: z.string().max(100).optional(),
  vendor: z.string().max(100).optional(),
  // Optional link to a catalog item the part was added from (#1368). Null
  // detaches it; description/price stay free-text and editable after picking.
  catalogItemId: z.string().uuid().nullable().optional(),
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

// ── W06 (#3900): provenance vocabulary + suggestion routes ──────────────────
// `source` is READ-side only in this wave. It is never accepted on any
// create/update schema: provenance is stamped by the server (spec D5).
export const TIME_ENTRY_SOURCES = ['manual', 'timer', 'location', 'remote_session', 'support_session'] as const;
export const timeEntrySourceSchema = z.enum(TIME_ENTRY_SOURCES);
export type TimeEntrySource = z.infer<typeof timeEntrySourceSchema>;

export const timeSuggestionSignalSchema = z.object({
  kind: z.literal('remote_session'),
  id: z.string().guid()
}).strict();
export type SuggestionSignal = z.infer<typeof timeSuggestionSignalSchema>;

const signalsField = z.array(timeSuggestionSignalSchema).min(1).max(20)
  .refine((s) => new Set(s.map((x) => `${x.kind}:${x.id}`)).size === s.length, { message: 'signals must be unique' });

/**
 * `.strict()` is deliberate (a typo'd param must 400, never silently widen the
 * day). Web callers therefore MUST pass `skipOrgIdInjection` to `fetchWithAuth`
 * — it appends `?orgId=<uuid>` to every request otherwise, which this schema
 * rejects. Suggestions are user-scoped, never org-scoped, so there is no
 * `orgId` to honour.
 */
export const suggestionsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  // IANA zone; validated with Intl in the service (400 INVALID_TZ) so the
  // shared package stays runtime-agnostic.
  tz: z.string().min(1).max(64).optional(),
  userId: z.string().guid().optional()
}).strict();

export const confirmSuggestionSchema = z.object({
  signals: signalsField,
  ticketId: z.string().guid().nullable().optional(),
  startedAt: z.coerce.date(),
  // Optional: the server fills the signal envelope end. Mandatory when any
  // member signal is 'unreliable' (400 ENDED_AT_REQUIRED).
  endedAt: z.coerce.date().optional(),
  description: z.string().max(10_000).optional(),
  isBillable: z.boolean().optional(),
  hourlyRate: z.number().nonnegative().multipleOf(0.01).nullable().optional()
}).strict().refine((v) => v.endedAt === undefined || v.endedAt.getTime() > v.startedAt.getTime(), {
  message: 'endedAt must be after startedAt',
  path: ['endedAt']
});
export type ConfirmSuggestionInput = z.infer<typeof confirmSuggestionSchema>;

export const suggestionSignalsSchema = z.object({ signals: signalsField }).strict();
export type SuggestionSignalsInput = z.infer<typeof suggestionSignalsSchema>;
