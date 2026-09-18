import type {
  PartnerMailStreamValue,
  SendingDomainStatusReason,
  SendingDomainStatusValue
} from '../validators/sendingDomains';

/** Provider identifiers a row can carry (spec §3.1 CHECK). */
export type SendingDomainProviderId = 'resend' | 'ses' | 'static' | 'fake';

/**
 * One normalised DNS record the partner must publish. `host` is the label as
 * the provider returns it; `fqdn` is what must actually resolve, computed by
 * the adapter so the UI never has to concatenate.
 */
export interface SendingDomainDnsRecordDto {
  purpose: 'dkim' | 'spf' | 'return_path_mx' | 'other';
  type: 'TXT' | 'CNAME' | 'MX';
  host: string;
  fqdn: string;
  value: string;
  priority?: number;
  ttl?: string;
  status: 'pending' | 'verified' | 'failed';
}

/** A `partner_sending_domains` row as the API renders it. Timestamps are ISO-8601. */
export interface SendingDomainDto {
  id: string;
  domain: string;
  provider: SendingDomainProviderId;
  status: SendingDomainStatusValue;
  statusReason: SendingDomainStatusReason | null;
  /**
   * When `status` last changed. REQUIRED, never null — the column is
   * `NOT NULL DEFAULT now()`. W05 needs it to compute the 72 h retry window on
   * a `failed` row (spec §4.3, §10), which no other field carries.
   */
  statusChangedAt: string;
  dnsRecords: SendingDomainDnsRecordDto[];
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastTestAt: string | null;
  lastTestStatus: 'pending' | 'sent' | 'failed' | null;
  lastTestError: string | null;
  lastSendError: string | null;
  lastSendErrorAt: string | null;
  /**
   * false when the provider domain pre-existed Breeze asking for it. The UI
   * says so on the remove confirmation: removing such a row drops the local row
   * only and never touches the operator's provider account.
   */
  providerManaged: boolean;
  createdAt: string;
}

/** A `partner_sender_identities` row, joined to its domain. */
export interface SenderIdentityDto {
  id: string;
  stream: PartnerMailStreamValue;
  sendingDomainId: string;
  domain: string;
  localPart: string;
  displayName: string | null;
  replyTo: string | null;
  /** Computed `localPart@domain` — the exact From this stream will send with. */
  fromAddress: string;
  updatedAt: string;
}

/**
 * What the settings tab needs before it renders anything.
 * `supported: false` hides the tab; `eligible: false` locks it with `reason`.
 */
export interface SendingDomainsCapabilityDto {
  supported: boolean;
  provider: SendingDomainProviderId | null;
  /** false for `static`: no DNS wizard, no "Check now", no polling. */
  verifiesByDns: boolean;
  eligible: boolean;
  reason?: string;
  maxDomains: number;
}

export interface SendingDomainsListResponse {
  capability: SendingDomainsCapabilityDto;
  domains: SendingDomainDto[];
  identities: SenderIdentityDto[];
}
