import { eq } from 'drizzle-orm';
import { db } from '../db';
import { sites } from '../db/schema';

export interface SiteLocationPinInput {
  latitude: number;
  longitude: number;
  geofenceRadiusM?: number;
}

/**
 * Explicit technician pin of a site's coordinate (POST /orgs/sites/:id/location).
 * Only the site's own coordinate is stored — never a technician position.
 * `geofenceRadiusM` is written only when provided so a re-pin keeps the
 * existing per-site override. Returns null on a 0-row write (RLS rejected the
 * UPDATE even though the caller's prior SELECT passed).
 */
export async function pinSiteLocation(siteId: string, input: SiteLocationPinInput, userId: string) {
  const now = new Date();
  const [row] = await db
    .update(sites)
    .set({
      latitude: input.latitude,
      longitude: input.longitude,
      ...(input.geofenceRadiusM !== undefined ? { geofenceRadiusM: input.geofenceRadiusM } : {}),
      locationSource: 'technician',
      locationSetBy: userId,
      locationSetAt: now,
      updatedAt: now,
    })
    .where(eq(sites.id, siteId))
    .returning({
      id: sites.id,
      latitude: sites.latitude,
      longitude: sites.longitude,
      geofenceRadiusM: sites.geofenceRadiusM,
      locationSource: sites.locationSource,
      locationSetBy: sites.locationSetBy,
      locationSetAt: sites.locationSetAt,
    });
  return row ?? null;
}
