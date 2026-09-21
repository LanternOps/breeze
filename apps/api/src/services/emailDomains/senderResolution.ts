import {
  MAIL_PURPOSES,
  mailPurposePolicy,
  type MailPurpose,
  type PartnerMailStream,
} from './mailPurposes';
import { getEmailDomainsConfig, isPartnerLaneConfigured } from './config';
import { tryCountPartnerLaneSend } from './sendCap';

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
 * `"Acme MSP" <no-reply@2breeze.app>` in the customer's inbox.
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
 * The From a customer purpose uses when no partner sending identity applies.
 * The display name is the company name. The address stays EMAIL_FROM so
 * SPF/DKIM still match. A blank name keeps the plain platform sender.
 * Staff and security purposes never reach the display-name branch.
 */
export function platformFallbackFrom(
  purpose: MailPurpose,
  defaultFrom: string,
  partnerName?: string | null,
): string {
  const policy = mailPurposePolicy(purpose);
  if (policy.lane !== 'partner' || policy.fallbackFrom !== 'partner_display_name') return defaultFrom;
  const name = partnerName?.trim();
  if (!name) return defaultFrom;
  return fromWithDisplayName(defaultFrom, name);
}

export async function resolveSender(input: ResolveSenderInput): Promise<ResolvedSender> {
  // A purpose outside the registry can only reach here by bypassing
  // TypeScript (G5 is a compile-time guard, erased at runtime). Rather than
  // let mailPurposePolicy's platform fallback happen silently, log it — an
  // unclassified send reaching production is the exact failure mode that
  // guard exists to prevent.
  if (!(input.purpose in MAIL_PURPOSES)) {
    console.warn('[email] unknown mail purpose %s — routed to the platform lane', input.purpose);
  }

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

  // Condition 1 (spec §8.3): the lane must be configured at all. With
  // EMAIL_DOMAINS_PROVIDER unset — the default on hosted and self-hosted — this
  // returns here and the whole feature is inert.
  if (!isPartnerLaneConfigured()) {
    return { lane: 'platform', from, reason: 'lane_unconfigured' };
  }

  // Condition 1 continued: the dark-launch allowlist (§9.1). Empty means every
  // eligible partner; set means only those ids.
  const allowlist = getEmailDomainsConfig().partnerAllowlist;
  if (allowlist.length > 0 && !allowlist.includes(input.partnerId)) {
    return { lane: 'platform', from, reason: 'not_allowlisted' };
  }

  // Conditions 2 and 3: ONE read, plus the side-effect-free trust evaluation.
  // Imported dynamically so a platform purpose never loads the db module at all
  // (plan amendment 1).
  const { lookupPartnerLaneIdentity } = await import('./partnerLaneLookup');
  const identity = await lookupPartnerLaneIdentity(input.partnerId, policy.stream);
  if (!identity.ok) {
    return { lane: 'platform', from, reason: identity.reason };
  }

  // Condition 4, LAST so an ineligible partner never burns a counter slot. A
  // Redis outage also lands here (sendCap.ts): the message still goes out, on
  // the platform lane, and the cap is never silently lifted.
  //
  // DELIBERATE: the slot is consumed HERE, before the send, so a message that
  // then falls back to the platform lane (domain_unusable / lane_unavailable,
  // §8.4) has still spent one. That is the safe direction for an abuse control
  // — a partner with a broken domain cannot exceed the cap by retrying, which
  // is exactly the state in which a runaway loop is most likely. The cost is
  // that the counter slightly over-counts during an outage; the alternative
  // (count on success) would make the cap unbounded precisely when it matters.
  if (!(await tryCountPartnerLaneSend(input.partnerId))) {
    return { lane: 'platform', from, reason: 'over_cap' };
  }

  return {
    lane: 'partner',
    // Same header-safety strip as the platform display name: fromWithDisplayName
    // falls back to the bare address when nothing usable survives, which is
    // exactly the behaviour wanted here.
    from: fromWithDisplayName(
      `${identity.localPart}@${identity.domain}`,
      identity.displayName?.trim() || identity.partnerName,
    ),
    // The DEFAULT Reply-To only. Precedence (the call site's replyTo first) is
    // applied by EmailService.sendEmail, which is the only place that knows
    // what the call site passed (spec §8.3).
    replyTo: identity.replyTo,
    partnerId: input.partnerId,
    domainId: identity.domainId,
    domain: identity.domain,
    stream: policy.stream,
  };
}
