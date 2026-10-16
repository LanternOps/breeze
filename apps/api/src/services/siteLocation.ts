import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { sites, organizations } from '../db/schema';
import { notInHiddenOrgCondition } from './unassignedPool/visibility';

/**
 * #4186 OD-8: cap on the candidate-site list handed to the phone. The phone
 * matches against what it got; the position is never sent to the server to
 * narrow the list (spec section 1 privacy line).
 */
export const LOCATION_SITES_LIMIT = 2000;

export interface LocationSiteRow {
  id: string;
  orgId: string;
  orgName: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number | null;
  locationSource: 'technician' | 'manual' | 'geocoded' | null;
}

/**
 * Sites the caller may match an arrival against. Runs in the request DB
 * context (RLS-backed) — never withSystemDbAccessContext. `accessibleOrgIds`
 * null = unrestricted (system scope); `allowedSiteIds` is a site-confined
 * user's allowlist. Hidden org types (quick_support / unassigned pool) and
 * soft-deleted orgs are excluded. `limit` exists so tests can exercise
 * truncation without inserting LOCATION_SITES_LIMIT + 1 rows.
 */
export async function listLocationSites(
  scope: { accessibleOrgIds: string[] | null; allowedSiteIds?: string[] },
  limit: number = LOCATION_SITES_LIMIT,
): Promise<{ sites: LocationSiteRow[]; truncated: boolean }> {
  if (scope.accessibleOrgIds?.length === 0 || scope.allowedSiteIds?.length === 0) {
    return { sites: [], truncated: false };
  }
  const conds = [isNull(organizations.deletedAt), notInHiddenOrgCondition(sites.orgId)];
  if (scope.accessibleOrgIds) conds.push(inArray(sites.orgId, scope.accessibleOrgIds));
  if (scope.allowedSiteIds) conds.push(inArray(sites.id, scope.allowedSiteIds));

  const rows = await db
    .select({
      id: sites.id,
      orgId: sites.orgId,
      orgName: organizations.name,
      name: sites.name,
      latitude: sites.latitude,
      longitude: sites.longitude,
      geofenceRadiusM: sites.geofenceRadiusM,
      locationSource: sites.locationSource,
    })
    .from(sites)
    .innerJoin(organizations, eq(organizations.id, sites.orgId))
    .where(and(...conds))
    .orderBy(organizations.name, sites.name, sites.id)
    .limit(limit + 1);

  return { sites: rows.slice(0, limit), truncated: rows.length > limit };
}
