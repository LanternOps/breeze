import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import TimesheetPage from './TimesheetPage';

const entry = { id: 'te-1', startedAt: '2026-06-08T09:00:00Z', endedAt: '2026-06-08T10:30:00Z', durationMinutes: 90, description: 'patching', isBillable: true, hourlyRate: '100.00', isApproved: false, ticketId: 'tk-1', ticketNumber: 'T-2026-0042', ticketSubject: 'x', userName: 'Todd', billingStatus: 'not_billed' };
const week = {
  weekStart: '2026-06-08',
  days: [
    { date: '2026-06-08', totalMinutes: 90, billableMinutes: 90, entries: [entry] },
    ...['09', '10', '11', '12', '13', '14'].map((d) => ({ date: `2026-06-${d}`, totalMinutes: 0, billableMinutes: 0, entries: [] }))
  ],
  totals: { totalMinutes: 90, billableMinutes: 90 }
};
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;

beforeEach(() => {
  window.location.hash = '#week=2026-06-08';
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.startsWith('/time-entries/timesheet')) return jsonRes(week);
    if (url.startsWith('/users')) return jsonRes([{ id: 'u-1', name: 'Todd', email: 't@x' }]);
    return jsonRes({});
  });
});

describe('TimesheetPage', () => {
  it('fetches the week from the hash and renders day totals + entries', async () => {
    render(<TimesheetPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(expect.stringContaining('/time-entries/timesheet?weekStart=2026-06-08')));
    expect((await screen.findByTestId('timesheet-day-2026-06-08')).textContent).toContain('1h 30m');
    expect(screen.getByTestId('timesheet-entry-te-1').textContent).toContain('T-2026-0042');
    expect(screen.getByTestId('timesheet-total').textContent).toContain('1h 30m');
  });

  it('week navigation updates the hash and refetches', async () => {
    render(<TimesheetPage />);
    await screen.findByTestId('timesheet-day-2026-06-08');
    fireEvent.click(screen.getByTestId('timesheet-prev-week'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(expect.stringContaining('weekStart=2026-06-01')));
    expect(window.location.hash).toContain('week=2026-06-01');
  });

  it('bulk-approves selected entries and surfaces skippedReasons', async () => {
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-select-te-1'));
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/time-entries/bulk-approve') return jsonRes({ updated: 0, skipped: 1, skippedReasons: { ENTRY_RUNNING: 1 }, total: 1 });
      if (url.startsWith('/time-entries/timesheet')) return jsonRes(week);
      if (url.startsWith('/users')) return jsonRes([{ id: 'u-1', name: 'Todd', email: 't@x' }]);
      return jsonRes({});
    });
    fireEvent.click(screen.getByTestId('timesheet-approve-selected'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((args) => args[0] === '/time-entries/bulk-approve');
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ ids: ['te-1'], approve: true });
    });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
  });

  it('falls back to own timesheet with a notice when another tech 403s', async () => {
    window.location.hash = '#week=2026-06-08&tech=u-2';
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.includes('userId=u-2')) return { ok: false, status: 403, json: async () => ({ error: 'admin required' }) } as Response;
      if (url.startsWith('/time-entries/timesheet')) return jsonRes(week);
      if (url.startsWith('/users')) return jsonRes([{ id: 'u-2', name: 'Bo', email: 'b@x' }]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    expect(await screen.findByTestId('timesheet-admin-notice')).toBeTruthy();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(expect.not.stringContaining('userId=u-2')));
  });
});
