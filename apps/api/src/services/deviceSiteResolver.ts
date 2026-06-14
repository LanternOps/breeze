/**
 * deviceSiteResolver
 *
 * Resolves a device's `siteId` for event-publish-time site attribution.
 *
 * Why this exists
 * ---------------
 * The events-WS layer (`routes/eventWs.ts`) must deliver in-site live events to
 * site-restricted users (the app-layer SITE-scope axis). The WS dispatch path is
 * synchronous and cannot do a DB lookup per event, so the `siteId` has to be on
 * the wire at publish time (issue #1280, follow-up to #1278). Most device-scoped
 * publishers (alert.triggered, session.login, device.offline, …) only carry a
 * `deviceId`, so they need a cheap deviceId → siteId resolution at publish time.
 *
 * A device's site assignment changes rarely (only on an explicit move), so a
 * short-lived in-process cache keeps this off the hot path without serving stale
 * site attribution for any meaningful window. A cache miss falls back to a single
 * indexed primary-key lookup. Resolution never throws — a failure yields
 * `undefined` (org-level / no attribution), which the WS filter treats as
 * fail-closed for site-restricted users and is a no-op for unrestricted users.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';

const CACHE_TTL_MS = 60 * 1000; // 1 minute — site assignment changes are rare
const MAX_CACHE_ENTRIES = 50_000; // bound memory on large fleets

interface CacheEntry {
  siteId: string | undefined;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(deviceId: string): CacheEntry | undefined {
  const entry = cache.get(deviceId);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(deviceId);
    return undefined;
  }
  return entry;
}

function setCached(deviceId: string, siteId: string | undefined): void {
  // Cheap size bound: when full, evict the oldest insertion (Map preserves
  // insertion order). Avoids unbounded growth without a full LRU.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(deviceId, { siteId, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Resolve a device's `siteId` for event publishing. Returns `undefined` when the
 * device is unknown or the lookup fails — never throws.
 */
export async function resolveDeviceSiteId(
  deviceId: string | null | undefined,
): Promise<string | undefined> {
  if (!deviceId) return undefined;

  const cached = getCached(deviceId);
  if (cached) return cached.siteId;

  try {
    const [row] = await db
      .select({ siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    const siteId = row?.siteId ?? undefined;
    setCached(deviceId, siteId);
    return siteId;
  } catch (err) {
    // Fail open to "no attribution": the event still publishes (org-level), it
    // just won't reach site-restricted users until a later event carries siteId.
    console.warn(
      '[deviceSiteResolver] failed to resolve siteId for device',
      deviceId,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/** @internal Test-only: clear the in-process cache. */
export function _clearDeviceSiteCache(): void {
  cache.clear();
}

/** @internal Test-only: prime the cache directly (avoids a DB round-trip). */
export function _primeDeviceSiteCache(deviceId: string, siteId: string | undefined): void {
  setCached(deviceId, siteId);
}
