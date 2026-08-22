import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { usePartnerCurrency, usePartnerCurrencyOrDefault, resetPartnerCurrencyCache } from '../usePartnerCurrency';

const jsonRes = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload }) as Response;

function Probe({ id = 'probe' }: { id?: string }) {
  return <span data-testid={id}>{usePartnerCurrencyOrDefault()}</span>;
}

function StateProbe({ id = 'state' }: { id?: string }) {
  const { currency, failed, retry } = usePartnerCurrency();
  return (
    <button type="button" data-testid={id} data-failed={String(failed)} onClick={retry}>
      {currency ?? 'null'}
    </button>
  );
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  resetPartnerCurrencyCache();
});

describe('usePartnerCurrencyOrDefault (display)', () => {
  it('resolves the partner currency from /orgs/partners/me', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ id: 'p-1', currencyCode: 'EUR' }));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('EUR'));
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me');
  });

  it('renders USD until loaded and keeps USD when the partner has no currencyCode', async () => {
    let resolve: (r: Response) => void = () => {};
    fetchWithAuth.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('USD');
    resolve(jsonRes({ id: 'p-1' }));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('probe').textContent).toBe('USD');
  });

  it('fetches once across two mounts (module-level cache)', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ currencyCode: 'GBP' }));
    render(<><Probe id="a" /><Probe id="b" /></>);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('GBP'));
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('GBP'));
    render(<Probe id="c" />);
    await waitFor(() => expect(screen.getByTestId('c').textContent).toBe('GBP'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('does not cache a 401 — the next mount retries', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'Unauthorized' }, 401));
    const first = render(<Probe id="a" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('a').textContent).toBe('USD');
    first.unmount();

    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'CAD' }));
    render(<Probe id="b" />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('CAD'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('does not cache a network failure and never throws', async () => {
    fetchWithAuth.mockRejectedValueOnce(new Error('offline'));
    const first = render(<Probe id="a" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('a').textContent).toBe('USD');
    first.unmount();

    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'AUD' }));
    render(<Probe id="b" />);
    await waitFor(() => expect(screen.getByTestId('b').textContent).toBe('AUD'));
  });

  it('resetPartnerCurrencyCache forces a refetch (partner switch / logout)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'EUR' }));
    const first = render(<Probe id="a" />);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('EUR'));
    first.unmount();
    resetPartnerCurrencyCache();
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ currencyCode: 'JPY' }));
    render(<Probe id="b" />);
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

  it('shares the module cache with the display hook', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ currencyCode: 'GBP' }));
    render(<><Probe id="a" /><StateProbe id="s" /></>);
    await waitFor(() => expect(screen.getByTestId('a').textContent).toBe('GBP'));
    await waitFor(() => expect(screen.getByTestId('s').textContent).toBe('GBP'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
