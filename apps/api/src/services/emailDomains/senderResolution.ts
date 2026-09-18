import {
  mailPurposePolicy,
  type MailPurpose,
  type PartnerMailStream,
} from './mailPurposes';

/**
 * Sender resolution (partner sending domains, spec §8.3).
 *
 * In W01 this ALWAYS returns the platform lane and performs NO database
 * access. W04 adds the partner branch — a single indexed read joining
 * partners, partner_sender_identities and partner_sending_domains — between
 * the `no_partner` guard and the `lane_unconfigured` return below. The types
 * are already the final ones so no later wave has to change them.
 *
 * This module must stay pure: EmailService passes its configured EMAIL_FROM
 * in as `defaultFrom` rather than being imported, which keeps the dependency
 * one-way (email.ts -> senderResolution.ts) and makes every case unit-testable
 * without a transport.
 */

export type PlatformLaneReason =
  // W01
  | 'platform_purpose'
  | 'no_partner'
  | 'lane_unconfigured'
  // W04
  | 'not_allowlisted'
  | 'partner_ineligible'
  | 'no_identity'
  | 'domain_not_sendable'
  | 'over_cap';

export type ResolvedSender =
  | { lane: 'platform'; from: string; reason: PlatformLaneReason }
  | {
      lane: 'partner';
      from: string;
      replyTo: string | null;
      partnerId: string;
      domainId: string;
      domain: string;
      stream: PartnerMailStream;
    };

export interface ResolveSenderInput {
  purpose: MailPurpose;
  partnerId: string | null;
  /** Only read for a `partner_display_name` fallback. Never a database read. */
  partnerName?: string | null;
  /** EmailService's configured EMAIL_FROM (already provider-resolved). */
  defaultFrom: string;
}

/**
 * The default sender with a custom display name — keeps the envelope address
 * (so SPF/DKIM alignment is untouched) while showing e.g.
 * `"Acme MSP via Breeze" <no-reply@2breeze.app>` in the customer's inbox.
 * The display name is stripped of header-breaking characters; falls back to
 * the plain default sender when nothing usable survives.
 *
 * Moved verbatim from `EmailService.fromWithDisplayName` (services/email.ts).
 */
export function fromWithDisplayName(defaultFrom: string, displayName: string): string {
  const match = defaultFrom.match(/<([^<>\s]+@[^<>\s]+)>/);
  const address = (match?.[1] ?? defaultFrom).trim();
  const safe = displayName.replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!safe || !address.includes('@')) return defaultFrom;
  return `"${safe}" <${address}>`;
}

/**
 * The From a purpose uses when no partner identity applies — i.e. exactly what
 * that send site produced BEFORE this feature. This is what makes W01
 * byte-identical, and it matters most on self-hosted: an operator whose
 * EMAIL_FROM is already `"Acme Support" <support@acme.com>` must not see
 * ticket mail relabelled "Acme MSP via Breeze" by an upgrade (spec §8.3).
 *
 * The falsy-name check is deliberately NOT a trim: the old call sites read
 * `partnerName ? fromWithDisplayName(...) : undefined`, so an all-whitespace
 * name produced a branded From and must keep doing so.
 */
export function platformFallbackFrom(
  purpose: MailPurpose,
  defaultFrom: string,
  partnerName?: string | null,
): string {
  const policy = mailPurposePolicy(purpose);
  if (policy.lane !== 'partner' || policy.fallbackFrom !== 'partner_display_name') return defaultFrom;
  if (!partnerName) return defaultFrom;
  return fromWithDisplayName(defaultFrom, `${partnerName} via Breeze`);
}

export async function resolveSender(input: ResolveSenderInput): Promise<ResolvedSender> {
  const from = platformFallbackFrom(input.purpose, input.defaultFrom, input.partnerName);
  const policy = mailPurposePolicy(input.purpose);

  // Property 1 (spec §8.1): a platform purpose returns before any database
  // read and can never produce a partner-lane result, whatever partnerId the
  // caller passes. G4 depends on it — a partner's sending reputation must not
  // be able to stop a password reset.
  if (policy.lane === 'platform') {
    return { lane: 'platform', from, reason: 'platform_purpose' };
  }

  // A call site that cannot always resolve a partner passes null (spec §8.1).
  if (!input.partnerId) {
    return { lane: 'platform', from, reason: 'no_partner' };
  }

  // W04 inserts the partner branch here. Until then the partner lane does not
  // exist, so every customer-facing purpose falls back to today's sender.
  return { lane: 'platform', from, reason: 'lane_unconfigured' };
}
