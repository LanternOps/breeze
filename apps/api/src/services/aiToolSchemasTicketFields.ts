import { ticketTypeSchema } from '@breeze/shared';
import { z } from 'zod';

const uuid = z.string().guid();

/**
 * `manage_tickets` `fields` (the update_fields patch). Its own module so the
 * approval impact line (actionIntents/intentService.ts) reads the real field
 * set without importing aiToolSchemas.ts, which pulls the db schema into
 * intentService's unit suites. toolInputSchemas.manage_tickets uses this
 * object as-is, so the two cannot drift (#12774).
 */
export const manageTicketsFieldsSchema = z.object({
  subject: z.string().min(1).max(255).optional(),
  description: z.string().max(50_000).optional(),
  categoryId: uuid.nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  dueDate: z.string().datetime().nullable().optional(),
  responseSlaMinutes: z.number().int().nonnegative().nullable().optional(),
  resolutionSlaMinutes: z.number().int().nonnegative().nullable().optional(),
  deviceId: uuid.nullable().optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  submittedBy: uuid.nullable().optional(),
  submitterName: z.string().max(255).nullable().optional(),
  submitterEmail: z.string().email().max(255).nullable().optional(),
  ticketType: ticketTypeSchema.optional(),
});
