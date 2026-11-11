import { captureException } from '../sentry';
import { PsaAdapterError } from '../psa/types';
import type { TicketingContext } from './execution';
export type TicketingErrorId =
  | 'PSA_ALERT_TICKET_CREATE_FAILED'
  | 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN'
  | 'PSA_ALERT_TICKET_CLOSE_FAILED'
  | 'PSA_ALERT_TICKET_AUTH_PAUSED';
export function reportTicketingFailure(ctx: TicketingContext, errorId: TicketingErrorId, error?: unknown) {
  console.error('[psa-ticketing] attention required', {
    errorId, mappingId: ctx.mapping.id, alertId: ctx.mapping.alertId,
    connectionId: ctx.connection.id, lastError: ctx.mapping.lastError,
  });
  // Adapter objects carry bodySnippet. Internal errors retain their stack and cause.
  captureException(error !== undefined && !(error instanceof PsaAdapterError)
    ? error : new Error('PSA alert ticket operation requires attention'), undefined, {
    errorId,
    psa_connection_id: ctx.connection.id,
    psa_provider: ctx.connection.provider,
    ...(ctx.connection.partnerId ? { partner_id: ctx.connection.partnerId } : {}),
  });
}
