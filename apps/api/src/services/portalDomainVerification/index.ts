/**
 * Customer domain verification (portal registration W5, #11382) — public API.
 * The checkers stay internal; W6/W7 consume only the read API
 * (`findOrgByVerifiedDomain`, `isDomainVerifiedForOrg`,
 * `listVerifiedDomainsForOrg`), which re-checks evidence at use (plan D6).
 */
export {
  DomainVerificationError,
  PORTAL_DOMAIN_AUDIT_ACTIONS,
  PORTAL_DOMAIN_AUDIT_RESOURCE_TYPE,
  PORTAL_DOMAIN_STALE_DAYS,
  buildCustomerDomainViews,
  customerDomainRowColumns,
  findOrgByVerifiedDomain,
  isDomainVerifiedForOrg,
  listCustomerDomainsDueForRecheck,
  listOrgCustomerDomains,
  listVerifiedDomainsForOrg,
  recheckCustomerDomain,
  removeCustomerDomainVerification,
  startDnsVerification,
  verifyCustomerDomain,
} from './service';
export type {
  CustomerDomainRow,
  RecheckOutcome,
  VerifiedDomainFact,
  VerifyCustomerDomainDeps,
  VerifyCustomerDomainInput,
} from './service';
export type {
  CustomerDomainState,
  CustomerDomainView,
  DomainCheckFailReason,
  DomainCheckResult,
  DomainCheckTarget,
  DomainCheckUnavailableReason,
  DomainVerificationChecker,
  DomainVerificationCheckers,
  DomainVerificationClearedReason,
  DomainVerificationErrorCode,
  DomainVerificationEvidence,
  DomainVerificationMethod,
  VerifyCustomerDomainOutcome,
} from './types';
