import AsyncStorage from '@react-native-async-storage/async-storage';

import { coreRequest } from './api';
import type { CachedSite } from './arrivalMatch';
import { LOCATION_SITES_CACHE_KEY, invalidateLocationSites } from './locationSitesCache';

export { LOCATION_SITES_CACHE_KEY, invalidateLocationSites };

/**
 * Client + cache for `GET /time-entries/location-sites`: the partner flag, the
 * default radius, whether this user may pin a site, and the candidate sites in
 * one call. The cache holds site data only — never the technician's position.
 *
 * `enabled:false` is cached too, so a partner that has the feature off costs
 * one request per day, not one per foreground.
 */
export const LOCATION_SITES_TTL_MS = 24 * 3600_000;

export type LocationSitesSnapshot = {
  enabled: boolean;
  defaultRadiusM: number;
  canSetLocation: boolean;
  sites: CachedSite[];
  fetchedAtMs: number;
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function narrowSite(value: unknown): CachedSite | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || typeof s.orgId !== 'string') return null;
  const latitude = num(s.latitude);
  const longitude = num(s.longitude);
  return {
    id: s.id,
    orgId: s.orgId,
    orgName: typeof s.orgName === 'string' ? s.orgName : '',
    name: typeof s.name === 'string' ? s.name : '',
    // A pair or nothing: half a coordinate cannot be matched against.
    latitude: latitude !== null && longitude !== null ? latitude : null,
    longitude: latitude !== null && longitude !== null ? longitude : null,
    geofenceRadiusM: num(s.geofenceRadiusM),
  };
}

/** Narrows a server body or a stored blob; null when it is not the expected shape. */
function narrowSnapshot(value: unknown, fetchedAtMs: number): LocationSitesSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean' || !Array.isArray(v.sites)) return null;
  const defaultRadiusM = num(v.defaultRadiusM);
  if (defaultRadiusM === null) return null;
  return {
    enabled: v.enabled,
    defaultRadiusM,
    canSetLocation: v.canSetLocation === true,
    sites: v.sites.map(narrowSite).filter((s): s is CachedSite => s !== null),
    fetchedAtMs,
  };
}

async function readCache(): Promise<LocationSitesSnapshot | null> {
  try {
    const stored = await AsyncStorage.getItem(LOCATION_SITES_CACHE_KEY);
    if (stored === null) return null;
    const parsed = JSON.parse(stored) as { fetchedAtMs?: unknown };
    const at = num(parsed.fetchedAtMs);
    return at === null ? null : narrowSnapshot(parsed, at);
  } catch {
    return null;
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; statusCode?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  return typeof e.status === 'number' ? e.status : undefined;
}

export async function getLocationSites(opts: {
  nowMs: number;
  force?: boolean;
}): Promise<LocationSitesSnapshot | null> {
  const cached = await readCache();
  if (cached && opts.force !== true && opts.nowMs - cached.fetchedAtMs < LOCATION_SITES_TTL_MS) {
    return cached;
  }

  try {
    const body = await coreRequest<unknown>('/time-entries/location-sites');
    const fresh = narrowSnapshot(body, opts.nowMs);
    if (fresh === null) return cached;
    try {
      await AsyncStorage.setItem(LOCATION_SITES_CACHE_KEY, JSON.stringify(fresh));
    } catch {
      // Uncached is only a re-fetch next time.
    }
    return fresh;
  } catch (error) {
    const status = statusOf(error);
    if (status === 403 || status === 401) {
      // The account lost access (or never had it): do not keep serving sites.
      await invalidateLocationSites();
      return null;
    }
    // Offline or a server blip: a stale list still beats no list.
    return cached;
  }
}
