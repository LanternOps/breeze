import { z } from 'zod';
import { ticketPrioritySchema } from './tickets';

// Ticketing-configuration validators (2026-06-12 spec). Shared between the API
// routes (zValidator) and the web settings forms. The core status / priority
// enums mirror the Postgres ticket_status / ticket_priority enums.

export const coreTicketStatusSchema = z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']);
export type CoreTicketStatusValue = z.infer<typeof coreTicketStatusSchema>;

// ticketPrioritySchema is the canonical ticket_priority enum, already defined in
// ./tickets (imported above) — re-export it rather than redeclaring, since the
// barrel re-exports both files and a duplicate const would collide.
export { ticketPrioritySchema };
export type TicketPriorityValue = z.infer<typeof ticketPrioritySchema>;

// #rrggbb only (6-digit hex). Shorthand / named colors rejected so the DB
// varchar(7) is always canonical.
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a 6-digit hex value (e.g. #1a2b3c)');

// SLA minutes: 0..525600 (one year), integer. Negatives and floats rejected.
// Nullable so a tier can be explicitly cleared back to "inherit".
const slaMinutes = z.number().int().min(0).max(525_600).nullable();

export const createTicketStatusSchema = z.object({
  name: z.string().trim().min(1).max(60),
  coreStatus: coreTicketStatusSchema,
  color: hexColor.nullable().optional(),
  sortOrder: z.number().int().min(0).optional()
});
export type CreateTicketStatusInput = z.infer<typeof createTicketStatusSchema>;

export const updateTicketStatusSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  coreStatus: coreTicketStatusSchema.optional(),   // service rejects for is_system rows
  color: hexColor.nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
export type UpdateTicketStatusInput = z.infer<typeof updateTicketStatusSchema>;

export const reorderTicketStatusesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200)
}).refine((v) => new Set(v.ids).size === v.ids.length, { message: 'ids must be unique', path: ['ids'] });
export type ReorderTicketStatusesInput = z.infer<typeof reorderTicketStatusesSchema>;

export const prioritySettingsSchema = z.object({
  priorities: z.record(ticketPrioritySchema, z.object({
    label: z.string().trim().min(1).max(40).nullable().optional(),
    responseSlaMinutes: slaMinutes.optional(),
    resolutionSlaMinutes: slaMinutes.optional()
  }))
});
export type PrioritySettingsInput = z.infer<typeof prioritySettingsSchema>;

export const orgTicketSettingsSchema = z.object({
  slaOverrides: z.record(ticketPrioritySchema, z.object({
    responseMinutes: slaMinutes.optional(),
    resolutionMinutes: slaMinutes.optional()
  })).optional(),
  defaultHourlyRate: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  defaultBillable: z.boolean().nullable().optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
export type OrgTicketSettingsInput = z.infer<typeof orgTicketSettingsSchema>;
