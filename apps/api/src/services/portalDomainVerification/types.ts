/**
 * Portal registration W5 (#11382): customer domain verification types.
 * The method / reason unions live in `@breeze/shared/types/customerDomains`
 * so the web Domains tab shares them; this file adds the API-only shapes
 * (evidence, checker interface).
 */
import type {
  DomainCheckFailReason,
  DomainCheckUnavailableReason,
  DomainVerificationMethod,
} from '@breeze/shared/types/customerDomains';

export type {
  CustomerDomainDnsRecord,
  CustomerDomainState,
  CustomerDomainView,
  DomainCheckFailReason,
  DomainCheckStatus,
  DomainCheckUnavailableReason,
  DomainVerificationClearedReason,
  DomainVerificationErrorCode,
  DomainVerificationMethod,
  VerifyCustomerDomainOutcome,
} from '@breeze/shared/types/customerDomains';
export { DOMAIN_VERIFICATION_METHODS } from '@breeze/shared/types/customerDomains';

/**
 * What a passing check proved, stored in `customer_email_domains.verified_evidence`
 * (jsonb; export `excludedOpen`). Never a secret, key or token.
 * `customer_email_domains_evidence_chk` requires the keys per method.
 */
export type DomainVerificationEvidence =
  | { via: 'dns_txt'; recordName: string }
  | { via: 'entra_tenant'; tenantId: string; connectionId: string }
  | { via: 'google_directory'; connectionId: string; /** googleConnectionBinding(): admin + service account hash. */ binding: string };

export type DomainCheckResult =
  | { status: 'pass'; evidence: DomainVerificationEvidence }
  | { status: 'fail'; reason: DomainCheckFailReason }
  | { status: 'unavailable'; reason: DomainCheckUnavailableReason };

/** Fail reasons that mean the evidence source itself is gone: clear at once (plan D10). */
export const STRUCTURAL_FAIL_REASONS: ReadonlySet<DomainCheckFailReason> = new Set<DomainCheckFailReason>([
  'tenant_not_proven',
  'connection_missing',
]);

export interface DomainCheckTarget {
  rowId: string;
  orgId: string;
  partnerId: string;
  /** Lowercase. */
  domain: string;
  verificationToken: string | null;
}

export interface DomainVerificationChecker {
  readonly method: DomainVerificationMethod;
  /** Never throws: transport errors map to `unavailable`. */
  check(target: DomainCheckTarget): Promise<DomainCheckResult>;
}

export type DomainVerificationCheckers = Record<DomainVerificationMethod, DomainVerificationChecker>;
