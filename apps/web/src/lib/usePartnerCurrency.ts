// Partner billing currency, read once per page from `GET /orgs/partners/me`
// (`partners.currency_code`) and cached module-wide (lib/partnerCurrencyCache —
// reset on logout so a partner switch in the same tab never renders the
// previous partner's currency).
//
// `usePartnerCurrency(enabled?)` — typed state `{ currency, loading, failed,
// retry }` with deliberately NO `'USD'` fallback anywhere (#3777 review F8):
//
// - WRITERS of partner-currency money (catalog price book editor, distributor
//   import panels, margin previews) render a loading/disabled state while
//   `currency` is null — defaulting would mint USD price-book rows for a
//   non-USD partner (multi-currency wave 3, codex finding 4).
// - DISPLAY surfaces render the bare number with NO currency label until the
//   authoritative value is known. A EUR partner must never see a rate labelled
//   `$` because the fetch is slow, failed, or returned a malformed code.
//
// The returned code is validated against the shared currency list
// (`CURRENCY_CODES`); anything else is a failure, not a value.
import { useCallback, useEffect, useState } from 'react';
import { isKnownCurrency } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { partnerCurrencyCache, resetPartnerCurrencyCache } from './partnerCurrencyCache';

export { resetPartnerCurrencyCache };

export interface PartnerCurrencyState {
  /** Validated ISO 4217 code from `GET /orgs/partners/me`, or null while
   *  loading / after a failure. Null means UNKNOWN — never "assume USD". */
  currency: string | null;
  /** True while the authoritative value is being resolved (enabled, no
   *  value yet, not failed). Callers render no currency label in this state. */
  loading: boolean;
  /** True when the fetch failed (non-2xx, malformed / unknown code, or threw)
   *  — callers show an error or keep the unlabelled number, never a default. */
  failed: boolean;
  retry: () => void;
}

/** A currency is only accepted when it is on the shared curated list — a
 *  malformed or unknown code from the API is a failure, never cached. */
function normalize(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return code && isKnownCurrency(code) ? code : null;
}

/** Resolve (and cache) the partner currency. Only a RESOLVED code is cached: a
 *  rejected / 401 / non-OK / malformed response returns null and leaves the
 *  cache empty so the next mount (or `retry()`) fetches again.
 *
 *  Every request is bound to the cache generation it started in (review F7).
 *  If `resetPartnerCurrencyCache()` ran while it was in flight — logout, then
 *  a different partner logs in — its result is discarded: it commits nothing,
 *  its cleanup leaves the newer in-flight request alone, and the caller is
 *  re-resolved under the CURRENT generation so it never sees the old
 *  partner's currency. */
export async function loadPartnerCurrency(): Promise<string | null> {
  if (partnerCurrencyCache.value) return partnerCurrencyCache.value;
  const generation = partnerCurrencyCache.generation;
  if (!partnerCurrencyCache.inflight) {
    const request: Promise<string | null> = (async () => {
      let code: string | null = null;
      try {
        const res = await fetchWithAuth('/orgs/partners/me');
        if (res?.ok) {
          const body = (await res.json().catch(() => null)) as { currencyCode?: unknown } | null;
          code = normalize(body?.currencyCode);
        }
      } catch {
        code = null;
      }
      // Commit only while this request's generation is still current.
      if (code && partnerCurrencyCache.generation === generation) partnerCurrencyCache.value = code;
      return code;
    })().finally(() => {
      // Clear only OUR slot — after a reset the slot may hold a newer request.
      if (partnerCurrencyCache.inflight === request) partnerCurrencyCache.inflight = null;
    });
    partnerCurrencyCache.inflight = request;
  }
  const code = await partnerCurrencyCache.inflight;
  // Reset happened while we waited: this result belongs to the old partner.
  // Resolve again under the current generation instead of returning it.
  if (partnerCurrencyCache.generation !== generation) return loadPartnerCurrency();
  return code;
}

export function usePartnerCurrency(enabled = true): PartnerCurrencyState {
  const [currency, setCurrency] = useState<string | null>(() => partnerCurrencyCache.value);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || currency !== null) return;
    let cancelled = false;
    setFailed(false);
    void loadPartnerCurrency().then((code) => {
      if (cancelled) return;
      if (code) setCurrency(code);
      else setFailed(true);
    });
    return () => { cancelled = true; };
    // `attempt` re-runs the fetch on retry().
  }, [enabled, currency, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { currency, loading: enabled && currency === null && !failed, failed, retry };
}
