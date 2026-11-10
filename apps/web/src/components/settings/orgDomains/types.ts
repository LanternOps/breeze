/**
 * Organization › Domains (portal registration W5, #11382): web-side shapes of
 * the org-scoped customer-domain routes (`/orgs/organizations/:id/customer-domains`).
 *
 * These mirror the W05a API contract in the W5 plan
 * (`docs/superpowers/plans/portal/2026-11-11-portal-registration-options-w05-domain-verification.md`,
 * Tasks 5 and 7: `CustomerDomainView`, `VerifyCustomerDomainOutcome`,
 * `DomainVerificationErrorCode`). Once W05a's `packages/shared/src/types/customerDomains.ts`
 * is on main, the type declarations below become re-exports from `@breeze/shared`;
 * the shape guards and URL helpers stay here.
 */

export type DomainVerificationMethod = 'dns_txt' | 'entra_tenant' | 'google_directory';
export const DOMAIN_VERIFICATION_METHODS: readonly DomainVerificationMethod[] = ['dns_txt', 'entra_tenant', 'google_directory'];

export type DomainCheckFailReason = 'record_missing' | 'not_in_directory' | 'tenant_not_proven' | 'connection_missing';
export type DomainCheckUnavailableReason = 'dns_error' | 'timeout' | 'graph_unavailable' | 'graph_tenant_mismatch'
  | 'google_scope_missing' | 'google_access_denied' | 'google_unavailable';
export type DomainVerificationClearedReason = DomainCheckFailReason | 'stale' | 'repointed' | 'msp_removed' | 'displaced';

export type CustomerDomainState = 'declared' | 'pending_dns' | 'verified';

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
  lastCheckStatus: 'pass' | 'fail' | 'unavailable' | null;
  clearedAt: string | null;
  clearedReason: DomainVerificationClearedReason | null;
  /** Set while a DNS token exists. */
  dnsRecord: { recordName: string; recordValue: string } | null;
  /** The read API's "current" check (plan D6): verified, active and its evidence still holds. */
  usableForSignIn: boolean;
}

export type VerifyCustomerDomainOutcome =
  | { result: 'verified'; method: DomainVerificationMethod; displacedOrgId: string | null }
  | { result: 'failed'; reason: DomainCheckFailReason }
  | { result: 'unavailable'; reason: DomainCheckUnavailableReason };

export type DomainVerificationErrorCode = 'CUSTOMER_DOMAIN_NOT_FOUND' | 'DOMAIN_VERIFIED_ELSEWHERE'
  | 'DOMAIN_VERIFICATION_CONFLICT_RETRY' | 'DOMAIN_INACTIVE' | 'DOMAIN_DNS_NOT_STARTED' | 'DOMAIN_ALREADY_VERIFIED';

export const DOMAIN_VERIFICATION_ERROR_CODES: readonly DomainVerificationErrorCode[] = [
  'CUSTOMER_DOMAIN_NOT_FOUND', 'DOMAIN_VERIFIED_ELSEWHERE', 'DOMAIN_VERIFICATION_CONFLICT_RETRY',
  'DOMAIN_INACTIVE', 'DOMAIN_DNS_NOT_STARTED', 'DOMAIN_ALREADY_VERIFIED',
];

export function isDomainVerificationErrorCode(code: string | undefined): code is DomainVerificationErrorCode {
  return !!code && (DOMAIN_VERIFICATION_ERROR_CODES as readonly string[]).includes(code);
}

/** The scope a Google Workspace DWD grant needs for the `google_directory` method (plan D8). */
export const GOOGLE_DOMAIN_SCOPE = 'https://www.googleapis.com/auth/admin.directory.domain.readonly';

export const customerDomainsUrl = (orgId: string) => `/orgs/organizations/${orgId}/customer-domains`;
export const customerDomainUrl = (orgId: string, domainId: string) => `${customerDomainsUrl(orgId)}/${domainId}`;

/** Where an org's domains are managed (Organization › Domains). */
export const orgDomainsHref = (orgId: string) => `/settings/organizations/${orgId}#domains`;

const STATES: readonly string[] = ['declared', 'pending_dns', 'verified'];

/** A shape check, so a malformed 200 lands in the caller's load-error state instead of crashing the table. */
export function isCustomerDomainView(value: unknown): value is CustomerDomainView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.orgId === 'string' && typeof v.domain === 'string'
    && typeof v.isActive === 'boolean' && typeof v.autoCreateContact === 'boolean'
    && typeof v.state === 'string' && STATES.includes(v.state)
    && (v.method === null || (typeof v.method === 'string' && (DOMAIN_VERIFICATION_METHODS as readonly string[]).includes(v.method)))
    && (v.dnsRecord === null || (!!v.dnsRecord && typeof v.dnsRecord === 'object'));
}

export function isVerifyCustomerDomainOutcome(value: unknown): value is VerifyCustomerDomainOutcome {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.result === 'verified') return typeof v.method === 'string';
  return (v.result === 'failed' || v.result === 'unavailable') && typeof v.reason === 'string';
}
