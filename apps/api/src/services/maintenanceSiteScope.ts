/**
 * Maintenance windows — site-axis (app-layer authz) enforcement (#3654).
 *
 * Site is an app-layer authz axis: Postgres RLS does NOT defend it. Every
 * maintenance-window write used to gate on the org axis alone
 * (`canAccessWindow`), so a technician restricted to Site A could re-time or
 * delete a window that another site's software deployment was bound to
 * (`softwareDeploymentScheduler.isMaintenanceWindowOpen` joins deployments to
 * windows by id) — dispatching a 400-machine install into business hours, or
 * silently stranding it forever.
 *
 * The gate mirrors the automation precedent
 * (`automationRuntime.checkAutomationTargetsWithinSiteScope` +
 * `routes/automations.ts:enforceAutomationSiteScope`): reject an unbounded
 * target outright, otherwise resolve the target set to concrete sites and
 * require every one of them to pass `canAccessSite`.
 *
 * Two deliberate asymmetries, both documented at their use site below:
 *
 *  - **Writes require containment, reads only intersection.** A window that
 *    spans Site A and Site B stays *visible* to a Site-A tech (their own fleet
 *    really is suppressed by it, and hiding that is an operational hazard) but
 *    is not *mutable* by them.
 *  - **A target set that resolves to no site is rejected**, where the
 *    automation precedent passes it. `isDeviceInMaintenance` ORs `siteIds`,
 *    `groupIds` and `deviceIds` independently of `targetType`, so no single
 *    array is authoritative; requiring at least one provably in-scope site is
 *    the only claim that survives a change to that matcher. The window feature
 *    is deprecated in favour of configuration policies, so the usability cost
 *    of the stricter rule is nil.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroups, devices } from '../db/schema';
import { canAccessSite, type UserPermissions } from './permissions';

/** The subset of a maintenance-window row the site gate reasons about. */
export interface MaintenanceWindowTarget {
  orgId: string | null;
  targetType: string | null;
  siteIds?: string[] | null;
  groupIds?: string[] | null;
  deviceIds?: string[] | null;
}

export type MaintenanceSiteScopeDenial =
  /** Partner-wide window (org_id NULL): spans every org, containment unprovable. */
  | 'partner_wide'
  /** `targetType: 'all'` — reaches every device in the org, now and in future. */
  | 'unbounded'
  /** Nothing in the target set resolves to a site the caller could own. */
  | 'unresolved'
  /** At least one resolved site is outside the caller's allowlist. */
  | 'out_of_scope';

export interface MaintenanceSiteScopeCheck {
  ok: boolean;
  reason: MaintenanceSiteScopeDenial | null;
  /** Resolved sites outside the allowlist. Empty for the non-`out_of_scope` denials. */
  outOfScopeSiteIds: string[];
}

export const MAINTENANCE_SITE_SCOPE_MESSAGES: Record<MaintenanceSiteScopeDenial, string> = {
  partner_wide: 'Site-restricted users cannot manage partner-wide maintenance windows',
  unbounded:
    'Site-restricted users cannot manage a maintenance window that targets all devices in the organization',
  unresolved: 'A site-restricted user must target at least one site they can access',
  out_of_scope: 'Access to one or more target sites denied',
};

const PERMITTED: MaintenanceSiteScopeCheck = { ok: true, reason: null, outOfScopeSiteIds: [] };

function deny(reason: MaintenanceSiteScopeDenial, outOfScopeSiteIds: string[] = []): MaintenanceSiteScopeCheck {
  return { ok: false, reason, outOfScopeSiteIds };
}

