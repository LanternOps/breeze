import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { useApproximateTotal, resetApproximateTotalCache } from '../useApproximateTotal';
import { approximateTotalCache } from '../approximateTotalCache';
import { partnerCurrencyCache, resetPartnerCurrencyCache } from '../partnerCurrencyCache';
import type { ReportingTotalResponse } from '@/lib/reporting/approximateTotal';
import { reportingTotalsQuerySchema } from '@breeze/shared';

const jsonRes = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload }) as Response;

const AVAILABLE: ReportingTotalResponse = {
  status: 'available',
  targetCurrencyCode: 'CAD',
  requestedDate: '2026-08-21',
  maxStalenessDays: 7,
  rateDate: '2026-08-21',
  total: '22940.00',
  groups: [
    { currencyCode: 'EUR', amount: '4100.00', convertedAmount: '6440.00', rate: '1.57073170', rateDate: '2026-08-21', source: 'ecb' },
    { currencyCode: 'USD', amount: '12300.00', convertedAmount: '16500.00', rate: '1.34146341', rateDate: '2026-08-21', source: 'ecb' },
  ],
  unavailableCurrencyCodes: [],
};

const BOOK = [{ code: 'USD', amount: '12300.00' }, { code: 'EUR', amount: '4100.00' }];

function Probe({ id = 'state', book = BOOK, date }: {
  id?: string;
  book?: readonly { code: string; amount: string | number }[];
  date?: string;
}) {
  const { response, loading, failed } = useApproximateTotal(book, date);
  return (
    <div
      data-testid={id}
      data-loading={String(loading)}
      data-failed={String(failed)}
    >
      {response ? `${response.status}:${response.total ?? '-'}:${response.targetCurrencyCode}` : 'null'}
    </div>
  );
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  resetApproximateTotalCache();
  vi.useRealTimers();
});

describe('useApproximateTotal — request shape', () => {
  it('requests /billing/reporting-totals with the built groups param and the given date, and NO `to`', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    render(<Probe date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    const url = String(fetchWithAuth.mock.calls[0][0]);
    expect(url.startsWith('/billing/reporting-totals?')).toBe(true);
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    // buildGroupsParam output: sorted, deduplicated, `CODE:amount` joined by ','.
    expect(params.get('groups')).toBe('EUR:4100.00,USD:12300.00');
    expect(params.get('date')).toBe('2026-08-21');
    // The SERVER derives the reporting currency (organization-scoped viewers
    // cannot read /orgs/partners/me) — the client must never name a target.
    expect(params.has('to')).toBe(false);
    expect(url).not.toContain('USD:0');
  });

  it('defaults the date to today in UTC when the caller gives none', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    render(<Probe />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    const params = new URLSearchParams(String(fetchWithAuth.mock.calls[0][0]).split('?')[1]);
    expect(params.get('date')).toBe(new Date().toISOString().slice(0, 10));
  });

  it('does not fetch at all for an empty book', async () => {
    render(<Probe book={[]} />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.loading).toBe('false'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.getByTestId('state').textContent).toBe('null');
    expect(screen.getByTestId('state').dataset.failed).toBe('false');
  });

  // An empty book and an UNUSABLE one both skip the request, but they are not
  // the same answer: one has nothing to say, the other has something it failed
  // to say. Collapsing them is what let a credit note pushing a currency
  // negative silently erase the line (#4415), so the split is asserted here at
  // the hook layer, not just at the component that renders it.
  it('reports FAILED — not idle — when the book cannot be encoded at all', async () => {
    render(<Probe book={[{ code: 'USD', amount: 'not-a-number' }, { code: '', amount: '1.00' }]} />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.loading).toBe('false'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.getByTestId('state').dataset.failed).toBe('true');
    expect(screen.getByTestId('state').textContent).toBe('null');
  });

  it('reports FAILED for a single negative leg — a credit note must not erase the line', async () => {
    render(<Probe book={[{ code: 'USD', amount: '100.00' }, { code: 'EUR', amount: -5 }]} />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.loading).toBe('false'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.getByTestId('state').dataset.failed).toBe('true');
  });

  it('goes back to a real request once an unusable book becomes usable again', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    const { rerender } = render(<Probe book={[{ code: 'USD', amount: -1 }]} />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.failed).toBe('true'));

    rerender(<Probe book={BOOK} date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.failed).toBe('false'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('never sends a currency the caller did not provide, and never substitutes USD', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: { ...AVAILABLE, groups: [] } }));
    render(<Probe book={[{ code: 'gbp', amount: '10.00' }]} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    const url = String(fetchWithAuth.mock.calls[0][0]);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('groups')).toBe('GBP:10.00');
    expect(url).not.toContain('USD');
    expect(params.has('to')).toBe(false);
  });
});

