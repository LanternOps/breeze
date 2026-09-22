import { type RouteAuditInput } from './auditEvents';

/**
 * Single source of truth for the `quote.declined_on_behalf` audit payload
 * (#6634) — the decline twin of quoteAcceptOnBehalfAudit.ts.
 *
 * A customer's own decline (portal / public link) is anonymous and the quote's
 * `declined_at` + `decline_reason` are its record. A decline an MSP user
 * RECORDS for the customer is a named user closing out the customer's quote, so
 * it gets an audit row naming how the decline arrived and the evidence behind
 * it. The quote row itself carries no provenance columns for a decline, so this
 * row is the only place that evidence lives.
 *
 * Returns the payload instead of writing it, for the same reason as the accept
 * builder: the route's `writeRouteAudit` attributes the acting user from the
 * Hono auth context, and writing from here would anonymise it.
 */
export function declinedOnBehalfAuditEvent(args: {
  quoteId: string;
  orgId: string;
  method: string;
  reference: string;
  /** The customer's stated reason, if the tech recorded one. */
  reason?: string | null;
}): RouteAuditInput {
  return {
    orgId: args.orgId,
    action: 'quote.declined_on_behalf',
    resourceType: 'quote',
    resourceId: args.quoteId,
    result: 'success',
    details: {
      method: args.method,
      reference: args.reference,
      reason: args.reason ?? null,
    },
  };
}
