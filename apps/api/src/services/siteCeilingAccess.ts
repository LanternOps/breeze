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
 * breadth"; `canMutateOrgWideGovernance` answers "does this caller's site
 * ceiling block them from org-wide objects at all" (partner/system scope
 * never carries a site ceiling).
 */
import type { AuthContext } from '../middleware/auth';

export type SiteCeilingAuth = Pick<AuthContext, 'scope' | 'allowedSiteIds'>;

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
 * True when the caller may create/update/delete/enable/test an org-wide
 * governance object. Exactly the negation of `hasSiteCeiling`.
 */
export function canMutateOrgWideGovernance(auth: SiteCeilingAuth): boolean {
  return !hasSiteCeiling(auth);
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
