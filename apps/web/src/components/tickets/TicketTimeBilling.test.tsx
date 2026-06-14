import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TicketTimeBilling from './TicketTimeBilling';
import { BILLING_CHANGED_EVENT } from '../../lib/timerActions';

const summary = { time: { totalMinutes: 90, billableMinutes: 60, billableAmount: '150.00' }, parts: { partsCount: 2, billableTotal: '49.98' } };
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
    expect(screen.getByTestId('ticket-billing-amount').textContent).toContain('$150.00');
    expect(screen.getByTestId('ticket-billing-parts-total').textContent).toContain('$49.98');
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
