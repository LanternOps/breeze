import { type RouteAuditInput } from './auditEvents';

/**
 * Single source of truth for the `quote.accepted_on_behalf` audit payload.
 *
 * Customer-initiated accepts are audit-less by design — they are anonymous, and
 * the acceptance row IS their record. An MSP-recorded acceptance is the
 * opposite: a named user committed the customer to an invoice, so it gets a
 * first-class audit row naming the evidence.
 *
 * This RETURNS the payload rather than writing it, mirroring
 * quoteSupersedeAudit.ts: the right writer differs by call path. The route uses
 * `writeRouteAudit`, which attributes the acting user from the Hono auth
 * context; writing from here would silently anonymise it. There is one caller
 * today, but the shape being unit-testable without HTTP is the point.
 *
 * `reference` is deliberately included verbatim: it is the whole evidence
 * trail, and an audit row that says an acceptance was recorded without saying
 * what it was recorded against is not worth writing.
 */
export function acceptedOnBehalfAuditEvent(args: {
  quoteId: string;
  orgId: string;
  method: string;
  reference: string;
  signerName: string;
  signerEmail?: string | null;
  invoiceId: string;
  /** Null for a degenerate recurring-only quote, which issues no invoice. */
  invoiceNumber?: string | null;
  contractIds: string[];
  /** True when the quote was a draft the accept claimed inline — i.e. the
   *  customer's first sight of this document will be the invoice. */
  wasDraft: boolean;
}): RouteAuditInput {
  return {
    orgId: args.orgId,
    action: 'quote.accepted_on_behalf',
    resourceType: 'quote',
    resourceId: args.quoteId,
    result: 'success',
    details: {
      method: args.method,
      reference: args.reference,
      signerName: args.signerName,
      signerEmail: args.signerEmail ?? null,
      invoiceId: args.invoiceId,
      invoiceNumber: args.invoiceNumber ?? null,
      contractIds: args.contractIds,
      wasDraft: args.wasDraft,
    },
  };
}
