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

/**
 * Identity a partner-wide READ gate needs. Deliberately structural (scope as a
 * plain string) so route-local AuthContext shapes — e.g.
 * `routes/policyManagement/schemas.ts` — can pass without a cast.
 */
export type PartnerWideReadAuth = {
  scope: string;
  partnerId: string | null;
};

/**
 * True when `auth` may READ partner-wide rows (org_id NULL) owned by
 * `ownerPartnerId`.
 *
 * Org-scoped tokens carry a partnerId (`middleware/auth.ts` feeds it into
 * `DbAccessContext.currentPartnerId` for every org user), so an app-layer
 * condition of the shape `org_id IS NULL AND partner_id = auth.partnerId`
 * matches for a plain org user. RLS does NOT catch that: the partner-wide
 * SELECT branch (`org_id IS NULL AND partner_id =
 * breeze_current_partner_id()`) deliberately makes those rows readable from an
 * org context — it is load-bearing for agent config delivery. On background
 * worker paths the read is system-scoped and unfiltered anyway.
 *
 * So on these paths the app-layer gate is the ONLY authorization control on
 * the partner axis, not a redundant second one (#4952). Use it wherever a
 * dual-axis read decides what a caller may act on, and mirror it on the loaded
 * row where the consequence is execution rather than display.
 *
 * `null`/absent auth means "no request identity" — the background/system path,
 * which is genuinely allowed to see partner-wide rows.
 */
export function canReadPartnerWideRows(
  auth: PartnerWideReadAuth | null | undefined,
  ownerPartnerId: string | null | undefined
): boolean {
  if (!auth) return true;
  if (auth.scope === 'system') return true;
  return (
    auth.scope === 'partner' &&
    !!auth.partnerId &&
    !!ownerPartnerId &&
    auth.partnerId === ownerPartnerId
  );
}
