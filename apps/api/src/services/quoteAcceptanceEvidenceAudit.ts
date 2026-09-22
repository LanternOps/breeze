import { type RouteAuditInput } from './auditEvents';

/**
 * Single source of truth for the `quote.acceptance_evidence_attached` audit
 * payload (#6633) — sibling of quoteAcceptOnBehalfAudit.ts.
 *
 * Attaching (or replacing) the evidence file on an on-behalf acceptance is a
 * named user adding to the dispute record, so it gets its own audit row. The
 * content digest is included so a reviewer can tell whether the file served
 * today is the one attached then; `replaced` is explicit because a replacement
 * destroys the previous file and this row is then the only trace of it.
 *
 * RETURNS the payload rather than writing it: the route's `writeRouteAudit`
 * attributes the acting user from the Hono auth context.
 */
export function acceptanceEvidenceAttachedAuditEvent(args: {
  quoteId: string;
  orgId: string;
  acceptanceId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  replaced: boolean;
}): RouteAuditInput {
  return {
    orgId: args.orgId,
    action: 'quote.acceptance_evidence_attached',
    resourceType: 'quote',
    resourceId: args.quoteId,
    result: 'success',
    details: {
      acceptanceId: args.acceptanceId,
      filename: args.filename,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      sha256: args.sha256,
      replaced: args.replaced,
    },
  };
}
