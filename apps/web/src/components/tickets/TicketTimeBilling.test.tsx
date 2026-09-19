import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TicketTimeBilling from './TicketTimeBilling';
import { BILLING_CHANGED_EVENT } from '../../lib/timerActions';

const summary = {
  time: { totalMinutes: 90, billableMinutes: 60, billableAmounts: [{ currencyCode: 'EUR', amount: '150.00' }] },
  parts: { partsCount: 2, billableTotals: [{ currencyCode: 'EUR', amount: '49.98' }, { currencyCode: 'USD', amount: '12.00' }] },
};
const entries = [{ id: 'te-1', startedAt: '2026-06-12T09:00:00Z', endedAt: '2026-06-12T09:45:00Z', durationMinutes: 45, description: 'diag', isBillable: true, userName: 'Todd', ticketNumber: null, ticketSubject: null, ticketId: 'tk-1', isApproved: false }];
const route = (url: string) => {
  if (url.startsWith('/tickets/tk-1/billing-summary')) return { ok: true, status: 200, json: async () => ({ data: summary }) } as Response;
  if (url.startsWith('/tickets/tk-1/time-entries')) return { ok: true, status: 200, json: async () => ({ data: entries, total: 1 }) } as Response;
  return { ok: true, status: 200, json: async () => ({ data: {} }) } as Response;
};

beforeEach(() => { fetchWithAuth.mockReset(); fetchWithAuth.mockImplementation(async (url: string) => route(url)); });