describe('useApproximateTotal — caching and de-duplication', () => {
  it('two components mounted with the same key share ONE in-flight request', async () => {
    let resolve: (r: Response) => void = () => {};
    fetchWithAuth.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    render(<><Probe id="a" date="2026-08-21" /><Probe id="b" date="2026-08-21" /></>);
    expect(screen.getByTestId('a').dataset.loading).toBe('true');
    expect(screen.getByTestId('b').dataset.loading).toBe('true');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    resolve(jsonRes({ data: AVAILABLE }));
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:22940.00:CAD'));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('available:22940.00:CAD'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('a later mount with the same key is served from the cache without a second request', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    const first = render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:22940.00:CAD'));
    first.unmount();

    render(<Probe id="b" date="2026-08-21" />);
    expect(screen.getByTestId('b').textContent).toBe('available:22940.00:CAD');
    expect(screen.getByTestId('b').dataset.loading).toBe('false');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('a different book (or date) is a different key and fetches again', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    render(<Probe id="b" date="2026-08-20" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    render(<Probe id="c" book={[{ code: 'USD', amount: '1.00' }]} date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(3));
  });

  it('resetApproximateTotalCache() clears cached results so the next mount refetches', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    const first = render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:22940.00:CAD'));
    first.unmount();

    resetApproximateTotalCache();
    expect(approximateTotalCache.values.size).toBe(0);

    render(<Probe id="b" date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
  });

  it('a response that arrives after a reset is discarded, never committed to the new cache', async () => {
    let resolve: (r: Response) => void = () => {};
    fetchWithAuth.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    resetApproximateTotalCache();
    resolve(jsonRes({ data: AVAILABLE }));
    await waitFor(() => expect(screen.getByTestId('a').dataset.loading).toBe('false'));
    expect(approximateTotalCache.values.size).toBe(0);
  });
});

