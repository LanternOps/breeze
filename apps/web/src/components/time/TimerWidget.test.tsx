import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TimerWidget from './TimerWidget';
import { TIMER_CHANGED_EVENT } from '../../lib/timerActions';

// Built per-test: a module-load fixture drifts on slow CI runners and breaks
// the elapsed-time assertion (startedAt ages while earlier tests run).
const makeRunning = () => ({
  id: 'te-1', ticketId: 'tk-1', startedAt: new Date(Date.now() - 90_000).toISOString(),
  description: null, isBillable: false, ticketNumber: 'T-2026-0042', ticketSubject: 'Printer on fire'
});
const jsonRes = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;

beforeEach(() => fetchWithAuth.mockReset());

describe('TimerWidget', () => {
  it('renders nothing when no timer is running', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(null));
    const { container } = render(<TimerWidget />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/running'));
    expect(container.querySelector('[data-testid="timer-widget"]')).toBeNull();
  });

  it('shows elapsed time and the ticket number when running', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(makeRunning()));
    render(<TimerWidget />);
    expect(await screen.findByTestId('timer-widget')).toBeTruthy();
    expect(screen.getByTestId('timer-widget-ticket').textContent).toContain('T-2026-0042');
    // The first tick lands in an effect after mount — wait for its re-render
    // (slow CI runners otherwise read the initial 00:00).
    await waitFor(() => expect(screen.getByTestId('timer-widget-elapsed').textContent).toMatch(/01:3\d/));
  });

  it('stop popover posts /time-entries/stop with description + billable', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(makeRunning()));
    render(<TimerWidget />);
    fireEvent.click(await screen.findByTestId('timer-widget-stop'));
    fireEvent.change(screen.getByTestId('timer-stop-description'), { target: { value: 'fixed it' } });
    fireEvent.click(screen.getByTestId('timer-stop-billable'));
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: 'te-1' }))
      .mockResolvedValueOnce(jsonRes(null));
    fireEvent.click(screen.getByTestId('timer-stop-submit'));
    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/stop', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ description: 'fixed it', isBillable: true })
      }));
    });
    await waitFor(() => expect(screen.queryByTestId('timer-widget')).toBeNull());
  });

  it('refetches when breeze:timer-changed fires', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(null));
    render(<TimerWidget />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    fetchWithAuth.mockResolvedValue(jsonRes(makeRunning()));
    act(() => { window.dispatchEvent(new CustomEvent(TIMER_CHANGED_EVENT)); });
    expect(await screen.findByTestId('timer-widget')).toBeTruthy();
  });
});
