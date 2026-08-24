import { type RouteAuditInput } from './auditEvents';

/**
 * Single source of truth for the `quote.superseded` audit payload.
 *
 * Retiring a quote the customer could previously accept is a separate,
 * independently-auditable act from sending the revision, and `sendQuote` has
 * FOUR callers (direct route, scheduled worker, bulk-send, AI tool). Two of
 * them shipped without this event, so the payload lives here and every caller
 * builds it the same way rather than hand-rolling a fifth copy that drifts.
 *
 * This returns the payload rather than writing it, because the right WRITER
 * differs by call path: request paths use `writeRouteAudit`, which attributes
 * the acting user from the Hono auth context, while the worker and AI-tool
 * paths have no request and must supply their own actor. Writing directly from
 * here would silently anonymise every route-side audit row.
 *
 * `resourceId` is deliberately the PARENT quote — it is the row whose status
 * actually changed.
 */
export function supersededAuditEvent(args: {
  /** The revision that was sent, i.e. the quote doing the superseding. */
  childQuoteId: string;
  orgId: string;
  parentQuoteId: string;
  previousStatus: string;
  revisionNumber: number;
  emailed: boolean;
}): RouteAuditInput {
  return {
    orgId: args.orgId,
    action: 'quote.superseded',
    resourceType: 'quote',
    resourceId: args.parentQuoteId,
    result: 'success',
    details: {
      supersededByQuoteId: args.childQuoteId,
      previousStatus: args.previousStatus,
      revisionNumber: args.revisionNumber,
      emailed: args.emailed,
    },
  };
}
