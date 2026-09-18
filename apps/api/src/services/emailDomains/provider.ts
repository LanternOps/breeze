import type { RawEmailMessage } from '../email';
import type { PartnerMailStream } from './mailPurposes';
import { PARTNER_MAIL_STREAMS } from '@breeze/shared';

/**
 * Provider-neutral sending-domain interface (spec §5).
 *
 * Adapters are PURE with respect to Breeze's database: they never read or write
 * a table. They take what they need as arguments and return provider facts.
 * Orchestration — which row moves to which status, when to create versus adopt
 * — belongs to W03's syncSendingDomain.
 */

/** Compile-time parity: @breeze/shared's PARTNER_MAIL_STREAMS must equal W01's union. */
type _StreamParity =
  PartnerMailStream extends (typeof PARTNER_MAIL_STREAMS)[number]
    ? ((typeof PARTNER_MAIL_STREAMS)[number] extends PartnerMailStream ? true : never)
    : never;
const _streamParity: _StreamParity = true;
void _streamParity;

export type SendingDomainStatus =
  | 'provisioning' | 'pending' | 'verified' | 'at_risk'
  | 'failed' | 'suspended' | 'removing';

export interface ProviderDnsRecord {
  purpose: 'dkim' | 'spf' | 'return_path_mx' | 'other';
  type: 'TXT' | 'CNAME' | 'MX';
  host: string;        // as the provider returns it (relative label)
  fqdn: string;        // computed: what must resolve
  value: string;
  priority?: number;
  ttl?: string;
  status: 'pending' | 'verified' | 'failed';
}

export interface ProviderDomain {
  providerDomainId: string | null;   // null for `static`
  region?: string;
  /**
   * Provider-side creation time, when the provider reports one. W03 compares
   * it with the row's committed `provision_attempted_at` to tell "ours from a
   * crashed attempt" from "pre-existing" (§5.1 cases 3 and 4). `undefined` is
   * the AMBIGUOUS case and must resolve to provider_managed = false: leaking a
   * provider domain is recoverable, deleting someone's mail domain is not.
   */
  createdAt?: Date;
  state: 'pending' | 'verified' | 'at_risk' | 'failed';
  records: ProviderDnsRecord[];      // empty for `static`
}

export type PartnerLaneSendError =
  | { kind: 'domain_unusable' }                    // provider says the domain cannot send
  /**
   * 429, account paused, quota, bad credentials. `detail` is the provider's own
   * error code where there is one (`invalid_api_key`, `rate_limit_exceeded`, …)
   * so W04's ops alert can tell a credential failure — someone must rotate a
   * key — from a rate limit that clears itself. Optional: adapters without a
   * code (e.g. `static`) still report the kind.
   */
  | { kind: 'lane_unavailable'; detail?: string }
  | { kind: 'message_rejected'; detail: string }   // bad recipient, too large
  | { kind: 'ambiguous'; detail: string };         // timeout, 5xx, network

/**
 * Plan-index amendment 3: the spec types the error as a union and says `send`
 * "throws" it. A union cannot be thrown usefully, so adapters throw this class
 * and callers read `.error`.
 */
export class PartnerLaneSendFailure extends Error {
  constructor(readonly error: PartnerLaneSendError) {
    super(`partner lane send failed: ${error.kind}`);
    this.name = 'PartnerLaneSendFailure';
  }
}

/** The provider already holds this name (or another team does). → `failed`/`provider_conflict`. */
export class ProviderDomainConflictError extends Error {
  constructor(readonly domain: string, message?: string) {
    super(message ?? `provider already holds ${domain}`);
    this.name = 'ProviderDomainConflictError';
  }
}

/** The provider refused the request outright. → `failed`/`provider_rejected`. */
export class ProviderDomainRejectedError extends Error {
  constructor(readonly domain: string, message?: string) {
    super(message ?? `provider refused ${domain}`);
    this.name = 'ProviderDomainRejectedError';
  }
}

/** W01's raw message shape. The partner lane never builds its own envelope. */
export type PartnerLaneMessage = RawEmailMessage;

export interface CreateProviderDomainInput {
  domain: string;
  region?: string;
  /** The partner id. Resend tags with it; SES will map it to tenant `bz-<id>`. */
  partnerRef: string;
  /**
   * Plan amendment 4: the partner's slug. Only `static` uses it, to honour a
   * `domain:partner-slug` binding in EMAIL_DOMAINS_STATIC_ALLOWED. `resend` and
   * `ses` ignore it.
   */
  partnerSlug?: string | null;
}

export interface EmailDomainProvider {
  readonly id: 'resend' | 'ses' | 'static' | 'fake';
  /** false for `static`: no wizard, no DNS records, no polling for verification. */
  readonly verifiesByDns: boolean;
  createDomain(i: CreateProviderDomainInput): Promise<ProviderDomain>;
  findDomainByName(domain: string): Promise<ProviderDomain | null>;
  /**
   * `static` has no provider object, so its key is the DOMAIN NAME (plan
   * amendment 5). Every other adapter takes its provider domain id.
   *
   * `opts.partnerSlug` is the OWNER re-check, and only `static` reads it: its
   * allow-list entries may be bound (`acme.com:msp-a`), and an operator who
   * re-binds an entry to another partner must revoke the first one. Matching on
   * the domain alone would leave the original partner sending indefinitely.
   * A bound entry whose slug does not match — including when no slug is
   * supplied — reports `failed`, exactly as a delisted domain does.
   * `resend` and `fake` ignore it.
   */
  getDomain(providerDomainIdOrKey: string, opts?: { partnerSlug?: string | null }): Promise<ProviderDomain>;
  requestVerification(providerDomainId: string): Promise<void>;
  /** A 404 from the provider is SUCCESS: the domain is already gone. */
  deleteDomain(providerDomainId: string): Promise<void>;
  /** Drift report only (hosted). `static` returns []. */
  listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>>;
  /**
   * Throws PartnerLaneSendFailure. `tags` always carries partner_id, domain_id,
   * stream and purpose so delivery webhooks can attribute events (§9.3).
   */
  send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }):
    Promise<{ providerMessageId: string }>;
}
