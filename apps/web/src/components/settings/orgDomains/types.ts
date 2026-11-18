/**
 * Organization › Domains (portal registration W5, #11382): web-side shapes of
 * the org-scoped customer-domain routes (`/orgs/organizations/:id/customer-domains`).
 *
 * These mirror the W05a API contract in the W5 plan
 * (`docs/superpowers/plans/portal/2026-11-11-portal-registration-options-w05-domain-verification.md`,
 * Task 5 "Produces" and Task 7). Task 7 moves `CustomerDomainView` and the
 * method/reason unions into `packages/shared/src/types/customerDomains.ts`; once
 * that is on main, those declarations become re-exports from `@breeze/shared`.
 * `VerifyCustomerDomainOutcome` and the error codes stay API-side in the plan, so
 * they stay declared here unless W05a shares them too. The normalizers and URL
 * helpers are web-only.
 */

export const DOMAIN_VERIFICATION_METHODS = ['dns_txt', 'entra_tenant', 'google_directory'] as const;
export type DomainVerificationMethod = (typeof DOMAIN_VERIFICATION_METHODS)[number];

export type DomainCheckFailReason = 'record_missing' | 'not_in_directory' | 'tenant_not_proven' | 'connection_missing';
export type DomainCheckUnavailableReason = 'dns_error' | 'timeout' | 'graph_unavailable' | 'graph_tenant_mismatch'
  | 'google_scope_missing' | 'google_access_denied' | 'google_unavailable';
export type DomainVerificationClearedReason = DomainCheckFailReason | 'stale' | 'repointed' | 'msp_removed' | 'displaced';

export const CUSTOMER_DOMAIN_STATES = ['declared', 'pending_dns', 'verified'] as const;
export type CustomerDomainState = (typeof CUSTOMER_DOMAIN_STATES)[number];

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

export const DOMAIN_VERIFICATION_ERROR_CODES = [
  'CUSTOMER_DOMAIN_NOT_FOUND', 'DOMAIN_VERIFIED_ELSEWHERE', 'DOMAIN_VERIFICATION_CONFLICT_RETRY',
  'DOMAIN_INACTIVE', 'DOMAIN_DNS_NOT_STARTED', 'DOMAIN_ALREADY_VERIFIED',
] as const;
export type DomainVerificationErrorCode = (typeof DOMAIN_VERIFICATION_ERROR_CODES)[number];

export function isDomainVerificationErrorCode(code: string | undefined): code is DomainVerificationErrorCode {
  return !!code && (DOMAIN_VERIFICATION_ERROR_CODES as readonly string[]).includes(code);
}

/** The scope a Google Workspace DWD grant needs for the `google_directory` method (plan D8). */
export const GOOGLE_DOMAIN_SCOPE = 'https://www.googleapis.com/auth/admin.directory.domain.readonly';

export const customerDomainsUrl = (orgId: string) => `/orgs/organizations/${orgId}/customer-domains`;
export const customerDomainUrl = (orgId: string, domainId: string) => `${customerDomainsUrl(orgId)}/${domainId}`;

/** Where an org's domains are managed (Organization › Domains). */
export const orgDomainsHref = (orgId: string) => `/settings/organizations/${orgId}#domains`;

const isString = (v: unknown): v is string => typeof v === 'string';
const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function isDomainVerificationMethod(v: unknown): v is DomainVerificationMethod {
  return typeof v === 'string' && (DOMAIN_VERIFICATION_METHODS as readonly string[]).includes(v);
}

/**
 * One API row → a view the UI can render, or null when the row lacks what every
 * screen needs (id, org, domain, the two flags). Additive API values degrade
 * instead of failing the whole list: an unknown state reads as declared, an
 * unknown method as none, and a verified row without a known method as
 * declared (never a badge we cannot name).
 */
export function normalizeCustomerDomainView(value: unknown): CustomerDomainView | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isString(v.id) || !isString(v.orgId) || !isString(v.domain)
    || typeof v.isActive !== 'boolean' || typeof v.autoCreateContact !== 'boolean') return null;
  const method = isDomainVerificationMethod(v.method) ? v.method : null;
  let state: CustomerDomainState = (CUSTOMER_DOMAIN_STATES as readonly string[]).includes(v.state as string)
    ? (v.state as CustomerDomainState) : 'declared';
  if (state === 'verified' && !method) state = 'declared';
  const rec = v.dnsRecord as Record<string, unknown> | null | undefined;
  const dnsRecord = rec && typeof rec === 'object' && isString(rec.recordName) && isString(rec.recordValue)
    ? { recordName: rec.recordName, recordValue: rec.recordValue } : null;
  const lastCheckStatus = v.lastCheckStatus === 'pass' || v.lastCheckStatus === 'fail' || v.lastCheckStatus === 'unavailable'
    ? v.lastCheckStatus : null;
  return {
    id: v.id,
    orgId: v.orgId,
    domain: v.domain,
    isActive: v.isActive,
    autoCreateContact: v.autoCreateContact,
    state,
    method: state === 'verified' ? method : null,
    verifiedAt: stringOrNull(v.verifiedAt),
    lastCheckedAt: stringOrNull(v.lastCheckedAt),
    lastPassedAt: stringOrNull(v.lastPassedAt),
    lastCheckStatus,
    clearedAt: stringOrNull(v.clearedAt),
    clearedReason: stringOrNull(v.clearedReason) as DomainVerificationClearedReason | null,
    dnsRecord,
    usableForSignIn: v.usableForSignIn === true,
  };
}

/**
 * Normalizes a list body. Throws when `data` is not an array (the caller's
 * load-error state); drops and logs individual rows it cannot render.
 */
export function normalizeCustomerDomainList(data: unknown, source: string): CustomerDomainView[] {
  if (!Array.isArray(data)) throw new Error(`${source}: customer domains body is not a list`);
  const rows: CustomerDomainView[] = [];
  for (const item of data) {
    const row = normalizeCustomerDomainView(item);
    if (row) rows.push(row);
    else console.error(`[${source}] dropped a customer domain row with an unexpected shape`, item);
  }
  return rows;
}

/**
 * A 200 check body → an outcome. The check has already run by then, so an
 * unknown `result` is shown as an unfinished check rather than thrown away.
 * Returns null only when the body is not an object with a `result` at all.
 */
export function normalizeVerifyOutcome(value: unknown): VerifyCustomerDomainOutcome | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.result === 'verified' && isDomainVerificationMethod(v.method)) {
    return { result: 'verified', method: v.method, displacedOrgId: stringOrNull(v.displacedOrgId) };
  }
  if (v.result === 'failed' && isString(v.reason)) return { result: 'failed', reason: v.reason as DomainCheckFailReason };
  if (v.result === 'unavailable' && isString(v.reason)) {
    return { result: 'unavailable', reason: v.reason as DomainCheckUnavailableReason };
  }
  if (!isString(v.result)) return null;
  // Labels fall back to a generic "did not pass" for a reason this build does not know.
  return { result: 'unavailable', reason: (isString(v.reason) ? v.reason : 'unknown') as DomainCheckUnavailableReason };
}
