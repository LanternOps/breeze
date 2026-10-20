import type { BrandingDecision } from './helperBranding';

/**
 * Endpoint Messaging sender identity (Phase 2, Wave 1; narrowed by #9396).
 *
 * The sender name in the Helper's fixed "From" slot and the toast title is
 * always the partner name (`fallback`). Helper branding company/display names
 * brand the Helper UI only: an organization-level config-policy writer must not
 * be able to put an arbitrary name (e.g. "Microsoft Security") into the
 * anti-spoofing slot. Only the accent follows the effective Helper branding
 * primary colour, which is contrast-validated on write. Pure: the caller passes
 * the decision already resolved for the send, so no query is added.
 */
export interface EndpointIdentity {
  companyName: string;
  displayName: string;
  accent: string | null;
}

export function endpointMessageIdentity(decision: BrandingDecision | undefined, fallback: EndpointIdentity): EndpointIdentity {
  if (!decision || decision.state !== 'set') return fallback;
  return {
    companyName: fallback.companyName,
    displayName: fallback.displayName,
    accent: decision.values.primaryColor ?? fallback.accent,
  };
}
