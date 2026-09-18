/**
 * Site-ceiling write gate for org-wide governance objects.
 *
 * Owner decision (2026-09-10): a caller with a defined site ceiling
 * (`allowedSiteIds` set — including `[]`) may not create/update/delete/
 * enable/test org-wide governance objects: webhooks, notification channels,
 * software policies, peripheral policies, configuration-policy parents +
 * feature links, PAM org config + signer groups, and backup configs +
 * profiles. There is no per-site ownership model for these objects — a
 * site-restricted caller can still ASSIGN an existing policy to their own
 * site (`authorizeAssignmentTarget`), but cannot create or edit the
 * org-wide object itself.
 *
 * This is a deliberately dependency-free leaf module (types only) so routes,
 * services, workers, and AI tools can all import the ONE capability check
 * without pulling in any service graph — test files that mock db/schema
 * stay unaffected. Mirrors `partnerWideAccess.ts`.
 *
 * The two gates are orthogonal and BOTH apply where both exist:
 * `canManagePartnerWidePolicies` answers "may this caller act at partner
 * breadth"; `canMutateOrgWideGovernance` answers "does this caller's site or
 * exact-device ceiling block them from org-wide objects at all" (partner/system
 * scope never carries a site ceiling).
 */
import type { AuthContext } from '../middleware/auth';

export type SiteCeilingAuth = Pick<AuthContext, 'scope' | 'allowedSiteIds'> &
  Partial<Pick<AuthContext, 'allowedDeviceIds'>>;

/**
 * True when the caller is an organization-scope principal carrying ANY site
 * ceiling. `allowedSiteIds === undefined` means unrestricted (no ceiling).
 * `allowedSiteIds` being an array — including the empty array `[]` — means
 * the caller is restricted to zero or more specific sites, i.e. a ceiling
 * exists. Partner and system scope principals never carry a site ceiling,
 * regardless of what `allowedSiteIds` happens to hold on the object.
 */
export function hasSiteCeiling(auth: SiteCeilingAuth): boolean {
  return auth.scope === 'organization' && auth.allowedSiteIds !== undefined;
}

/**
 * True when the caller carries an EXACT-DEVICE ceiling (`allowedDeviceIds`
 * set — including `[]`). Only `aiAgents/agentAuthContext.ts` ever sets this
 * field, so it is always false for human, API-key and MCP principals.
 *
 * Unlike the site ceiling this is NOT gated on `scope`: `allowedDeviceIds` is
 * never populated incidentally, so its presence always means "this run may
 * touch exactly these devices".
 */
export function hasExactDeviceCeiling(auth: SiteCeilingAuth): boolean {
  return auth.allowedDeviceIds !== undefined;
}

/**
 * True when the caller may create/update/delete/enable/test an org-wide
 * governance object: the negation of BOTH ceilings.
 *
 * The exact-device axis is part of this gate, not just the site axis (#6096).
 * A device-LESS AI analysis run carries `allowedDeviceIds` with NO
 * `allowedSiteIds`, which a site-only check reads as "unrestricted" — it then
 * sailed through every gate in this family and could rewrite org policy that
 * fans out to the entire fleet. These objects are org-wide by construction, so
 * there is nothing to narrow for such a caller: it fails closed exactly as a
 * site-restricted one does.
 */
export function canMutateOrgWideGovernance(auth: SiteCeilingAuth): boolean {
  return !hasSiteCeiling(auth) && !hasExactDeviceCeiling(auth);
}

export const SITE_CEILING_WRITE_DENIED_MESSAGE =
  'Site-restricted users cannot modify organization-wide settings. Ask an unrestricted administrator.';

/** Thrown by service mutators when a site-ceiling caller attempts to touch an org-wide governance object. Routes map it to 403. */
export class SiteCeilingWriteDeniedError extends Error {
  constructor() {
    super(SITE_CEILING_WRITE_DENIED_MESSAGE);
    this.name = 'SiteCeilingWriteDeniedError';
  }
}
