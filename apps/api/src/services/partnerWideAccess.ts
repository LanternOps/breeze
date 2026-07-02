/**
 * Partner-wide administration capability (epic #2135).
 *
 * Partner-wide ("all organizations") state — configuration policies, software
 * policy templates, and every future dual-ownership table — pushes config to
 * EVERY org under the partner, including orgs created later. Only full-partner
 * admins (partner_users.org_access = 'all') and system scope may create or
 * modify it.
 *
 * This is a deliberately dependency-free leaf module (types only) so routes,
 * services, workers, and AI tools can all import the ONE capability check
 * without pulling in the configurationPolicy service graph — test files that
 * mock db/schema stay unaffected. configurationPolicy re-exports these for
 * back-compat.
 */
import type { AuthContext } from '../middleware/auth';

/**
 * True when the caller may create/modify partner-wide state. Contexts that
 * never resolved a partner membership (org scope, agent, helper, MCP keys)
 * have no partnerOrgAccess and fail closed. Deliberately NOT derivable from
 * accessibleOrgIds: a 'selected' user whose selection happens to cover every
 * current org still must not administer partner-wide state.
 */
export function canManagePartnerWidePolicies(
  auth: Pick<AuthContext, 'scope' | 'partnerOrgAccess'>
): boolean {
  return auth.scope === 'system' || (auth.scope === 'partner' && auth.partnerOrgAccess === 'all');
}

export const PARTNER_WIDE_WRITE_DENIED_MESSAGE =
  'Modifying a partner-wide policy requires full partner org access (orgAccess must be "all")';

/** Thrown by service mutators when a partner-wide row is visible to the caller but not administrable. Routes map it to 403. */
export class PartnerWideWriteDeniedError extends Error {
  constructor() {
    super(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    this.name = 'PartnerWideWriteDeniedError';
  }
}
