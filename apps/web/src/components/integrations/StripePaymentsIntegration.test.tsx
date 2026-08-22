import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

import StripePaymentsIntegration from './StripePaymentsIntegration';

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const connected = {
  status: 'connected',
  stripeAccountId: 'acct_1ABCDEFG',
  livemode: true,
  last4: 'Zz9q',
  defaultCurrency: 'EUR',
  accountCountry: 'DE',
  accountRefreshedAt: '2026-08-20T10:00:00.000Z',
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('StripePaymentsIntegration — account currency cache (#3777)', () => {
  it('shows the cached settlement currency + country on the connected row', async () => {
    fetchWithAuth.mockImplementation(async () => json(connected));
    render(<StripePaymentsIntegration />);
    const cell = await screen.findByTestId('stripe-connect-currency');
    expect(cell.textContent).toContain('EUR');
    expect(cell.textContent).toContain('DE');
    expect(screen.getByTestId('stripe-connect-refresh-button')).toBeInTheDocument();
  });

  it('shows the not-cached copy when the API has no default currency yet', async () => {
    fetchWithAuth.mockImplementation(async () =>
      json({ ...connected, defaultCurrency: null, accountCountry: null, accountRefreshedAt: null }),
    );
    render(<StripePaymentsIntegration />);
    const cell = await screen.findByTestId('stripe-connect-currency');
    expect(cell.textContent).toContain('Currency not cached yet');
    expect(cell.textContent).not.toContain('EUR');
  });

  it('Refresh POSTs /partner/stripe-connect/refresh, then re-loads the status', async () => {
    let refreshed = false;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/partner/stripe-connect/refresh' && init?.method === 'POST') {
        refreshed = true;
        return json({ defaultCurrency: 'GBP', accountCountry: 'GB', accountRefreshedAt: '2026-08-22T00:00:00.000Z' });
      }
      if (url === '/partner/stripe-connect') {
        return json(refreshed ? { ...connected, defaultCurrency: 'GBP', accountCountry: 'GB' } : connected);
      }
      return json({});
    });
    render(<StripePaymentsIntegration />);
    expect((await screen.findByTestId('stripe-connect-currency')).textContent).toContain('EUR');

    fireEvent.click(screen.getByTestId('stripe-connect-refresh-button'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/partner/stripe-connect/refresh',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => expect(screen.getByTestId('stripe-connect-currency').textContent).toContain('GBP'));
    // Two status loads: mount + post-refresh.
    expect(fetchWithAuth.mock.calls.filter((c) => c[0] === '/partner/stripe-connect').length).toBe(2);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('surfaces a refresh failure as an error toast and keeps the cached value', async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/partner/stripe-connect/refresh' && init?.method === 'POST') {
        return json({ error: 'Stripe unreachable' }, false, 502);
      }
      return json(connected);
    });
    render(<StripePaymentsIntegration />);
    await screen.findByTestId('stripe-connect-currency');
    fireEvent.click(screen.getByTestId('stripe-connect-refresh-button'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(screen.getByTestId('stripe-connect-currency').textContent).toContain('EUR');
  });

  it('a transient refresh failure (cacheState=stale) keeps the cached value and says so (review F4)', async () => {
    fetchWithAuth.mockImplementation(async () =>
      json({ ...connected, cacheState: 'stale', stale: true, error: { code: 'STRIPE_UNAVAILABLE', message: 'Could not reach Stripe right now — try again in a moment.' } }),
    );
    render(<StripePaymentsIntegration />);
    const cell = await screen.findByTestId('stripe-connect-currency');
    expect(cell.textContent).toContain('EUR');
    expect(screen.getByTestId('stripe-connect-stale').textContent).toContain('could not be reached');
    expect(screen.queryByTestId('stripe-connect-reconnect-required')).not.toBeInTheDocument();
  });

  it('a revoked/unreadable key (status=reconnect_required) is NOT shown as connected — prompts for a new key (review F4)', async () => {
    fetchWithAuth.mockImplementation(async () =>
      json({
        ...connected,
        status: 'reconnect_required',
        cacheState: 'reconnect_required',
        stale: true,
        error: { code: 'INVALID_STRIPE_KEY', message: 'Stripe rejected the stored key — reconnect Stripe.' },
      }),
    );
    render(<StripePaymentsIntegration />);
    const banner = await screen.findByTestId('stripe-connect-reconnect-required');
    expect(banner.textContent).toContain('Zz9q');
    expect(banner.textContent).toContain('Stripe rejected the stored key');
    // The key form is offered and the "connected" account row is not...
    expect(screen.getByTestId('stripe-key-input')).toBeInTheDocument();
    expect(screen.queryByTestId('stripe-connect-currency')).not.toBeInTheDocument();
    // ...but Refresh and Disconnect stay reachable: reconnect_required can be a
    // false positive, and hiding them leaves no in-page recovery (review F3).
    expect(screen.getByTestId('stripe-connect-refresh-button')).toBeInTheDocument();
    expect(screen.getByTestId('stripe-disconnect-button')).toBeInTheDocument();
  });

  it('Refresh from a reconnect_required panel re-checks and recovers to connected (review F3)', async () => {
    let rechecked = false;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/partner/stripe-connect/refresh' && init?.method === 'POST') {
        rechecked = true;
        return json({ ...connected, cacheState: 'fresh' });
      }
      if (url === '/partner/stripe-connect') {
        return json(
          rechecked
            ? connected
            : {
                ...connected,
                status: 'reconnect_required',
                cacheState: 'reconnect_required',
                error: { code: 'INVALID_STRIPE_KEY', message: 'Stripe rejected the stored key — reconnect Stripe.' },
              },
        );
      }
      return json({});
    });
    render(<StripePaymentsIntegration />);
    await screen.findByTestId('stripe-connect-reconnect-required');

    fireEvent.click(screen.getByTestId('stripe-connect-refresh-button'));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/partner/stripe-connect/refresh', expect.objectContaining({ method: 'POST' })),
    );
    await waitFor(() => expect(screen.queryByTestId('stripe-connect-reconnect-required')).not.toBeInTheDocument());
    expect(screen.getByTestId('stripe-connect-currency').textContent).toContain('EUR');
  });
});
