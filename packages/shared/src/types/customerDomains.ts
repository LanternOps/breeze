/**
 * Customer email domains and their ownership verification (portal registration
 * W5, #11382; spec §5.4). Shared by the API (`services/portalDomainVerification`)
 * and the web Organization › Domains tab.
 *
 * A row is "declared" (mail routing only) until a live check by one of the three
 * methods passes. Only a live `pass` writes `verifiedAt` (inv. 2).
 */

export const DOMAIN_VERIFICATION_METHODS = ['dns_txt', 'entra_tenant', 'google_directory'] as const;
export type DomainVerificationMethod = (typeof DOMAIN_VERIFICATION_METHODS)[number];

/** A definitive "no": counts toward clearing a verified row (plan D10). */
export type DomainCheckFailReason = 'record_missing' | 'not_in_directory' | 'tenant_not_proven' | 'connection_missing';

/** A transient "could not tell": never counts as a failure (plan D10). */
export type DomainCheckUnavailableReason =
  | 'dns_error'
  | 'timeout'
  | 'graph_unavailable'
  | 'graph_tenant_mismatch'
  | 'google_scope_missing'
  | 'google_access_denied'
  | 'google_unavailable';

export type DomainVerificationClearedReason =
  | DomainCheckFailReason
  | 'stale'
  | 'repointed'
  | 'msp_removed'
  | 'displaced';

export type DomainCheckStatus = 'pass' | 'fail' | 'unavailable';

export type CustomerDomainState = 'declared' | 'pending_dns' | 'verified';

export interface CustomerDomainDnsRecord {
  recordName: string;
  recordValue: string;
}

/**
 * The only shape any API surface returns for a customer domain row. It never
 * carries `verification_token` as such (only the published record value while
 * DNS verification is in progress) or `verified_evidence`.
 */
export interface CustomerDomainView {
  id: string;
  orgId: string;
  domain: string;
  isActive: boolean;
  autoCreateContact: boolean;
  state: CustomerDomainState;
  method: DomainVerificationMethod | null;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastPassedAt: string | null;
  lastCheckStatus: DomainCheckStatus | null;
  clearedAt: string | null;
  clearedReason: DomainVerificationClearedReason | null;
  /** Set while a DNS token exists (the record the customer must publish). */
  dnsRecord: CustomerDomainDnsRecord | null;
  /** Verified, active and the method's evidence is still current (plan D6). */
  usableForSignIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export type DomainVerificationErrorCode =
  | 'CUSTOMER_DOMAIN_NOT_FOUND'
  | 'DOMAIN_VERIFIED_ELSEWHERE'
  | 'DOMAIN_VERIFICATION_CONFLICT_RETRY'
  | 'DOMAIN_INACTIVE'
  | 'DOMAIN_DNS_NOT_STARTED'
  | 'DOMAIN_ALREADY_VERIFIED';

export type VerifyCustomerDomainOutcome =
  | { result: 'verified'; method: DomainVerificationMethod; displacedOrgId: string | null }
  | { result: 'failed'; reason: DomainCheckFailReason }
  | { result: 'unavailable'; reason: DomainCheckUnavailableReason };
