import { z } from 'zod';

/** Geofence radius bounds (metres) — shared by the per-site override and the partner default. */
export const SITE_RADIUS_MIN_M = 50;
export const SITE_RADIUS_MAX_M = 1000;
export const LOCATION_DEFAULT_RADIUS_M = 150;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const lat = z.number().finite().min(-90).max(90).transform(round6);
const lng = z.number().finite().min(-180).max(180).transform(round6);
const radius = z.number().int().min(SITE_RADIUS_MIN_M).max(SITE_RADIUS_MAX_M);

/** Body of an explicit site pin (`POST /orgs/sites/:id/location`). */
export const siteLocationPinSchema = z.object({
  latitude: lat,
  longitude: lng,
  geofenceRadiusM: radius.optional(),
}).strict();

/** Plain shape of the location fields on a site PATCH, for schemas that extend it. */
export const siteLocationFieldsShape = {
  latitude: lat.nullable().optional(),
  longitude: lng.nullable().optional(),
  geofenceRadiusM: radius.nullable().optional(),
};

/** latitude/longitude are a pair — both set or both null/absent. */
export function siteLocationPairIsConsistent(v: { latitude?: number | null; longitude?: number | null }): boolean {
  return (v.latitude === undefined) === (v.longitude === undefined)
    && ((v.latitude ?? null) === null) === ((v.longitude ?? null) === null);
}

export const SITE_LOCATION_PAIR_MESSAGE = 'latitude and longitude must be set together';

/** Location fields on a site PATCH: latitude/longitude are a pair — both or neither. */
export const siteLocationFieldsSchema = z.object(siteLocationFieldsShape).refine(
  siteLocationPairIsConsistent,
  { message: SITE_LOCATION_PAIR_MESSAGE, path: ['latitude'] },
);
