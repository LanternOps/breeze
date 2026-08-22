// Partner default currency for surfaces whose rows carry no currency of their
// own yet: catalog prices (wave 3 adds per-item price books) and partner-level
// ticket-category rates (wave 4 adds rate currencies). Pre-wave rows store no
// currency, so the partner default that applied at their creation is the only
// context they have — labelling them with it beats the old hard-coded `$`.
//
// Fetches `/orgs/partners/me` once per page (module-level cache of the resolved
// value only) and returns `'USD'` until loaded. 401 → stays `'USD'`; the
// page-level auth redirect handles the session.
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';
import { DEFAULT_PARTNER_CURRENCY, partnerCurrencyCache, resetPartnerCurrencyCache } from './partnerCurrencyCache';

export { resetPartnerCurrencyCache };

function normalize(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : DEFAULT_PARTNER_CURRENCY;
}

export async function loadPartnerCurrency(): Promise<string | null> {
  if (partnerCurrencyCache.value) return partnerCurrencyCache.value;
  if (!partnerCurrencyCache.inflight) {
    partnerCurrencyCache.inflight = (async () => {
      try {
        const res = await fetchWithAuth('/orgs/partners/me');
        if (!res?.ok) return null;
        const body = (await res.json()) as { currencyCode?: unknown } | null;
        const code = normalize(body?.currencyCode);
        partnerCurrencyCache.value = code;
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

export function usePartnerCurrency(): string {
  const [code, setCode] = useState<string>(() => partnerCurrencyCache.value ?? DEFAULT_PARTNER_CURRENCY);
  useEffect(() => {
    let active = true;
    void loadPartnerCurrency().then((resolved) => {
      if (active && resolved) setCode(resolved);
    });
    return () => { active = false; };
  }, []);
  return code;
}
