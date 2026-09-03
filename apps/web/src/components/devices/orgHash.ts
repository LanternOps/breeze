// The org a coverage-notice deep link pins the devices list to (#3205 W06).
// Hash state (never query params) per CLAUDE.md, and a distinct `orgId=` key
// that cooperates with filterUrl.ts and deviceClassFilter.ts — each writer
// preserves the other's fragments.
//
// READ-ONLY on purpose: the org SELECTOR owns the store, so this page never
// writes the fragment back. A mirror writer would fight the selector for
// ownership of the same key.
import { useEffect, useLayoutEffect } from 'react';
import { useOrgStore } from '../../stores/orgStore';

const HASH_KEY = 'orgId';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readOrgIdFromHash(hash: string): string | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of raw.split('&')) {
    const [k, v] = part.split('=');
    if (k === HASH_KEY && v && UUID_RE.test(v)) return v;
  }
  return null;
}

// useLayoutEffect warns during SSR (it is a no-op there); useEffect is the
// server-safe stand-in — the useHashState.ts (#2421) convention.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Adopt `#orgId=<uuid>` into the org store. A LAYOUT effect, and that is
 * load-bearing: React runs every layout effect in a commit before any passive
 * effect, and useAdvancedFilterIds' preview fetch is a passive effect keyed on
 * the FILTER alone (useAdvancedFilterIds.ts:40) — it never re-runs when the org
 * changes, so a preview that fired first would be computed against the wrong org
 * and never corrected. Pinned by DevicesPage.deepLink.test.tsx.
 *
 * Safety: the hash cannot widen access. /filters/preview validates the pinned
 * org with ensureOrgAccess and 403s otherwise (routes/filters.ts:142-148), the
 * list is org-scoped by the same auth, and an org the user cannot see is reset
 * by the store's next fetchOrganizations (orgStore.ts:259-261). The uuid shape
 * is validated before the store is touched.
 */
export function useOrgIdFromHash(): void {
  useIsomorphicLayoutEffect(() => {
    const apply = () => {
      const id = readOrgIdFromHash(window.location.hash);
      if (!id) return;
      const { currentOrgId, selectOrganization } = useOrgStore.getState();
      if (id !== currentOrgId) selectOrganization(id);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);
}
