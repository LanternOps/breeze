import { getEmailService } from '../../email';
import { findStaticAllowedEntry, getEmailDomainsConfig } from '../config';
import {
  PartnerLaneSendFailure,
  ProviderDomainRejectedError,
  type CreateProviderDomainInput,
  type EmailDomainProvider,
  type PartnerLaneMessage,
  type PartnerLaneSendError,
  type ProviderDomain
} from '../provider';

/**
 * Self-hosted-only "operator attestation" adapter (spec §5.1, D7). Refused when
 * isHosted() by config/validate.ts.
 *
 * It makes NO external calls. The operator lists in EMAIL_DOMAINS_STATIC_ALLOWED
 * the domains this instance's mail relay may send as; Breeze cannot check that
 * the relay signs for them — SPF and DKIM are the operator's mail setup — so
 * there is no DNS wizard and nothing to poll. A row becomes `verified` only
 * when the relay ACCEPTS a test send (W03's `test-send` job), which catches the
 * common failure (the relay refusing the sender) at setup instead of on a
 * customer's invoice.
 *
 * CONTRACT FOR W03: verifiesByDns === false, so this adapter never returns
 * `verified`. `pending` means "still listed — no change", `failed` means the
 * operator delisted it (spec §13). A verified row must stay verified when this
 * adapter reports `pending`.
 */

const NOT_ALLOWED_MESSAGE =
  'This domain is not allowed on this server. Ask your Breeze administrator to add it to EMAIL_DOMAINS_STATIC_ALLOWED.';

/** Sender-refusal signatures. The relay is telling us it will not send AS this domain. */
const SENDER_REFUSAL_MARKERS = [
  '5.7.60',
  'send as this sender',
  'not allowed to send as',
  'sender address rejected',
  'sender not allowed',
  'sender refused',
  'not owned by user',
  'domain is not verified',
  'domain not verified',
  'not a verified domain',
  'unverified domain',
  'domain not found',
  'verify a domain',
  'verify your domain'
];

/** Recipient-side refusals: the message, not the sending domain, is the problem. */
const RECIPIENT_REFUSAL_MARKERS = [
  'user unknown',
  'no such user',
  'does not exist',
  'mailbox unavailable',
  'recipient address rejected',
  'invalid recipient',
  'unrouteable address',
  'is not a valid address',
  'not a valid address'
];

const MESSAGE_REFUSAL_MARKERS = [
  'message size exceeds',
  'message too large',
  'size limit exceeded',
  'rejected as spam',
  'content rejected'
];

function includesAny(haystack: string, markers: readonly string[]): boolean {
  return markers.some((marker) => haystack.includes(marker));
}

/**
 * Classify a failure thrown by the PLATFORM transport (EmailService.deliverRaw).
 *
 * Structure available per transport (plan amendment 7): SMTP errors arrive raw
 * from nodemailer with `responseCode` (a number, or `false` when it could not be
 * parsed) and `response`; Resend and Mailgun failures arrive as a plain Error
 * whose message embeds the provider text.
 *
 * ORDER IS LOAD-BEARING. Sender-refusal text wins over everything, because that
 * is the case that must fall back to EMAIL_FROM rather than throw. Then explicit
 * recipient/message refusals. Only then the bare SMTP code, where 550/551/553
 * default to domain_unusable per spec §5.1 — a harmless extra platform-lane
 * send if we are wrong, versus a lost message if we call a domain refusal
 * `message_rejected`.
 */
export function classifyPlatformTransportError(err: unknown): PartnerLaneSendError {
  const error = err as { responseCode?: unknown; response?: unknown; message?: unknown } | null;
  const message = err instanceof Error ? err.message : String(err ?? '');
  const response = typeof error?.response === 'string' ? error.response : '';
  const haystack = `${message} ${response}`.toLowerCase();

  if (includesAny(haystack, SENDER_REFUSAL_MARKERS)) return { kind: 'domain_unusable' };
  if (includesAny(haystack, RECIPIENT_REFUSAL_MARKERS)) return { kind: 'message_rejected', detail: message };
  if (includesAny(haystack, MESSAGE_REFUSAL_MARKERS)) return { kind: 'message_rejected', detail: message };

  // nodemailer sets responseCode to `false` when the reply had no leading
  // digits, so a truthiness check would be wrong here.
  const code = typeof error?.responseCode === 'number' ? error.responseCode : null;
  if (code !== null) {
    if (code === 550 || code === 551 || code === 553) return { kind: 'domain_unusable' };
    if (code === 552 || code === 554) return { kind: 'message_rejected', detail: message };
    return { kind: 'ambiguous', detail: message };
  }

  return { kind: 'ambiguous', detail: message };
}

