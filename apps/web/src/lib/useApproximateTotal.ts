// Async state for the optional "≈ approximate total" line (multi-currency
// spec §8, wave 7 / #3779).
//
// The hook fetches; it does NOT convert. `GET /billing/reporting-totals`
// converts server-side through `convertForReporting` so there is exactly one
// implementation of reporting money math and no converted figure is ever
// computed in the browser (where a document editor could reuse it).
//
// Deliberately NO `usePartnerCurrency` in this chain: that hook reads
// `GET /orgs/partners/me`, which is partner-scope only, so an ORGANIZATION
// scoped viewer — precisely the reader of the most cross-currency data — would
// get a 403 and silently lose the line. The endpoint derives the target
// currency from the actor's partner and returns it as `targetCurrencyCode`.
// There is no client-side default and no 'USD' fallback anywhere here.
//
// Failure is always quiet: `failed` means "render segmentation only". A
// partner with no reporting currency answers 409 NO_REPORTING_CURRENCY, which
// is a configuration state, not an error to surface.
import { useEffect, useState } from 'react';

import { fetchWithAuth } from '../stores/auth';
import { approximateTotalCache, approximateTotalCacheKey, resetApproximateTotalCache } from './approximateTotalCache';
import { buildGroupsParam, type ReportingTotalResponse } from './reporting/approximateTotal';

export { resetApproximateTotalCache };

export interface ApproximateTotalState {
  /** The server's validated answer, or null while loading / after a failure.
   *  `status: 'unavailable'` is an ANSWER (a leg was missing or stale), not a
   *  failure — the caller renders nothing either way. */
  response: ReportingTotalResponse | null;
  /** True while a request for this key is in flight. Callers render nothing. */
  loading: boolean;
  /** True when the request could not produce an answer (non-2xx, rejected, or
   *  malformed). Callers render the per-currency segmentation only. */
  failed: boolean;
}

const IDLE: ApproximateTotalState = { response: null, loading: false, failed: false };

const STATUSES = new Set(['available', 'unavailable', 'not-needed']);

/** A body is only accepted when it structurally matches the endpoint's
 *  contract — anything else is a failure, never cached, so a proxy error page
 *  or a shape drift can't become a rendered money figure. */
function validate(raw: unknown): ReportingTotalResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.status !== 'string' || !STATUSES.has(body.status)) return null;
  if (typeof body.targetCurrencyCode !== 'string' || !body.targetCurrencyCode) return null;
  if (typeof body.requestedDate !== 'string') return null;
  if (typeof body.maxStalenessDays !== 'number') return null;
  if (body.rateDate !== null && typeof body.rateDate !== 'string') return null;
  if (body.total !== null && typeof body.total !== 'string') return null;
  if (!Array.isArray(body.groups)) return null;
  if (!Array.isArray(body.unavailableCurrencyCodes)) return null;
  if (body.status === 'available' && (typeof body.total !== 'string' || typeof body.rateDate !== 'string')) return null;
  return body as unknown as ReportingTotalResponse;
}

/** Today in UTC — the same calendar basis the server ages rates on, so a
 *  browser east or west of UTC can't ask for a date the feed has no row for. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve (and cache) one reporting total. Concurrent callers with the same
 * key share ONE request: six rollup surfaces on a dashboard must not fire six
 * identical conversions.
 *
 * `to` is deliberately never sent — the server owns the target currency.
 */
export async function loadApproximateTotal(
  groupsParam: string,
  date: string,
): Promise<ReportingTotalResponse | null> {
  // Keyed through the cache module so a partner reporting-currency change
  // drops entries denominated in the previous currency (see its comment).
  const key = approximateTotalCacheKey(date, groupsParam);
  const cached = approximateTotalCache.values.get(key);
  if (cached) return cached;

  const generation = approximateTotalCache.generation;
  let request = approximateTotalCache.inflight.get(key);
  if (!request) {
    const started: Promise<ReportingTotalResponse | null> = (async () => {
      let result: ReportingTotalResponse | null = null;
      try {
        const params = new URLSearchParams({ groups: groupsParam, date });
        // `skipOrgIdInjection` is REQUIRED, not an optimization: fetchWithAuth
        // appends `&orgId=<uuid>` whenever the org store has a selected org
        // (stores/auth.ts), and `reportingTotalsQuerySchema` is `.strict()`, so
        // the injected key would 400 every request a partner user with an org
        // selected — or any organization-scoped user — makes. Because failure
        // here is deliberately quiet, that 400 would show up as the line simply
        // never rendering, with no signal. The endpoint has no org semantics to
        // narrow: the figures are the caller's own `groups` and the target
        // currency comes from the actor's partner, so opting out is exact.
        // Fixed HERE rather than by relaxing `.strict()` — a money endpoint must
        // keep rejecting mis-keyed params instead of silently defaulting.
        const res = await fetchWithAuth(`/billing/reporting-totals?${params.toString()}`, { skipOrgIdInjection: true });
        if (res?.ok) {
          const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
          result = validate(body?.data);
        }
      } catch {
        // A rejected fetch (session expired, offline) is a quiet failure: the
        // approximate line is optional and never blocks a rollup surface.
        result = null;
      }
      // Commit only while this request's generation is still current.
      if (result && approximateTotalCache.generation === generation) {
        approximateTotalCache.values.set(key, result);
      }
      return result;
    })().finally(() => {
      // Clear only OUR slot — after a reset the map may hold a newer request.
      if (approximateTotalCache.inflight.get(key) === started) approximateTotalCache.inflight.delete(key);
    });
    request = started;
    approximateTotalCache.inflight.set(key, started);
  }

  const result = await request;
  // A reset happened while we waited: this answer belongs to the previous
  // partner. Discard it rather than render another tenant's converted money.
  if (approximateTotalCache.generation !== generation) return null;
  return result;
}

export function useApproximateTotal(
  byCurrency: readonly { code: string; amount: string | number }[],
  date?: string,
): ApproximateTotalState {
  const groupsParam = buildGroupsParam(byCurrency);
  const requestDate = date ?? todayUtc();
  const key = groupsParam ? approximateTotalCacheKey(requestDate, groupsParam) : '';

  const [state, setState] = useState<ApproximateTotalState>(() => {
    const cached = key ? approximateTotalCache.values.get(key) : undefined;
    return cached ? { response: cached, loading: false, failed: false } : IDLE;
  });

  useEffect(() => {
    // Nothing to ask about (empty book, or every entry malformed): no request,
    // no loading state, no line.
    if (!groupsParam) {
      setState(IDLE);
      return;
    }

    const cached = approximateTotalCache.values.get(key);
    if (cached) {
      setState({ response: cached, loading: false, failed: false });
      return;
    }

    let cancelled = false;
    setState({ response: null, loading: true, failed: false });
    void loadApproximateTotal(groupsParam, requestDate).then((response) => {
      if (cancelled) return;
      setState(response
        ? { response, loading: false, failed: false }
        : { response: null, loading: false, failed: true });
    });
    return () => { cancelled = true; };
  }, [key, groupsParam, requestDate]);

  return state;
}