describe('TicketTimeBilling', () => {
  it('renders totals from the billing summary', async () => {
    render(<TicketTimeBilling ticketId="tk-1" />);
    expect((await screen.findByTestId('ticket-billing-time-total')).textContent).toContain('1h 30m');
    expect(screen.getByTestId('ticket-billing-amount').textContent).toContain('€150.00');
    expect(screen.getByTestId('ticket-billing-amount').textContent).not.toContain('$');
    expect(screen.getByTestId('ticket-billing-amount-EUR').textContent).toContain('€150.00');
    // Parts span two currencies → one chip per currency, never a summed total.
    const parts = screen.getByTestId('ticket-billing-parts-total');
    expect(parts.textContent).toContain('€49.98');
    expect(parts.textContent).toContain('$12.00');
    expect(parts.textContent).not.toContain('61.98');
    expect(screen.getByTestId('ticket-billing-parts-total-EUR').textContent).toBe('€49.98');
    expect(screen.getByTestId('ticket-billing-parts-total-USD').textContent).toBe('$12.00');
  });

  // W06 (#3900): the SAME badge the timesheet renders, from the same helper, so
  // the two surfaces cannot disagree about what a provenance value is called.
  it('shows a provenance badge in the rail for a non-manual entry and none for manual', async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/tickets/tk-1/time-entries')) {
        return { ok: true, status: 200, json: async () => ({ data: [
          { ...entries[0], id: 'e1', source: 'support_session' },
          { ...entries[0], id: 'e2', source: 'manual' },
          { ...entries[0], id: 'e3' },
        ], total: 3 }) } as Response;
      }
      return route(url);
    });
    render(<TicketTimeBilling ticketId="tk-1" />);
    expect((await screen.findByTestId('time-entry-source-e1')).textContent).toBe('From Quick Support');
    expect(screen.queryByTestId('time-entry-source-e2')).toBeNull();
    expect(screen.queryByTestId('time-entry-source-e3')).toBeNull();
  });

  it('renders a dash (not $0.00) when a summary carries no money', async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/tickets/tk-1/billing-summary')) {
        return { ok: true, status: 200, json: async () => ({ data: { time: { totalMinutes: 30, billableMinutes: 0, billableAmounts: [] }, parts: { partsCount: 0, billableTotals: [] } } }) } as Response;
      }
      return route(url);
    });
    render(<TicketTimeBilling ticketId="tk-1" />);
    expect((await screen.findByTestId('ticket-billing-amount')).textContent).toBe('—');
    expect(screen.getByTestId('ticket-billing-parts-total').textContent).toBe('—');
    expect(screen.getByTestId('ticket-time-billing').textContent).not.toContain('$');
  });

  it('starts a timer scoped to the ticket', async () => {
    render(<TicketTimeBilling ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-billing-start-timer'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/start', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ ticketId: 'tk-1' })
    })));
  });

  it('quick-add posts a manual entry with computed start/end', async () => {
    render(<TicketTimeBilling ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
    fireEvent.change(screen.getByTestId('ticket-billing-quick-add-minutes'), { target: { value: '30' } });
    fireEvent.change(screen.getByTestId('ticket-billing-quick-add-description'), { target: { value: 'patched' } });
    fireEvent.click(screen.getByTestId('ticket-billing-quick-add-submit'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((args) => args[0] === '/time-entries');
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.ticketId).toBe('tk-1');
      expect(body.description).toBe('patched');
      expect(new Date(body.endedAt).getTime() - new Date(body.startedAt).getTime()).toBe(30 * 60_000);
    });
  });

  // #5321: the quick-add offered no rate, so an entry landed with hourly_rate
  // NULL and "Create invoice" then 409'd (ALL_MISSING_RATE) for every one.
  describe('quick-add rate (#5321)', () => {
    const withDefaults = (defaults: unknown) => async (url: string) => {
      if (url.startsWith('/tickets/tk-1/billing-summary')) {
        return { ok: true, status: 200, json: async () => ({ data: { ...summary, defaults } }) } as Response;
      }
      return route(url);
    };

    it('prefills the rate from the ticket default and posts it', async () => {
      fetchWithAuth.mockImplementation(withDefaults({ hourlyRate: '150.00', currencyCode: 'USD', isBillable: true }));
      render(<TicketTimeBilling ticketId="tk-1" />);
      fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
      const rate = screen.getByTestId('ticket-billing-quick-add-rate') as HTMLInputElement;
      expect(rate.value).toBe('150.00');
      expect(screen.queryByTestId('ticket-billing-quick-add-no-rate')).toBeNull();
      fireEvent.change(screen.getByTestId('ticket-billing-quick-add-minutes'), { target: { value: '30' } });
      fireEvent.click(screen.getByTestId('ticket-billing-quick-add-submit'));
      await waitFor(() => {
        const call = fetchWithAuth.mock.calls.find((args) => args[0] === '/time-entries');
        expect(call).toBeTruthy();
        expect(JSON.parse((call![1] as RequestInit).body as string).hourlyRate).toBe(150);
      });
    });

    it('sends a rate the tech typed when the ticket has no default, and warns until they do', async () => {
      fetchWithAuth.mockImplementation(withDefaults({ hourlyRate: null, currencyCode: 'USD', isBillable: true }));
      render(<TicketTimeBilling ticketId="tk-1" />);
      fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
      expect((screen.getByTestId('ticket-billing-quick-add-rate') as HTMLInputElement).value).toBe('');
      // Billable + no rate is the un-invoiceable combination — say so up front.
      expect(screen.getByTestId('ticket-billing-quick-add-no-rate')).toBeTruthy();
      fireEvent.change(screen.getByTestId('ticket-billing-quick-add-rate'), { target: { value: '85.5' } });
      expect(screen.queryByTestId('ticket-billing-quick-add-no-rate')).toBeNull();
      fireEvent.change(screen.getByTestId('ticket-billing-quick-add-minutes'), { target: { value: '30' } });
      fireEvent.click(screen.getByTestId('ticket-billing-quick-add-submit'));
      await waitFor(() => {
        const call = fetchWithAuth.mock.calls.find((args) => args[0] === '/time-entries');
        expect(call).toBeTruthy();
        expect(JSON.parse((call![1] as RequestInit).body as string).hourlyRate).toBe(85.5);
      });
    });

    it('omits hourlyRate entirely when the field is left blank, so the server default still applies', async () => {
      fetchWithAuth.mockImplementation(withDefaults({ hourlyRate: null, currencyCode: 'USD', isBillable: true }));
      render(<TicketTimeBilling ticketId="tk-1" />);
      fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
      fireEvent.change(screen.getByTestId('ticket-billing-quick-add-minutes'), { target: { value: '30' } });
      fireEvent.click(screen.getByTestId('ticket-billing-quick-add-submit'));
      await waitFor(() => {
        const call = fetchWithAuth.mock.calls.find((args) => args[0] === '/time-entries');
        expect(call).toBeTruthy();
        expect(Object.keys(JSON.parse((call![1] as RequestInit).body as string))).not.toContain('hourlyRate');
      });
    });

    // Review finding: <input type=number min=0> does not block a typed negative
    // here (the submit button is an onClick, not a form submit), so the guard
    // must SAY something rather than make the button a dead no-op.
    it('names an invalid rate inline and does not post', async () => {
      fetchWithAuth.mockImplementation(withDefaults({ hourlyRate: null, currencyCode: 'USD', isBillable: true }));
      render(<TicketTimeBilling ticketId="tk-1" />);
      fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
      fireEvent.change(screen.getByTestId('ticket-billing-quick-add-minutes'), { target: { value: '30' } });
      fireEvent.change(screen.getByTestId('ticket-billing-quick-add-rate'), { target: { value: '-5' } });
      expect(screen.getByTestId('ticket-billing-quick-add-rate-invalid')).toBeTruthy();
      // A negative rate is not the "no rate" case — don't show both.
      expect(screen.queryByTestId('ticket-billing-quick-add-no-rate')).toBeNull();
      fireEvent.click(screen.getByTestId('ticket-billing-quick-add-submit'));
      await waitFor(() => expect(screen.getByTestId('ticket-billing-quick-add-rate-invalid')).toBeTruthy());
      expect(fetchWithAuth.mock.calls.find((args) => args[0] === '/time-entries')).toBeFalsy();
    });

    it('tolerates a defaults-less summary (older API or an unresolvable ticket)', async () => {
      fetchWithAuth.mockImplementation(withDefaults(null));
      render(<TicketTimeBilling ticketId="tk-1" />);
      fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
      expect((screen.getByTestId('ticket-billing-quick-add-rate') as HTMLInputElement).value).toBe('');
      expect(screen.getByTestId('ticket-billing-quick-add-no-rate')).toBeTruthy();
    });

    // Review finding: the rate is entered in the ORG's currency, so the currency
    // must stay visible. A placeholder disappears the moment the box is
    // prefilled — which is the common case.
    it('keeps the currency visible next to a prefilled rate', async () => {
      fetchWithAuth.mockImplementation(withDefaults({ hourlyRate: '150.00', currencyCode: 'EUR', isBillable: true }));
      render(<TicketTimeBilling ticketId="tk-1" />);
      fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
      expect((screen.getByTestId('ticket-billing-quick-add-rate') as HTMLInputElement).value).toBe('150.00');
      expect(screen.getByTestId('ticket-billing-quick-add-rate-currency').textContent).toBe('EUR');
    });

    // Review finding: TicketWorkbench renders this component without a `key`, so
    // switching tickets only changes the prop. An in-flight summary for the OLD
    // ticket must never land on the new one — it would prefill the rate box with
    // another org's number, under another org's currency.
    it('drops an in-flight summary that belongs to the previously selected ticket', async () => {
      let releaseOld: (() => void) | undefined;
      fetchWithAuth.mockImplementation(async (url: string) => {
        if (url.startsWith('/tickets/tk-old/billing-summary')) {
          await new Promise<void>((resolve) => { releaseOld = resolve; });
          return { ok: true, status: 200, json: async () => ({ data: { ...summary, defaults: { hourlyRate: '999.00', currencyCode: 'JPY', isBillable: true } } }) } as Response;
        }
        if (url.startsWith('/tickets/tk-new/billing-summary')) {
          return { ok: true, status: 200, json: async () => ({ data: { ...summary, defaults: { hourlyRate: '150.00', currencyCode: 'EUR', isBillable: true } } }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ data: [], total: 0 }) } as Response;
      });
      const { rerender } = render(<TicketTimeBilling ticketId="tk-old" />);
      rerender(<TicketTimeBilling ticketId="tk-new" />);
      fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
      await waitFor(() => expect((screen.getByTestId('ticket-billing-quick-add-rate') as HTMLInputElement).value).toBe('150.00'));
      await act(async () => { releaseOld?.(); await Promise.resolve(); });
      // tk-old's response resolved last — it must be discarded, not applied.
      expect((screen.getByTestId('ticket-billing-quick-add-rate') as HTMLInputElement).value).toBe('150.00');
      expect(screen.getByTestId('ticket-billing-quick-add-rate-currency').textContent).toBe('EUR');
    });

    it('does not warn about a missing rate on a non-billable entry', async () => {
      fetchWithAuth.mockImplementation(withDefaults({ hourlyRate: null, currencyCode: 'USD', isBillable: true }));
      render(<TicketTimeBilling ticketId="tk-1" />);
      fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
      expect(screen.getByTestId('ticket-billing-quick-add-no-rate')).toBeTruthy();
      fireEvent.click(screen.getByTestId('ticket-billing-quick-add-billable'));
      expect(screen.queryByTestId('ticket-billing-quick-add-no-rate')).toBeNull();
    });
  });

  it('broadcasts billing-changed after a quick-add so the workbench feed live-refreshes', async () => {
    const onBillingChanged = vi.fn();
    window.addEventListener(BILLING_CHANGED_EVENT, onBillingChanged);
    try {
      render(<TicketTimeBilling ticketId="tk-1" />);
      fireEvent.click(await screen.findByTestId('ticket-billing-quick-add-toggle'));
      fireEvent.change(screen.getByTestId('ticket-billing-quick-add-minutes'), { target: { value: '15' } });
      fireEvent.click(screen.getByTestId('ticket-billing-quick-add-submit'));
      await waitFor(() => expect(onBillingChanged).toHaveBeenCalled());
    } finally {
      window.removeEventListener(BILLING_CHANGED_EVENT, onBillingChanged);
    }
  });

  it('disables the start-timer button while a start is in flight', async () => {
    let resolveStart: (v: Response) => void = () => {};
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/time-entries/start') return new Promise<Response>((res) => { resolveStart = res; });
      return route(url);
    });
    render(<TicketTimeBilling ticketId="tk-1" />);
    const btn = await screen.findByTestId('ticket-billing-start-timer');
    fireEvent.click(btn);
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    // A second click while disabled must not fire a second start request.
    fireEvent.click(btn);
    const startCalls = fetchWithAuth.mock.calls.filter((a) => a[0] === '/time-entries/start').length;
    expect(startCalls).toBe(1);
    act(() => resolveStart({ ok: true, status: 201, json: async () => ({ data: { id: 'te-x' } }) } as Response));
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  });

  it('refetches when breeze:billing-changed fires', async () => {
    render(<TicketTimeBilling ticketId="tk-1" />);
    // Wait for the initial load
    expect(await screen.findByTestId('ticket-billing-time-total')).toBeTruthy();
    const callsBefore = fetchWithAuth.mock.calls.length;
    // Dispatch billing-changed event
    act(() => { window.dispatchEvent(new CustomEvent(BILLING_CHANGED_EVENT)); });
    await waitFor(() => expect(fetchWithAuth.mock.calls.length).toBeGreaterThan(callsBefore));
  });
});
