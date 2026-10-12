import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Leaf module for the location-sites cache key and its eviction, so sign-out
 * (services/auth.ts) can clear it without importing the API client that
 * services/locationSites.ts needs.
 */
export const LOCATION_SITES_CACHE_KEY = 'breeze.locationSites.v1';

export async function invalidateLocationSites(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LOCATION_SITES_CACHE_KEY);
  } catch {
    // A cache we cannot delete is re-checked against the TTL; nothing to surface.
  }
}

/** Sign-out variant: rejects, so a cache that survived is reported as a partial wipe. */
export async function clearLocationSitesOrThrow(): Promise<void> {
  await AsyncStorage.removeItem(LOCATION_SITES_CACHE_KEY);
}
