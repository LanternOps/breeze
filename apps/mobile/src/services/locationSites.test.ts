import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  },
}));
vi.mock('./api', () => ({ coreRequest: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { coreRequest } from './api';
import {
  LOCATION_SITES_CACHE_KEY,
  LOCATION_SITES_TTL_MS,
  getLocationSites,
  invalidateLocationSites,
} from './locationSites';

const request = coreRequest as unknown as ReturnType<typeof vi.fn>;
const NOW = 1_800_000_000_000;

const payload = {
  enabled: true,
  defaultRadiusM: 150,
  canSetLocation: true,
  truncated: false,
  sites: [
    {
      id: 's1',
      orgId: 'o1',
      orgName: 'Acme',
      name: 'Main Office',
      latitude: 40.1,
      longitude: -74.2,
      geofenceRadiusM: null,
      locationSource: 'technician',
    },
    {
      id: 's2',
      orgId: 'o1',
      orgName: 'Acme',
      name: 'Annex',
      latitude: null,
      longitude: null,
      geofenceRadiusM: 80,
      locationSource: null,
    },
  ],
};

beforeEach(() => {
  store.clear();
  request.mockReset();
});

describe('getLocationSites', () => {
  it('fetches when there is no cache and keeps coordinate-less sites', async () => {
    request.mockResolvedValue(payload);
    const snap = await getLocationSites({ nowMs: NOW });
    expect(request).toHaveBeenCalledWith('/time-entries/location-sites');
    expect(snap).toMatchObject({
      enabled: true,
      defaultRadiusM: 150,
      canSetLocation: true,
      fetchedAtMs: NOW,
    });
    expect(snap?.sites).toHaveLength(2);
    expect(snap?.sites[1]).toMatchObject({ id: 's2', latitude: null, geofenceRadiusM: 80 });
    // locationSource is not part of the cached shape
    expect(snap?.sites[0]).not.toHaveProperty('locationSource');
  });

  it('serves a fresh cache without fetching', async () => {
    request.mockResolvedValue(payload);
    await getLocationSites({ nowMs: NOW });
    request.mockClear();
    const snap = await getLocationSites({ nowMs: NOW + LOCATION_SITES_TTL_MS - 1000 });
    expect(request).not.toHaveBeenCalled();
    expect(snap?.sites).toHaveLength(2);
  });

  it('refetches a stale cache, and `force` bypasses a fresh one', async () => {
    request.mockResolvedValue(payload);
    await getLocationSites({ nowMs: NOW });
    await getLocationSites({ nowMs: NOW + LOCATION_SITES_TTL_MS + 1 });
    expect(request).toHaveBeenCalledTimes(2);
    await getLocationSites({ nowMs: NOW + LOCATION_SITES_TTL_MS + 2, force: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('returns the stale snapshot when the refetch fails', async () => {
    request.mockResolvedValueOnce(payload);
    await getLocationSites({ nowMs: NOW });
    request.mockRejectedValueOnce(new TypeError('Network request failed'));
    const snap = await getLocationSites({ nowMs: NOW + LOCATION_SITES_TTL_MS + 1 });
    expect(snap?.sites).toHaveLength(2);
  });

  it('returns null with no cache when the fetch fails', async () => {
    request.mockRejectedValue(new TypeError('Network request failed'));
    expect(await getLocationSites({ nowMs: NOW })).toBeNull();
  });

  it('a 403 returns null AND clears the cache', async () => {
    request.mockResolvedValueOnce(payload);
    await getLocationSites({ nowMs: NOW });
    request.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
    expect(await getLocationSites({ nowMs: NOW + LOCATION_SITES_TTL_MS + 1 })).toBeNull();
    expect(store.has(LOCATION_SITES_CACHE_KEY)).toBe(false);
  });

  it('caches enabled:false so a disabled partner is not re-fetched every foreground', async () => {
    request.mockResolvedValue({
      enabled: false,
      defaultRadiusM: 150,
      canSetLocation: false,
      sites: [],
      truncated: false,
    });
    const first = await getLocationSites({ nowMs: NOW });
    expect(first?.enabled).toBe(false);
    request.mockClear();
    const second = await getLocationSites({ nowMs: NOW + 60_000 });
    expect(request).not.toHaveBeenCalled();
    expect(second?.enabled).toBe(false);
  });

  it('treats a malformed response as a failed fetch', async () => {
    request.mockResolvedValue({ enabled: true });
    expect(await getLocationSites({ nowMs: NOW })).toBeNull();
  });

  it('ignores a corrupted cache entry', async () => {
    store.set(LOCATION_SITES_CACHE_KEY, '{nope');
    request.mockResolvedValue(payload);
    expect((await getLocationSites({ nowMs: NOW }))?.sites).toHaveLength(2);
  });
});

describe('invalidateLocationSites', () => {
  it('removes the cache so the next read refetches', async () => {
    request.mockResolvedValue(payload);
    await getLocationSites({ nowMs: NOW });
    await invalidateLocationSites();
    expect(store.has(LOCATION_SITES_CACHE_KEY)).toBe(false);
    await getLocationSites({ nowMs: NOW + 1000 });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
