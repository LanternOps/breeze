// Partner billing currency, read once per page from `GET /orgs/partners/me`
// (`partners.currency_code`) and cached module-wide (lib/partnerCurrencyCache —
// reset on logout so a partner switch in the same tab never renders the
// previous partner's currency).
//
// Two hooks share the cache:
//
// - `usePartnerCurrency(enabled?)` — typed state `{ currency, failed, retry }`
//   with deliberately NO `'USD'` fallback. Use it on every surface that WRITES
//   money in the partner currency (catalog price book editor, distributor
//   import panels, margin previews): defaulting would mint USD price-book rows
//   for a non-USD partner (multi-currency wave 3, codex finding 4). While
//   `currency` is null the caller renders a loading/disabled state.
// - `usePartnerCurrencyOrDefault()` — plain string, `'USD'` until loaded. Only
//   for DISPLAY of pre-wave rows that carry no currency of their own (partner
//   ticket-category rates until wave 4 stamps them); labelling them with the
//   partner default beats the old hard-coded `$`.
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';
import { DEFAULT_PARTNER_CURRENCY, partnerCurrencyCache, resetPartnerCurrencyCache } from './partnerCurrencyCache';

export { resetPartnerCurrencyCache };

export interface PartnerCurrencyState {
  /** ISO 4217 code from `GET /orgs/partners/me`, or null until it resolves. */
  currency: string | null;
  /** True when the fetch failed (non-2xx, malformed, or threw) — callers show
   *  an error instead of an endless loading state. */
  failed: boolean;
  retry: () => void;
}

function normalize(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : null;
}

/** Resolve (and cache) the partner currency. Only a RESOLVED code is cached: a
 *  rejected / 401 / non-OK / malformed response returns null and leaves the
 *  cache empty so the next mount (or `retry()`) fetches again. */
export async function loadPartnerCurrency(): Promise<string | null> {
  if (partnerCurrencyCache.value) return partnerCurrencyCache.value;
  if (!partnerCurrencyCache.inflight) {
    partnerCurrencyCache.inflight = (async () => {
      try {
        const res = await fetchWithAuth('/orgs/partners/me');
        if (!res?.ok) return null;
        const body = (await res.json().catch(() => null)) as { currencyCode?: unknown } | null;
        const code = normalize(body?.currencyCode);
        if (code) partnerCurrencyCache.value = code;
        return code;
      } catch {
        return null;
      } finally {
        partnerCurrencyCache.inflight = null;
      }
    })();
  }
  return partnerCurrencyCache.inflight;
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

  return { currency, failed, retry };
}

/** Display-only: the partner currency, or `'USD'` until it resolves. Never use
 *  the returned value to WRITE a price — see `usePartnerCurrency`. */
export function usePartnerCurrencyOrDefault(): string {
  const { currency } = usePartnerCurrency();
  return currency ?? DEFAULT_PARTNER_CURRENCY;
}
