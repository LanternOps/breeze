/**
 * Customer-portal self-registration by verified email domain (portal
 * registration W6, plan docs/superpowers/plans/portal/
 * 2026-11-10-portal-registration-options-w06-self-registration.md).
 */

export const PORTAL_SELF_REGISTRATION_QUEUE = 'portal-self-registration';

/**
 * One public submit. `host` is the request's normalized Host
 * (routes/portal/requestHost.ts `requestHost`), resolved to a custom-domain
 * org by the worker, never by the submit handler (D3, D6).
 */
export interface PortalSelfRegistrationJobData {
  email: string;
  name: string;
  host: string | null;
}

export type SelfRegistrationMode = 'approval' | 'instant';

export type SelfRegistrationIneligibleReason = 'no_verified_domain' | 'host_mismatch' | 'org_inactive' | 'mode_off';

export type SelfRegistrationTarget =
  | { kind: 'ineligible'; reason: SelfRegistrationIneligibleReason }
  | {
    kind: 'existing_account';
    orgId: string;
    partnerId: string;
    orgName: string;
    /** The email sender (partner lane), read from the matched org, never request input. */
    partnerName: string | null;
    domain: string;
    mode: SelfRegistrationMode;
  }
  | {
    kind: 'eligible';
    orgId: string;
    partnerId: string;
    orgName: string;
    partnerName: string | null;
    domain: string;
    mode: SelfRegistrationMode;
    policyFingerprint: string;
  };
