/**
 * Cross-wave contract types for caller verification (#6354).
 * Names/signatures are fixed by docs/superpowers/plans/security-auth/2026-09-19-caller-verification.md.
 */
export type CallerVerificationAction = 'reset_password' | 'disable_user';
export type CallerVerificationActionScope = CallerVerificationAction | 'any';
export type CallerVerificationMethod = 'workstation' | 'sms' | 'email' | 'callback_attestation' | 'administrative_stepup';
export type CallerVerificationStatus =
  | 'pending' | 'verified' | 'rejected_by_user' | 'wrong_choice' | 'expired' | 'undeliverable' | 'cancelled' | 'revoked';

export interface EntraSubject { entraTenantId: string; entraOid: string }

/** The technician (or partner user) performing an authenticated operation. */
export interface CallerVerificationActor {
  userId: string;
  partnerId: string | null;
  scope: 'partner' | 'organization';
  /** null = unrestricted (partner-wide / system). */
  accessibleOrgIds: string[] | null;
  /** null = every site; [] = no site-scoped contacts (org-level only). */
  allowedSiteIds: string[] | null;
  displayName: string;
}

export type { BindingRow, DestinationRow, PolicyRow, VerificationRow } from '../../db/schema/callerVerification';

export type DestinationSource = 'technician' | 'import' | 'inbound_email' | 'ai_tool' | 'portal_self_service';
