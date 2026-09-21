import type { CallerVerificationAction, CallerVerificationStatus, CallerVerificationMethod } from './types';

export type CallerVerificationRefusal =
  | 'no_fresh_verification' | 'grant_consumed' | 'subject_unmatched' | 'subject_ambiguous'
  | 'subject_mailboxes_unknown' | 'tenant_mismatch' | 'contact_fenced' | 'requester_not_authorized'
  | 'technician_mismatch' | 'target_rebound' | 'stepup_invalidated' | 'administrative_disabled' | 'feature_disabled';

/**
 * Thrown by the release gate when an identity-changing action may not
 * proceed. `payload` is the HTTP 409 body contract consumed by W04/W05.
 */
export class CallerVerificationRequiredError extends Error {
  constructor(public readonly payload: {
    orgId: string;
    contactId: string | null;
    action: CallerVerificationAction;
    requiredTier: number;
    reason: CallerVerificationRefusal;
    latest: { id: string; status: CallerVerificationStatus; method: CallerVerificationMethod; decidedAt: string | null } | null;
  }) {
    super(payload.reason);
    this.name = 'CallerVerificationRequiredError';
  }
}

/** Request-shaped refusal: `code` maps to an HTTP status in the router. */
export class CallerVerificationValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CallerVerificationValidationError';
  }
}
