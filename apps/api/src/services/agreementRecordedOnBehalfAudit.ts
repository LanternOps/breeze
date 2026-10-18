import { type RouteAuditInput } from './auditEvents';

/**
 * Single source of truth for the `billing.agreement.recorded_on_behalf` audit
 * payload (#8865 W1c, spec §3.4) — the agreement counterpart of
 * quoteAcceptOnBehalfAudit.ts.
 *
 * A named MSP user filed a signed agreement for a client that signed elsewhere
 * (DocuSign, wet ink, email), so it gets a first-class audit row naming the
 * evidence. RETURNS the payload rather than writing it: the route writes it
 * with `writeRouteAudit`, which attributes the acting user from the Hono auth
 * context.
 *
 * `reference` is included verbatim — it is the whole evidence trail.
 */
export function recordedOnBehalfAuditEvent(args: {
  requestId: string;
  orgId: string;
  signedAgreementId: string;
  method: string;
  reference: string;
  signerName: string;
  signerEmail?: string | null;
  templateVersionId: string;
  contractId?: string | null;
  contentSha256: string;
  /** True when an externally signed copy (PDF/PNG/JPEG) was uploaded rather
   *  than Breeze rendering the template. */
  external: boolean;
}): RouteAuditInput {
  return {
    orgId: args.orgId,
    action: 'billing.agreement.recorded_on_behalf',
    resourceType: 'agreement_request',
    resourceId: args.requestId,
    result: 'success',
    details: {
      signedAgreementId: args.signedAgreementId,
      method: args.method,
      reference: args.reference,
      signerName: args.signerName,
      signerEmail: args.signerEmail ?? null,
      templateVersionId: args.templateVersionId,
      contractId: args.contractId ?? null,
      contentSha256: args.contentSha256,
      external: args.external,
    },
  };
}
