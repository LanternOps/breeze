// Partner entitlements for the signed-in partner, read once per page from
// `GET /partner/me/entitlements` and cached module-wide (lib/entitlementsCache —
// reset on logout so a partner switch in the same tab never shows the previous
// partner's features).
//
// FAIL CLOSED (D10): a failed / non-2xx / malformed response is never treated
// as "enabled". `useEntitlement(key).state` stays `'loading'` until a real
// snapshot arrives; a key the API did not return (older API) is `'locked'`.
import { useCallback, useEffect, useState } from 'react';
import type { EntitlementKey } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { useJwtClaims } from '../lib/authScope';
import {
  entitlementsCache,
  resetEntitlementsCache,
  subscribeEntitlementsCache,
  type ClientEntitlement,
  type EntitlementsSnapshot,
} from '../lib/entitlementsCache';

export { resetEntitlementsCache };
export type { ClientEntitlement, EntitlementsSnapshot };

const STATES = new Set(['enabled', 'disabled']);
const SOURCES = new Set(['plan', 'billing', 'license', 'manual']);

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Accept only a well-formed snapshot; anything else is a failure, not a value. */
function normalize(raw: unknown): EntitlementsSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as { plan?: unknown; entitlements?: unknown };
  if (typeof body.plan !== 'string' || !Array.isArray(body.entitlements)) return null;
  const entitlements: ClientEntitlement[] = [];
  for (const item of body.entitlements) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.key !== 'string' || !STATES.has(e.state as string) || !SOURCES.has(e.source as string)) continue;
    entitlements.push({
      key: e.key,
      label: str(e.label) ?? e.key,
      why: str(e.why) ?? '',
      state: e.state as ClientEntitlement['state'],
      source: e.source as ClientEntitlement['source'],
      limits: e.limits ?? null,
      expiresAt: str(e.expiresAt),
      graceUntil: str(e.graceUntil),
      reason: str(e.reason),
    });
  }
  return { plan: body.plan, entitlements };
}

/** Resolve (and cache) the entitlement snapshot. Generation-bound like
 *  `loadPartnerCurrency`: a request that outlives a reset commits nothing and
 *  the caller is re-resolved under the current generation. */
export async function loadEntitlements(): Promise<EntitlementsSnapshot | null> {
  if (entitlementsCache.value) return entitlementsCache.value;
  const generation = entitlementsCache.generation;
  if (!entitlementsCache.inflight) {
    const request: Promise<EntitlementsSnapshot | null> = (async () => {
      let snapshot: EntitlementsSnapshot | null = null;
      try {
        const res = await fetchWithAuth('/partner/me/entitlements');
        if (res?.ok) {
          snapshot = normalize(await res.json().catch(() => null));
          if (!snapshot) console.warn('[entitlements] malformed /partner/me/entitlements response');
        } else {
          console.warn(`[entitlements] /partner/me/entitlements failed (${res?.status ?? 'no response'})`);
        }
      } catch (err) {
        console.warn('[entitlements] /partner/me/entitlements request failed', err);
        snapshot = null;
      }
      if (snapshot && entitlementsCache.generation === generation) entitlementsCache.value = snapshot;
      return snapshot;
    })().finally(() => {
      if (entitlementsCache.inflight === request) entitlementsCache.inflight = null;
    });
    entitlementsCache.inflight = request;
  }
  const snapshot = await entitlementsCache.inflight;
  if (entitlementsCache.generation !== generation) return loadEntitlements();
  return snapshot;
}

export type UseEntitlementsResult = {
  snapshot: EntitlementsSnapshot | null;
  loading: boolean;
  failed: boolean;
  reload: () => void;
};

export function useEntitlements(): UseEntitlementsResult {
  const claims = useJwtClaims();
  const ready = claims.status === 'resolved';
  const [snapshot, setSnapshot] = useState<EntitlementsSnapshot | null>(() => entitlementsCache.value);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A logout reset drops the previous partner's snapshot from mounted hooks.
  useEffect(
    () =>
      subscribeEntitlementsCache(() => {
        setSnapshot(null);
        setFailed(false);
        setAttempt((n) => n + 1);
      }),
    [],
  );

  useEffect(() => {
    if (!ready || snapshot !== null) return;
    let cancelled = false;
    setFailed(false);
    void loadEntitlements().then((next) => {
      if (cancelled) return;
      if (next) setSnapshot(next);
      else setFailed(true);
    });
    return () => { cancelled = true; };
    // `attempt` re-runs the fetch on reload() and after a reset.
  }, [ready, snapshot, attempt]);

  const reload = useCallback(() => {
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);

  return { snapshot, loading: snapshot === null && !failed, failed, reload };
}

export type UseEntitlementResult = {
  /** Never 'enabled' on a failed load — see `failed` to tell a stuck load apart. */
  state: 'loading' | 'enabled' | 'locked';
  /** The last load failed (state stays 'loading'); offer `reload()` instead of a spinner. */
  failed: boolean;
  limits: unknown | null;
  source: ClientEntitlement['source'] | null;
  why: string | null;
  graceUntil: string | null;
  reload: () => void;
};

export function useEntitlement(key: EntitlementKey): UseEntitlementResult {
  const { snapshot, failed, reload } = useEntitlements();
  if (!snapshot) {
    return { state: 'loading', failed, limits: null, source: null, why: null, graceUntil: null, reload };
  }
  const entry = snapshot.entitlements.find((e) => e.key === key);
  if (!entry) {
    return { state: 'locked', failed: false, limits: null, source: null, why: null, graceUntil: null, reload };
  }
  return {
    state: entry.state === 'enabled' ? 'enabled' : 'locked',
    failed: false,
    limits: entry.limits,
    source: entry.source,
    why: entry.why,
    graceUntil: entry.graceUntil,
    reload,
  };
}
