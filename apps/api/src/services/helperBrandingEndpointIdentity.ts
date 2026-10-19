import type { BrandingDecision } from './helperBranding';

/**
 * Endpoint Messaging sender identity (Phase 2, Wave 1).
 *
 * When the device's effective Helper branding is set, its company/display name
 * and primary colour replace the partner fallback field by field. Absent fields
 * and a cleared decision keep today's partner-name fallback. Pure: the caller
 * passes the decision already resolved for the send, so no query is added.
 */
export interface EndpointIdentity {
  companyName: string;
  displayName: string;
  accent: string | null;
}

export function endpointMessageIdentity(decision: BrandingDecision | undefined, fallback: EndpointIdentity): EndpointIdentity {
  if (!decision || decision.state !== 'set') return fallback;
  const v = decision.values;
  return {
    companyName: v.companyName ?? fallback.companyName,
    displayName: v.displayName ?? fallback.displayName,
    accent: v.primaryColor ?? fallback.accent,
  };
}
