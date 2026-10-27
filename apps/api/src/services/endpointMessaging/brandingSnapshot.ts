import { DEFAULT_PROMPT_LOCALE, renderPromptMessage } from '@breeze/shared/promptCatalog';
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
 * Returns null when no partner resolves (no org, no partner id, or the partner
 * row is not visible): the caller fails closed rather than showing a card with
 * an unattributed sender.
 *
 * A partner that exists but whose name sanitizes to nothing (#10190 W04,
 * decision 2) sends under the generic identity, catalog `common/identity.generic`,
 * instead of failing closed. It is rendered in `en`: like the partner name,
 * the snapshot is stamped once at send time for every device in the org, not
 * per device locale. The fallback is logged with ids and a reason code only,
 * never the partner's name, and the result says `senderIdentity: 'generic'`
 * so the send's audit row can record it.
 */
export interface MessageBranding {
  companyName: string;
  displayName: string;
  accent: string | null;
}

/** Whose name the sender slot carries: the partner's, or the catalog's generic name. */
export type MessageSenderIdentity = 'partner' | 'generic';

/** Audit/log reason code for the generic sender. */
export const GENERIC_SENDER_REASON = 'partner_name_sanitized_empty' as const;

export interface ResolvedMessageBranding {
  partnerId: string;
  senderIdentity: MessageSenderIdentity;
  branding: MessageBranding;
}

export async function resolveMessageBranding(orgId: string): Promise<ResolvedMessageBranding | null> {
  const identity = await resolvePromptIdentity(orgId);
  if (!identity) return null;
  const accent = identity.primaryColor ?? null;
  if (identity.partnerNameStatus === 'sanitized_empty') {
    console.warn('[endpoint-messages] partner name sanitized to empty; sender uses the generic identity', {
      reason: GENERIC_SENDER_REASON,
      partnerId: identity.partnerId,
      orgId: identity.orgId,
    });
    const generic = renderPromptMessage('common', 'identity.generic', DEFAULT_PROMPT_LOCALE);
    return {
      partnerId: identity.partnerId,
      senderIdentity: 'generic',
      branding: { companyName: generic, displayName: generic, accent },
    };
  }
  return {
    partnerId: identity.partnerId,
    senderIdentity: 'partner',
    branding: {
      companyName: identity.partnerName,
      displayName: identity.partnerName,
      accent,
    },
  };
}