describe('useApproximateTotal — failure semantics', () => {
  it.each([403, 500, 502])('a %i response sets failed, leaves response null and caches nothing', async (status) => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: { code: 'BOOM' } }, status));
    render(<Probe date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.failed).toBe('true'));
    expect(screen.getByTestId('state').textContent).toBe('null');
    expect(screen.getByTestId('state').dataset.loading).toBe('false');
    expect(approximateTotalCache.values.size).toBe(0);
  });

  it('a 409 NO_REPORTING_CURRENCY is a quiet `failed` — no throw, no error surfaced', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(
      { error: { code: 'NO_REPORTING_CURRENCY', message: 'No reporting currency is configured for this partner' } },
      409,
    ));
    render(<Probe date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.failed).toBe('true'));
    expect(screen.getByTestId('state').textContent).toBe('null');
    expect(approximateTotalCache.values.size).toBe(0);
  });

  it('a rejected fetch (session expired) is `failed`, never an unhandled rejection', async () => {
    fetchWithAuth.mockRejectedValue(new Error('session expired'));
    render(<Probe date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.failed).toBe('true'));
    expect(screen.getByTestId('state').textContent).toBe('null');
  });

  it('a malformed 200 body is a failure and is NOT cached', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: { status: 'weird', total: 12 } }));
    render(<Probe date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.failed).toBe('true'));
    expect(approximateTotalCache.values.size).toBe(0);
  });

  it('a failed request is retried on the next mount (only validated results are cached)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: { code: 'BOOM' } }, 500));
    const first = render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('a').dataset.failed).toBe('true'));
    first.unmount();

    fetchWithAuth.mockResolvedValueOnce(jsonRes({ data: AVAILABLE }));
    render(<Probe id="b" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('available:22940.00:CAD'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('caches an `unavailable` result — it is a valid answer, not a failure', async () => {
    const unavailable: ReportingTotalResponse = {
      ...AVAILABLE,
      status: 'unavailable',
      rateDate: null,
      total: null,
      unavailableCurrencyCodes: ['EUR'],
    };
    fetchWithAuth.mockResolvedValue(jsonRes({ data: unavailable }));
    const first = render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('unavailable:-:CAD'));
    expect(screen.getByTestId('a').dataset.failed).toBe('false');
    first.unmount();

    render(<Probe id="b" date="2026-08-21" />);
    expect(screen.getByTestId('b').textContent).toBe('unavailable:-:CAD');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// fetchWithAuth auto-injects `?orgId=<uuid>` whenever the org store has a
// selected org (stores/auth.ts — `if (orgId && !options.skipOrgIdInjection &&
// !url.includes('orgId='))`). `reportingTotalsQuerySchema` is `.strict()`, so
// an injected key is a 400 `Unrecognized key: "orgId"` — and because failure
// here is deliberately QUIET, the approximate line would simply never render
// for a partner user with an org selected, or for any org-scoped user, with no
// signal anywhere. The endpoint has no org semantics at all (the figures come
// from the caller's own `groups`, the target from the actor's partner), so the
// hook opts OUT of injection rather than the schema relaxing `.strict()`.
// ---------------------------------------------------------------------------
describe('useApproximateTotal — orgId injection (the request must survive an active org selection)', () => {
  const SELECTED_ORG_ID = '11111111-2222-4333-8444-555555555555';

  /** Exactly the rule stores/auth.ts applies before dispatching. */
  function injectOrgId(rawUrl: string, options?: { skipOrgIdInjection?: boolean }): string {
    if (options?.skipOrgIdInjection || rawUrl.includes('orgId=')) return rawUrl;
    return `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}orgId=${SELECTED_ORG_ID}`;
  }

  it('opts out of injection so the strict query schema accepts the dispatched URL', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    render(<Probe date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    const [rawUrl, options] = fetchWithAuth.mock.calls[0] as [string, { skipOrgIdInjection?: boolean } | undefined];
    expect(options?.skipOrgIdInjection).toBe(true);

    const dispatched = injectOrgId(rawUrl, options);
    expect(dispatched).not.toContain('orgId=');

    const query = Object.fromEntries(new URLSearchParams(dispatched.split('?')[1]));
    expect(reportingTotalsQuerySchema.safeParse(query).success).toBe(true);
  });

  it('proves the trap is real: the same request WITH the injected orgId is rejected by the schema', () => {
    const injected = injectOrgId('/billing/reporting-totals?groups=EUR:4100.00,USD:12300.00&date=2026-08-21');
    expect(injected).toContain(`orgId=${SELECTED_ORG_ID}`);
    const query = Object.fromEntries(new URLSearchParams(injected.split('?')[1]));
    const parsed = reportingTotalsQuerySchema.safeParse(query);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('orgId');
  });
});

// ---------------------------------------------------------------------------
// Every cached entry is a total denominated in the SERVER-derived partner
// reporting currency, but the key is only `${date}|${groups}` — so an admin who
// changes the partner reporting currency in the same tab would keep reading
// figures (and formatting) in the OLD currency until logout. The key is bound
// to the partner-currency cache's generation, so whatever invalidates that
// cache invalidates these totals too.
// ---------------------------------------------------------------------------
describe('useApproximateTotal — a partner reporting-currency change invalidates cached totals', () => {
  it('refetches after resetPartnerCurrencyCache() instead of serving the old-currency total', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    const first = render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:22940.00:CAD'));
    first.unmount();
    expect(approximateTotalCache.values.size).toBe(1);

    // What the admin's "save partner billing settings" does.
    resetPartnerCurrencyCache();

    fetchWithAuth.mockResolvedValue(jsonRes({ data: { ...AVAILABLE, targetCurrencyCode: 'EUR', total: '17000.00' } }));
    render(<Probe id="b" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('available:17000.00:EUR'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('drops the old-currency entries rather than leaving them unreachable in the map', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    const first = render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:22940.00:CAD'));
    first.unmount();

    resetPartnerCurrencyCache();
    render(<Probe id="b" date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    // One entry — the new-currency answer — not the old one alongside it.
    expect(approximateTotalCache.values.size).toBe(1);
  });

  it('a request in flight across the change cannot commit its old-currency answer', async () => {
    let resolve: (r: Response) => void = () => {};
    fetchWithAuth.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    resetPartnerCurrencyCache();
    // The next key computation observes the new partner-currency generation.
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ data: { ...AVAILABLE, targetCurrencyCode: 'EUR', total: '17000.00' } }));
    render(<Probe id="b" date="2026-08-21" />);
    resolve(jsonRes({ data: AVAILABLE }));

    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('available:17000.00:EUR'));
    expect([...approximateTotalCache.values.values()].map((v) => v.targetCurrencyCode)).toEqual(['EUR']);
  });

  it('a stable partner-currency generation still de-duplicates (no extra request per mount)', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:22940.00:CAD'));
    // Resolving the partner currency itself is NOT a change of currency.
    partnerCurrencyCache.value = 'CAD';
    render(<Probe id="b" date="2026-08-21" />);
    expect(screen.getByTestId('b').textContent).toBe('available:22940.00:CAD');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// #4472: the cache generation was not in the effect's dependency list, so an
// already-mounted line — never unmounted, no other prop/state change — kept
// its stale state after `resetPartnerCurrencyCache()` and only picked up the
// new currency on a later remount. Every test above unmounts and remounts
// (`first.unmount()` then a fresh `render()`), which happens to work because
// a brand-new mount always computes a fresh key — it never exercised the
// actually-broken path. These do.
// ---------------------------------------------------------------------------
describe('useApproximateTotal — an ALREADY-MOUNTED line reacts to a reset in place (#4472)', () => {
  it('refetches without unmounting when a same-tab reporting-currency save resets the cache', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ data: AVAILABLE }));
    render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:22940.00:CAD'));

    // What PartnerBillingSettings.tsx does after a reporting-currency save —
    // the mounted Probe is never unmounted or given new props.
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({ data: { ...AVAILABLE, targetCurrencyCode: 'EUR', total: '17000.00' } }),
    );
    resetPartnerCurrencyCache();

    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:17000.00:EUR'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('a stale response discarded by the generation guard self-heals instead of pinning `failed`', async () => {
    let resolveFirst: (r: Response) => void = () => {};
    fetchWithAuth.mockReturnValueOnce(new Promise<Response>((r) => { resolveFirst = r; }));
    render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));

    // Reset while the first request is still in flight; the mounted line
    // must start a second, post-reset request on its own.
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({ data: { ...AVAILABLE, targetCurrencyCode: 'EUR', total: '17000.00' } }),
    );
    resetPartnerCurrencyCache();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:17000.00:EUR'));

    // The stale pre-reset response finally lands and is discarded by the
    // generation guard — it must not clobber the healthy state with `failed`.
    resolveFirst(jsonRes({ data: AVAILABLE }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('a').dataset.failed).toBe('false');
    expect(screen.getByTestId('a').textContent).toBe('available:17000.00:EUR');
  });

  it('a mounted line survives a plain resetApproximateTotalCache() (logout) too', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ data: AVAILABLE }));
    render(<Probe id="a" date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:22940.00:CAD'));

    fetchWithAuth.mockResolvedValueOnce(jsonRes({ data: AVAILABLE }));
    resetApproximateTotalCache();

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
  });

  it('two simultaneously-mounted lines with DIFFERENT keys both react to one reset', async () => {
    // The real fix is a shared `listeners: Set<() => void>` in
    // approximateTotalCache.ts feeding a `useSyncExternalStore` in every hook
    // instance — a dashboard's realistic failure mode is several rollup lines
    // mounted at once, so a fan-out bug (e.g. only the first subscriber
    // re-rendering) would hide behind the single-instance tests above.
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    render(<><Probe id="a" date="2026-08-21" /><Probe id="b" date="2026-08-20" /></>);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:22940.00:CAD'));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('available:22940.00:CAD'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);

    fetchWithAuth.mockResolvedValue(
      jsonRes({ data: { ...AVAILABLE, targetCurrencyCode: 'EUR', total: '17000.00' } }),
    );
    resetPartnerCurrencyCache();

    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('available:17000.00:EUR'));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('available:17000.00:EUR'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(4);
  });
});
