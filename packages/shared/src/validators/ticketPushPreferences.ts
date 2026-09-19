import { z } from 'zod';

/**
 * Per-user mobile push preferences for ticket events (W07, #3901).
 * Stored in `ticket_push_preferences` (Shape 6, user-scoped). A missing row
 * means "defaults" — resolveTicketPushPrefs is the single place that says so,
 * for API and app alike (spec D13).
 */
export const ticketSlaPushScopeSchema = z.enum(['off', 'owned', 'any']);
export type TicketSlaPushScope = z.infer<typeof ticketSlaPushScopeSchema>;

export const ticketPushPreferencesSchema = z.object({
  assignedEnabled: z.boolean(),
  slaScope: ticketSlaPushScopeSchema,
});
export type TicketPushPreferences = z.infer<typeof ticketPushPreferencesSchema>;

export const updateTicketPushPreferencesSchema = ticketPushPreferencesSchema
  .partial()
  .strict()
  .refine((v) => v.assignedEnabled !== undefined || v.slaScope !== undefined, {
    message: 'No settings provided',
  });
export type UpdateTicketPushPreferences = z.infer<typeof updateTicketPushPreferencesSchema>;

export const TICKET_PUSH_PREFERENCE_DEFAULTS: TicketPushPreferences = Object.freeze({
  assignedEnabled: true,
  slaScope: 'owned',
}) as TicketPushPreferences;

/** Total: any input (including garbage scopes) resolves to a valid preference set. */
export function resolveTicketPushPrefs(
  row: Partial<TicketPushPreferences> | null | undefined
): TicketPushPreferences {
  const scopeParsed = ticketSlaPushScopeSchema.safeParse(row?.slaScope);
  return {
    assignedEnabled:
      typeof row?.assignedEnabled === 'boolean'
        ? row.assignedEnabled
        : TICKET_PUSH_PREFERENCE_DEFAULTS.assignedEnabled,
    slaScope: scopeParsed.success ? scopeParsed.data : TICKET_PUSH_PREFERENCE_DEFAULTS.slaScope,
  };
}
