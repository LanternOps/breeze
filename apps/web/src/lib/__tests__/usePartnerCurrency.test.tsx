import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { usePartnerCurrency, resetPartnerCurrencyCache, loadPartnerCurrency } from '../usePartnerCurrency';
import { partnerCurrencyCache } from '../partnerCurrencyCache';

const jsonRes = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload }) as Response;

function StateProbe({ id = 'state' }: { id?: string }) {
  const { currency, loading, failed, retry } = usePartnerCurrency();
  return (
    <button type="button" data-testid={id} data-loading={String(loading)} data-failed={String(failed)} onClick={retry}>
      {currency ?? 'null'}
    </button>
  );
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  resetPartnerCurrencyCache();
});

describe('usePartnerCurrency — cache + failure semantics (no USD fallback anywhere, review F8)', () => {
  it('resolves the partner currency from /orgs/partners/me and is explicitly loading until then', async () => {
    let resolve: (r: Response) => void = () => {};
    fetchWithAuth.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    render(<StateProbe />);
    const el = screen.getByTestId('state');
    expect(el.textContent).toBe('null');
    expect(el.dataset.loading).toBe('true');
    expect(el.dataset.failed).toBe('false');
    resolve(jsonRes({ id: 'p-1', currencyCode: 'EUR' }));
    await waitFor(() => expect(el.textContent).toBe('EUR'));
    expect(el.dataset.loading).toBe('false');
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me');
  });

  it('a partner with no currencyCode is a FAILURE (unknown), never a silent USD', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ id: 'p-1' }));
    render(<StateProbe />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.failed).toBe('true'));
    expect(screen.getByTestId('state').textContent).toBe('null');
    expect(screen.getByTestId('state').dataset.loading).toBe('false');
    expect(partnerCurrencyCache.value).toBeNull();
  });

  it('a code outside the shared currency list is rejected and never cached', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'XXX' }));
    const first = render(<StateProbe id="a" />);
    await waitFor(() => expect(screen.getByTestId('a').dataset.failed).toBe('true'));
    expect(screen.getByTestId('a').textContent).toBe('null');
    expect(partnerCurrencyCache.value).toBeNull();
    first.unmount();

    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'CAD' }));
    render(<StateProbe id="b" />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('CAD'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('fetches once across two mounts (module-level cache)', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ currencyCode: 'GBP' }));
    render(<><StateProbe id="a" /><StateProbe id="b" /></>);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('GBP'));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('GBP'));
    render(<StateProbe id="c" />);
    await waitFor(() => expect(screen.getByTestId('c').textContent).toBe('GBP'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('does not cache a 401 — the next mount retries', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'Unauthorized' }, 401));
    const first = render(<StateProbe id="a" />);
    await waitFor(() => expect(screen.getByTestId('a').dataset.failed).toBe('true'));
    expect(screen.getByTestId('a').textContent).toBe('null');
    first.unmount();

    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'CAD' }));
    render(<StateProbe id="b" />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('CAD'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('does not cache a network failure and never throws', async () => {
    fetchWithAuth.mockRejectedValueOnce(new Error('offline'));
    const first = render(<StateProbe id="a" />);
    await waitFor(() => expect(screen.getByTestId('a').dataset.failed).toBe('true'));
    expect(screen.getByTestId('a').textContent).toBe('null');
    first.unmount();

    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'AUD' }));
    render(<StateProbe id="b" />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('AUD'));
  });

  it('resetPartnerCurrencyCache forces a refetch (partner switch / logout)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'EUR' }));
    const first = render(<StateProbe id="a" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('EUR'));
    first.unmount();
    resetPartnerCurrencyCache();
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'JPY' }));
    render(<StateProbe id="b" />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('JPY'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });
});

describe('usePartnerCurrency (typed state, no USD fallback)', () => {
  it('is null until resolved, then carries the partner currency', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ currencyCode: 'eur' }));
    render(<StateProbe />);
    expect(screen.getByTestId('state').textContent).toBe('null');
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('EUR'));
    expect(screen.getByTestId('state').dataset.failed).toBe('false');
  });

  it('flags failure (never USD) on a 401 or a body without currencyCode, and retry() refetches', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'Unauthorized' }, 401));
    render(<StateProbe />);
    await waitFor(() => expect(screen.getByTestId('state').dataset.failed).toBe('true'));
    expect(screen.getByTestId('state').textContent).toBe('null');

    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: 'p-1' }));
    screen.getByTestId('state').click();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('state').dataset.failed).toBe('true'));
    expect(screen.getByTestId('state').textContent).toBe('null');

    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'CAD' }));
    screen.getByTestId('state').click();
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('CAD'));
  });

  it('a disabled hook stays loading=false/failed=false with no fetch until enabled', async () => {
    function Gated({ enabled }: { enabled: boolean }) {
      const { currency, loading, failed } = usePartnerCurrency(enabled);
      return <span data-testid="g" data-loading={String(loading)} data-failed={String(failed)}>{currency ?? 'null'}</span>;
    }
    fetchWithAuth.mockResolvedValue(jsonRes({ currencyCode: 'GBP' }));
    const { rerender } = render(<Gated enabled={false} />);
    expect(screen.getByTestId('g').dataset.loading).toBe('false');
    expect(fetchWithAuth).not.toHaveBeenCalled();
    rerender(<Gated enabled />);
    await waitFor(() => expect(screen.getByTestId('g').textContent).toBe('GBP'));
  });
});

describe('reset generation (review F7): a request started before reset can never touch the post-reset cache', () => {
  const deferred = () => {
    let resolve: (r: Response) => void = () => {};
    const promise = new Promise<Response>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('stale request neither commits its currency nor clears the newer in-flight request', async () => {
    // Partner A's request is in flight when the user logs out (reset) and
    // partner B logs in and starts a fresh request.
    const a = deferred();
    fetchWithAuth.mockReturnValueOnce(a.promise);
    const pA = loadPartnerCurrency();
    resetPartnerCurrencyCache();
    const b = deferred();
    fetchWithAuth.mockReturnValueOnce(b.promise);
    const pB = loadPartnerCurrency();
    const inflightB = partnerCurrencyCache.inflight;
    expect(inflightB).not.toBeNull();

    // A resolves AFTER the reset: it must not write A's currency over B's
    // cache, and its cleanup must not drop B's in-flight request.
    a.resolve(jsonRes({ currencyCode: 'USD' }));
    await flush();
    expect(partnerCurrencyCache.value).toBeNull();
    expect(partnerCurrencyCache.inflight).toBe(inflightB);

    b.resolve(jsonRes({ currencyCode: 'EUR' }));
    expect(await pB).toBe('EUR');
    expect(partnerCurrencyCache.value).toBe('EUR');
    // A stale caller re-resolves under the CURRENT generation — never A's value.
    expect(await pA).toBe('EUR');
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('a hook mounted across the reset ends on the new partner currency, never the old one', async () => {
    const a = deferred();
    fetchWithAuth.mockReturnValueOnce(a.promise);
    render(<StateProbe />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    resetPartnerCurrencyCache();
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'EUR' }));
    a.resolve(jsonRes({ currencyCode: 'USD' }));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('EUR'));
    expect(partnerCurrencyCache.value).toBe('EUR');
  });
});
