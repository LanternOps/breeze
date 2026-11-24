import type { JwtClaimsState } from '@/lib/authScope';

/**
 * Who manages a new configuration policy (spec Decision 1, plan W03d C2).
 *
 * The question is never asked as an ownership type: the page states the
 * owner on a "Managed by" line, with a default that follows the caller's
 * access. This module is the whole rule; the page only renders it. It is
 * UX only: the create route re-checks every owner on the server
 * (`canManagePartnerWidePolicies` for MSP-managed, `canAccessOrg` for an
 * organization).
 *
 * Deliberately not `useDefaultOwnerScope`: that hook serves eight other
 * config surfaces and keys on the switcher being on All organizations,
 * which is not this rule.
 */

export type OwnerChoice = { kind: 'msp' } | { kind: 'org'; orgId: string | null };

/**
 * - `full_partner`: a partner user with access to every organization.
 * - `limited_partner`: a partner user with access to selected organizations,
 *   or one whose access is still loading (`canManagePartnerWide` undefined).
 * - `org`: an organization-scope user (a customer's admin, a single-org team).
 * - `unknown`: the token's scope is not resolved yet.
 */
export type CreatorKind = 'full_partner' | 'limited_partner' | 'org' | 'unknown';

export function creatorKind(claims: JwtClaimsState, canManagePartnerWide: boolean | undefined): CreatorKind {
  if (claims.status !== 'resolved') return 'unknown';
  const { scope, partnerId } = claims.claims;
  if (scope === 'organization') return 'org';
  if (scope === 'partner' && partnerId) return canManagePartnerWide === true ? 'full_partner' : 'limited_partner';
  // A system-scope session has no partner to own an MSP-managed policy: it
  // picks an organization, like a limited partner.
  if (scope === 'system') return 'limited_partner';
  return 'unknown';
}

/**
 * The default owner. A full-access partner gets MSP-managed; a limited
 * partner gets the switcher's organization (null = they must choose one);
 * an org user gets their own organization.
 */
export function ownerDefault(
  kind: CreatorKind,
  currentOrgId: string | null,
  ownOrgId: string | null,
): OwnerChoice {
  if (kind === 'full_partner') return { kind: 'msp' };
  if (kind === 'org') return { kind: 'org', orgId: ownOrgId ?? currentOrgId };
  return { kind: 'org', orgId: currentOrgId };
}

/** Only a full-access partner may own a policy at the MSP. */
export function offersMspOwner(kind: CreatorKind): boolean {
  return kind === 'full_partner';
}

/** Partner users choose the organization; an org user's is fixed. */
export function offersOrgChoice(kind: CreatorKind): boolean {
  return kind === 'full_partner' || kind === 'limited_partner';
}

/**
 * The owner part of `POST /configuration-policies`, or null when the choice
 * cannot be sent: MSP-managed for a caller who may not manage MSP-wide
 * policies, or an organization not chosen yet. The partner is always derived
 * by the server from the token.
 */
export function createOwnerBody(
  owner: OwnerChoice,
  kind: CreatorKind,
): { ownerScope: 'partner' } | { orgId: string } | null {
  if (owner.kind === 'msp') return offersMspOwner(kind) ? { ownerScope: 'partner' } : null;
  return owner.orgId ? { orgId: owner.orgId } : null;
}