function uniqueIds(ids: string[] | null | undefined): string[] {
  return [...new Set((ids ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

/**
 * Resolve a window's target set to the concrete sites it can reach.
 *
 * `hasSitelessTarget` is true when a referenced group or device carries no
 * site: such a target spans the whole org, so a site-restricted caller can
 * never prove containment over it and must be denied (same fail-closed rule as
 * `aiToolsSiteScope.deviceSiteDenied`).
 *
 * Ids that resolve to nothing within `orgId` are ignored rather than denied:
 * `isDeviceInMaintenance` only ever matches live devices in the window's own
 * org, so a stale id is genuinely unreachable. It cannot be used to widen
 * reach either, because the caller must still clear the "at least one resolved
 * in-scope site" bar below.
 */
async function resolveTargetSites(
  orgId: string,
  target: MaintenanceWindowTarget,
): Promise<{ siteIds: string[]; hasSitelessTarget: boolean }> {
  const siteIds = new Set<string>(uniqueIds(target.siteIds));
  let hasSitelessTarget = false;

  const groupIds = uniqueIds(target.groupIds);
  if (groupIds.length > 0) {
    const rows = await db
      .select({ siteId: deviceGroups.siteId })
      .from(deviceGroups)
      .where(and(eq(deviceGroups.orgId, orgId), inArray(deviceGroups.id, groupIds)));
    for (const row of rows) {
      if (typeof row.siteId === 'string') siteIds.add(row.siteId);
      else hasSitelessTarget = true;
    }
  }

  const deviceIds = uniqueIds(target.deviceIds);
  if (deviceIds.length > 0) {
    const rows = await db
      .select({ siteId: devices.siteId })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), inArray(devices.id, deviceIds)));
    for (const row of rows) {
      if (typeof row.siteId === 'string') siteIds.add(row.siteId);
      else hasSitelessTarget = true;
    }
  }

  return { siteIds: [...siteIds], hasSitelessTarget };
}

/**
 * Write gate. A site-restricted caller may only create or mutate a window whose
 * ENTIRE target set sits inside their site allowlist. Unrestricted callers
 * (`allowedSiteIds` undefined — every partner- and system-scope caller, plus org
 * members with no site restriction) pass without a single query.
 *
 * Note `allowedSiteIds: []` is "restricted to no sites", not "unrestricted" —
 * matching `canAccessSite`, which returns false for every site in that state.
 */
export async function checkMaintenanceTargetsWithinSiteScope(
  target: MaintenanceWindowTarget,
  perms: Pick<UserPermissions, 'allowedSiteIds'> | undefined,
): Promise<MaintenanceSiteScopeCheck> {
  if (!perms?.allowedSiteIds) return PERMITTED;

  if (target.orgId === null) return deny('partner_wide');
  if (target.targetType === 'all') return deny('unbounded');

  const { siteIds, hasSitelessTarget } = await resolveTargetSites(target.orgId, target);
  if (hasSitelessTarget) return deny('out_of_scope');
  if (siteIds.length === 0) return deny('unresolved');

  const outOfScopeSiteIds = siteIds.filter(
    (siteId) => !canAccessSite(perms as UserPermissions, siteId),
  );
  return outOfScopeSiteIds.length > 0 ? deny('out_of_scope', outOfScopeSiteIds) : PERMITTED;
}

/**
 * Read gate. Narrows a window list to those a site-restricted caller may see:
 * a window is visible when it can reach at least one of their sites.
 *
 * Deliberately INTERSECTION, not the containment the write gate demands. A
 * window spanning Site A and Site B really does suppress the Site-A tech's own
 * devices; hiding it would leave them unable to explain why their fleet is in
 * maintenance. They still cannot mutate it. `targetType: 'all'` windows reach
 * every site and so stay visible for the same reason.
 *
 * Resolution is batched — two queries for the whole list, not two per window.
 */
export async function filterWindowsToSiteScope<T extends MaintenanceWindowTarget>(
  windows: T[],
  perms: Pick<UserPermissions, 'allowedSiteIds'> | undefined,
): Promise<T[]> {
  if (!perms?.allowedSiteIds || windows.length === 0) return windows;
  const allowed = new Set(perms.allowedSiteIds);

  const groupIds = new Set<string>();
  const deviceIds = new Set<string>();
  for (const window of windows) {
    if (window.targetType === 'all') continue;
    for (const id of uniqueIds(window.groupIds)) groupIds.add(id);
    for (const id of uniqueIds(window.deviceIds)) deviceIds.add(id);
  }

  const groupSite = new Map<string, string | null>();
  if (groupIds.size > 0) {
    const rows = await db
      .select({ id: deviceGroups.id, siteId: deviceGroups.siteId })
      .from(deviceGroups)
      .where(inArray(deviceGroups.id, [...groupIds]));
    for (const row of rows) groupSite.set(row.id, row.siteId);
  }

  const deviceSite = new Map<string, string | null>();
  if (deviceIds.size > 0) {
    const rows = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(inArray(devices.id, [...deviceIds]));
    for (const row of rows) deviceSite.set(row.id, row.siteId);
  }

  const reaches = (siteId: string | null | undefined): boolean =>
    typeof siteId === 'string' && allowed.has(siteId);

  return windows.filter((window) => {
    if (window.targetType === 'all') return true;
    if (uniqueIds(window.siteIds).some(reaches)) return true;
    if (uniqueIds(window.groupIds).some((id) => reaches(groupSite.get(id)))) return true;
    if (uniqueIds(window.deviceIds).some((id) => reaches(deviceSite.get(id)))) return true;
    return false;
  });
}

/** Single-row form of {@link filterWindowsToSiteScope}, for detail routes. */
export async function isWindowVisibleInSiteScope(
  window: MaintenanceWindowTarget,
  perms: Pick<UserPermissions, 'allowedSiteIds'> | undefined,
): Promise<boolean> {
  const visible = await filterWindowsToSiteScope([window], perms);
  return visible.length > 0;
}
