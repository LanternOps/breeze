import { z } from 'zod';

/**
 * Partner sending domains — shared validation (spec 2026-09-17 §4.1, §4.4).
 *
 * This module is the PLATFORM-INDEPENDENT half: trim/lowercase/A-label
 * conversion and the structural rejections, so the web form and the API agree
 * character for character. The policy half — platform-owned domains, consumer
 * mailbox providers, public suffixes, the operator denylist — reads server
 * configuration and lives in
 * apps/api/src/services/emailDomains/domainPolicy.ts.
 */

export const SENDING_DOMAIN_STATUSES = [
  'provisioning', 'pending', 'verified', 'at_risk', 'failed', 'suspended', 'removing'
] as const;
export type SendingDomainStatusValue = (typeof SENDING_DOMAIN_STATUSES)[number];

export const SENDING_DOMAIN_STATUS_REASONS = [
  'provider_conflict', 'provider_rejected', 'quota_exhausted', 'dns_not_detected',
  'dns_removed', 'platform_suspended', 'abuse_auto', 'failed_expired', 'user_removed'
] as const;
export type SendingDomainStatusReason = (typeof SENDING_DOMAIN_STATUS_REASONS)[number];

/**
 * Must stay identical to W01's `PartnerMailStream`
 * (apps/api/src/services/emailDomains/mailPurposes.ts). A compile-time parity
 * assertion lives in apps/api/src/services/emailDomains/provider.ts.
 */
export const PARTNER_MAIL_STREAMS = ['support', 'billing', 'general'] as const;
export type PartnerMailStreamValue = (typeof PARTNER_MAIL_STREAMS)[number];

export type SendingDomainRejection =
  | 'empty' | 'scheme' | 'path' | 'port' | 'at_sign' | 'wildcard' | 'ip_literal'
  | 'too_few_labels' | 'label_length' | 'label_charset' | 'too_long' | 'numeric_tld' | 'idn_invalid';

export type NormalizeSendingDomainResult =
  | { ok: true; domain: string }
  | { ok: false; reason: SendingDomainRejection };

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LDH_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ALL_DIGITS = /^\d+$/;

/**
 * Trim, lowercase, strip trailing dots, reject structurally, then convert IDN
 * to its A-label via the WHATWG URL parser — which applies UTS-46 identically
 * in Node and every browser, so no punycode dependency is needed on either side.
 */
export function normalizeSendingDomain(input: string): NormalizeSendingDomainResult {
  const raw = (input ?? '').trim().toLowerCase();
  if (raw.length === 0) return { ok: false, reason: 'empty' };

  // Structural rejections run BEFORE the URL parse, so each one gets its own
  // reason instead of collapsing into a generic parse failure.
  if (raw.includes('://') || raw.startsWith('//')) return { ok: false, reason: 'scheme' };
  if (raw.includes('/') || raw.includes('?') || raw.includes('#')) return { ok: false, reason: 'path' };
  if (raw.includes('@')) return { ok: false, reason: 'at_sign' };
  if (raw.includes('*')) return { ok: false, reason: 'wildcard' };
  // Covers both `acme.com:587` and an IPv6 literal, which can only appear
  // bracketed and always carries colons.
  if (raw.includes(':')) return { ok: false, reason: 'port' };

  const trimmedDots = raw.replace(/\.+$/, '');
  if (trimmedDots.length === 0) return { ok: false, reason: 'empty' };

  // Node's WHATWG host parser THROWS (rather than returning a hostname) on an
  // embedded space and on a trailing all-numeric label, where it attempts IPv4
  // parsing and fails. Both would otherwise collapse onto `idn_invalid`, which
  // tells the partner nothing actionable — classify them before the parse.
  // IPv4 first, so 192.0.2.10 stays `ip_literal` rather than `numeric_tld`.
  if (IPV4_LITERAL.test(trimmedDots)) return { ok: false, reason: 'ip_literal' };
  const rawLabels = trimmedDots.split('.');
  if (ALL_DIGITS.test(rawLabels[rawLabels.length - 1]!)) return { ok: false, reason: 'numeric_tld' };
  if (/\s/.test(trimmedDots)) return { ok: false, reason: 'label_charset' };

  let hostname: string;
  try {
    hostname = new URL(`http://${trimmedDots}`).hostname;
  } catch {
    return { ok: false, reason: 'idn_invalid' };
  }
  // The URL parser keeps a trailing root dot; strip it again post-parse.
  hostname = hostname.replace(/\.+$/, '');
  if (hostname.length === 0) return { ok: false, reason: 'empty' };
  if (hostname.startsWith('[')) return { ok: false, reason: 'ip_literal' };
  if (IPV4_LITERAL.test(hostname)) return { ok: false, reason: 'ip_literal' };
  if (hostname.length > 253) return { ok: false, reason: 'too_long' };

  const labels = hostname.split('.');
  if (labels.length < 2) return { ok: false, reason: 'too_few_labels' };
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return { ok: false, reason: 'label_length' };
    if (!LDH_LABEL.test(label)) return { ok: false, reason: 'label_charset' };
  }
  if (ALL_DIGITS.test(labels[labels.length - 1]!)) return { ok: false, reason: 'numeric_tld' };

  return { ok: true, domain: hostname };
}

/**
 * Refused because mail to them must reach a human or a bounce processor at the
 * DOMAIN owner, never a Breeze-generated notification stream (RFC 5321 §4.5.1,
 * RFC 2142).
 */
export const RESERVED_SENDER_LOCAL_PARTS = ['postmaster', 'abuse', 'mailer-daemon'] as const;

export const SENDER_LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
export const SENDER_LOCAL_PART_MAX = 64;
export const SENDER_DISPLAY_NAME_MAX = 78;

export const senderLocalPartSchema = z
  .string()
  .max(SENDER_LOCAL_PART_MAX)
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => SENDER_LOCAL_PART_PATTERN.test(v), { message: 'local_part_invalid' })
  .refine((v) => !v.includes('..'), { message: 'local_part_consecutive_dots' })
  .refine((v) => !(RESERVED_SENDER_LOCAL_PARTS as readonly string[]).includes(v), {
    message: 'local_part_reserved'
  });

/**
 * Passes the same header-safety strip `EmailService.fromWithDisplayName`
 * applies (services/email.ts:235), then refuses the "display name that looks
 * like another address" spoof. The `@` / `://` checks run AFTER the strip so
 * `Acme <billing@acme.com>` cannot smuggle an address past by wrapping it in
 * angle brackets.
 */
export const senderDisplayNameSchema = z
  .string()
  .max(SENDER_DISPLAY_NAME_MAX)
  .transform((v) => v.replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim())
  .refine((v) => v.length > 0, { message: 'display_name_empty' })
  .refine((v) => !v.includes('@') && !v.includes('://'), { message: 'display_name_spoof' });

export const createSendingDomainSchema = z
  .object({
    // Generous raw bound; normalizeSendingDomain enforces the real 253 limit
    // after A-label conversion, which can lengthen the string.
    domain: z.string().min(1).max(512)
  })
  .strict()
  .transform((body, ctx) => {
    const normalized = normalizeSendingDomain(body.domain);
    if (!normalized.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domain'], message: normalized.reason });
      return z.NEVER;
    }
    return { domain: normalized.domain };
  });

export const upsertSenderIdentitySchema = z
  .object({
    sendingDomainId: z.string().uuid(),
    localPart: senderLocalPartSchema,
    displayName: senderDisplayNameSchema.nullish(),
    replyTo: z.string().email().max(320).nullish()
  })
  // `stream` is a path parameter (PUT /identities/:stream), never a body field.
  .strict();