const LISTED: ProviderDomain = { providerDomainId: null, state: 'pending', records: [] };
const DELISTED: ProviderDomain = { providerDomainId: null, state: 'failed', records: [] };

/**
 * Whether the operator still lists this NAME, re-read on every call because the
 * operator may edit the list and restart.
 *
 * The partner binding is re-checked here, not only at create. An operator who
 * edits `acme.com:msp-a` to `acme.com:msp-b` is re-assigning the domain, and
 * matching on the name alone would leave msp-a sending as it indefinitely. A
 * bound entry therefore matches only its own slug, and fails CLOSED when the
 * caller supplies none — ownership that cannot be proven is not ownership.
 * An UNBOUND entry still matches any partner (the single-partner install).
 */
function isStillListed(domain: string, partnerSlug?: string | null): boolean {
  const target = domain.trim().toLowerCase().replace(/\.+$/, '');
  const slug = typeof partnerSlug === 'string' ? partnerSlug.trim().toLowerCase() : null;
  return getEmailDomainsConfig().staticAllowed.some((entry) => {
    if (entry.domain !== target) return false;
    if (entry.partnerSlug === null) return true;
    return slug !== null && entry.partnerSlug === slug;
  });
}

export function createStaticDomainProvider(): EmailDomainProvider {
  return {
    id: 'static',
    verifiesByDns: false,

    async createDomain(input: CreateProviderDomainInput): Promise<ProviderDomain> {
      const entry = findStaticAllowedEntry(input.domain, input.partnerSlug ?? null);
      if (!entry) throw new ProviderDomainRejectedError(input.domain, NOT_ALLOWED_MESSAGE);
      return { ...LISTED };
    },

    // The key here is the DOMAIN NAME: `static` never has a provider domain id
    // (plan amendment 5, spec §3.1).
    async findDomainByName(domain: string): Promise<ProviderDomain | null> {
      return isStillListed(domain) ? { ...LISTED } : null;
    },

    async getDomain(domainName: string, opts?: { partnerSlug?: string | null }): Promise<ProviderDomain> {
      return isStillListed(domainName, opts?.partnerSlug) ? { ...LISTED } : { ...DELISTED };
    },

    async requestVerification(): Promise<void> {
      // No DNS to check. W03 must not call this (verifiesByDns === false); a
      // no-op rather than a throw so a future caller cannot break a sweep.
    },

    async deleteDomain(): Promise<void> {
      // Breeze must never change the operator's relay configuration.
    },

    async listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>> {
      // The drift report is hosted-only (§6.4) and `static` is self-hosted-only.
      return [];
    },

    async send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }) {
      const service = getEmailService();
      if (!service) {
        // No platform transport configured at all: the lane cannot carry this
        // message, and neither can the fallback. lane_unavailable is honest.
        throw new PartnerLaneSendFailure({ kind: 'lane_unavailable' });
      }
      // Strip the provider-only fields: deliverRaw takes a RawEmailMessage.
      const { partnerRef: _partnerRef, tags: _tags, ...raw } = m;
      void _partnerRef;
      void _tags;
      try {
        await service.deliverRaw(raw);
      } catch (err) {
        throw new PartnerLaneSendFailure(classifyPlatformTransportError(err));
      }
      // The platform transports do not all surface a provider message id, and
      // deliverRaw returns void, so the partner lane synthesises one. W06 has no
      // webhook events for `static` anyway.
      return { providerMessageId: `static:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}` };
    }
  };
}
