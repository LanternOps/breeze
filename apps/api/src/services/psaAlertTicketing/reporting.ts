import { captureException } from '../sentry';
import type { TicketingContext } from './execution';
export function reportTicketingFailure(ctx: TicketingContext, errorId: string) {
  // Never send an adapter error object: its bodySnippet may contain PSA data.
  captureException(new Error('PSA alert ticket operation requires attention'), undefined, {
    errorId,
    psa_connection_id: ctx.connection.id,
    psa_provider: ctx.connection.provider,
    partner_id: ctx.connection.partnerId ?? '',
  });
}
