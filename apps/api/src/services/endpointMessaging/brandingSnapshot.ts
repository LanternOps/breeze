import { resolvePromptIdentity } from '../promptIdentity';

/**
 * The sender identity stamped on an endpoint message at SEND time (#8741).
 *
 * Mirrors services/callerVerification/helperBranding.ts: the org is read under
 * the request's own RLS context, and only the partner id that org resolves to
 * enters the partner-axis read - no client-supplied partner id is accepted.
 * The sender name is the partner name (company and display name alike), with
 * the partner's document primary colour as the default accent. Helper runtime
 * branding (#9271) may replace only the accent at send time
 * (helperBrandingEndpointIdentity.ts); its company/display names never reach
 * the sender, so an organization-level policy writer cannot choose who a
 * message appears to come from (#9396). The helper renders the name in a fixed
 * sender slot that message text can never replace.
 *
 * Since #10190 (OD-2 (a)) this is a view of resolvePromptIdentity, the one
 * MSP-identity resolver: the name is the sanitized partner name (never an org
 * value), the accent the partner's Branding colour with the org's
 * portal_branding colour winning where one is set.
 *
 * Returns null when no partner or no usable name resolves: the caller fails
 * closed rather than showing a card with an unattributed or spoofable sender.
 */
export interface MessageBranding {
  companyName: string;
  displayName: string;
  accent: string | null;
}

export async function resolveMessageBranding(
  orgId: string,
): Promise<{ partnerId: string; branding: MessageBranding } | null> {
  const identity = await resolvePromptIdentity(orgId);
  if (!identity?.partnerName) return null;
  return {
    partnerId: identity.partnerId,
    branding: {
      companyName: identity.partnerName,
      displayName: identity.partnerName,
      accent: identity.primaryColor ?? null,
    },
  };
}
