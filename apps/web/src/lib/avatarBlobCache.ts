import { useEffect, useState } from 'react';

import { fetchWithAuth } from '../stores/auth';
import { sanitizeImageSrc } from './safeImageSrc';

/**
 * Avatar render bug:
 * `users.avatar_url` is now an internal authenticated path like
 * `/api/v1/users/<id>/avatar`. `<img src=...>` can't send the Bearer token,
 * so the request hits the API as unauth and 401s, breaking the avatar
 * everywhere (topbar, portal header, profile page).
 *
 * Workaround: fetch the bytes with fetchWithAuth, wrap them in an object URL,
 * and feed the object URL to `<img>`. This module owns a small in-memory
 * cache keyed by the input URL so opening multiple components on the same
 * page doesn't re-fetch.
 *
 * External URLs (legacy Gravatar-style rows) pass through after sanitization,
 * since the browser can request them directly without our auth.
 */

const INTERNAL_AVATAR_PREFIX = '/api/v1/users/';

type CacheEntry = {
  objectUrl: string | null; // null = fetch in-flight or failed-as-null
  promise: Promise<string | null> | null;
  refCount: number;
};

const cache = new Map<string, CacheEntry>();

function isInternalAvatarUrl(url: string): boolean {
  return url.startsWith(INTERNAL_AVATAR_PREFIX);
}

async function fetchAvatarBlob(url: string): Promise<string | null> {
  try {
    const response = await fetchWithAuth(url);
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function acquire(url: string): Promise<string | null> {
  let entry = cache.get(url);
  if (entry) {
    entry.refCount += 1;
    if (entry.objectUrl) {
      return Promise.resolve(entry.objectUrl);
    }
    if (entry.promise) {
      return entry.promise;
    }
    // Previously-failed entry: retry, since refcount went 0→1.
    const promise = fetchAvatarBlob(url).then((objectUrl) => {
      const e = cache.get(url);
      if (e) {
        e.objectUrl = objectUrl;
        e.promise = null;
      }
      return objectUrl;
    });
    entry.promise = promise;
    return promise;
  }

  const newEntry: CacheEntry = {
    objectUrl: null,
    promise: null,
    refCount: 1,
  };
  cache.set(url, newEntry);
  const promise = fetchAvatarBlob(url).then((objectUrl) => {
    const e = cache.get(url);
    if (e) {
      e.objectUrl = objectUrl;
      e.promise = null;
    }
    return objectUrl;
  });
  newEntry.promise = promise;
  return promise;
}

function release(url: string): void {
  const entry = cache.get(url);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    if (entry.objectUrl) {
      URL.revokeObjectURL(entry.objectUrl);
    }
    cache.delete(url);
  }
}

/**
 * Test-only: clear the cache without revoking, so tests start clean.
 * Production callers should never need this.
 */
export function __resetAvatarBlobCacheForTests(): void {
  for (const [, entry] of cache) {
    if (entry.objectUrl) {
      // Best-effort revoke; jsdom stubs may be vi.fn() noops.
      URL.revokeObjectURL(entry.objectUrl);
    }
  }
  cache.clear();
}

/**
 * Resolve an avatar URL to a value safe to use in `<img src>`.
 *
 * - null / empty input → null (caller renders initials fallback)
 * - Internal `/api/v1/users/...` path → blob: URL after auth'd fetch, or null on 401/404/network error
 * - External URL → original URL after `sanitizeImageSrc` (rejects javascript:/data:text/html/etc)
 *
 * Cache: shared across components for the lifetime of the page; revoked when
 * the last consumer unmounts.
 */
export function useAvatarBlobUrl(avatarUrl: string | null | undefined): string | null {
  const [resolved, setResolved] = useState<string | null>(() => {
    if (!avatarUrl) return null;
    if (isInternalAvatarUrl(avatarUrl)) {
      const entry = cache.get(avatarUrl);
      return entry?.objectUrl ?? null;
    }
    return sanitizeImageSrc(avatarUrl);
  });

  useEffect(() => {
    if (!avatarUrl) {
      setResolved(null);
      return;
    }

    if (!isInternalAvatarUrl(avatarUrl)) {
      setResolved(sanitizeImageSrc(avatarUrl));
      return;
    }

    let cancelled = false;
    // Start in a loading-but-not-broken state: null shows initials briefly.
    const cached = cache.get(avatarUrl);
    setResolved(cached?.objectUrl ?? null);

    void acquire(avatarUrl).then((objectUrl) => {
      if (!cancelled) {
        setResolved(objectUrl);
      }
    });

    return () => {
      cancelled = true;
      release(avatarUrl);
    };
  }, [avatarUrl]);

  return resolved;
}
