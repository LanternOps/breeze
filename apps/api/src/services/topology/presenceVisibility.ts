import { siteAccessCheck } from '../../middleware/auth';
import { canAccessSite, type UserPermissions } from '../permissions';
import type { TopologyRequestContext } from './access';

/**
 * Presence site gate (site location W2, spec S§8). RLS isolates orgs, not sites, so every presence read applies
 * this app-layer gate on top of the request's org RLS context. A site is visible iff ALL of:
 *   - the LIVE permissions allow it (`current`, re-read by graphAuthority),
 *   - the request's permissions allow it (`ctx.permissions`),
 *   - the token's own ceiling allows it (`ctx.auth.allowedSiteIds`, e.g. a site-limited API key).
 * Partner and system scopes carry no site allowlist, so they are unrestricted by site.
 * Naming a site other than the viewed one, or showing a device owned by one, requires this to be true (R2, R3).
 */
export function siteVisibility(ctx: TopologyRequestContext, current: UserPermissions): (siteId: string | null | undefined) => boolean {
  const tokenCeiling = siteAccessCheck(ctx.auth.allowedSiteIds);
  return (siteId) => !!siteId && canAccessSite(current, siteId) && canAccessSite(ctx.permissions, siteId) && tokenCeiling(siteId);
}
