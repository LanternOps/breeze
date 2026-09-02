import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import TimesheetPage from './TimesheetPage';

const entry = { id: 'te-1', startedAt: '2026-06-08T09:00:00Z', endedAt: '2026-06-08T10:30:00Z', durationMinutes: 90, description: 'patching', isBillable: true, hourlyRate: '100.00', currencyCode: 'EUR', isApproved: false, ticketId: 'tk-1', ticketNumber: 'T-2026-0042', ticketSubject: 'x', userName: 'Todd', billingStatus: 'not_billed' };
const week = {
  weekStart: '2026-06-08',
  days: [
    { date: '2026-06-08', totalMinutes: 90, billableMinutes: 90, entries: [entry] },
    ...['09', '10', '11', '12', '13', '14'].map((d) => ({ date: `2026-06-${d}`, totalMinutes: 0, billableMinutes: 0, entries: [] }))
  ],
  totals: { totalMinutes: 90, billableMinutes: 90, billableAmounts: [{ currencyCode: 'EUR', amount: '150.00' }, { currencyCode: 'USD', amount: '20.00' }] }
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

  // W06 (#3900) provenance badge. `manual` is the default for every entry ever
  // typed by hand, so badging it would put a chip on nearly every row and say
  // nothing — only a non-manual source is worth surfacing.
  it('shows a provenance badge for a non-manual entry and none for a manual one', async () => {
    const fromSession = { ...entry, id: 'e1', source: 'remote_session' };
    const manual = { ...entry, id: 'e2', source: 'manual' };
    const noSource = { ...entry, id: 'e3' };  // older server: field absent
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/time-entries/timesheet')) {
        return jsonRes({ ...week, days: [{ ...week.days[0], entries: [fromSession, manual, noSource] }, ...week.days.slice(1)] });
      }
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    expect((await screen.findByTestId('time-entry-source-e1')).textContent).toBe('From remote session');
    expect(screen.queryByTestId('time-entry-source-e2')).toBeNull();
    expect(screen.queryByTestId('time-entry-source-e3')).toBeNull();
  });

  it('labels every value in the vocabulary', async () => {
    const rows = (['timer', 'location', 'remote_session', 'support_session'] as const)
      .map((source, i) => ({ ...entry, id: `s${i}`, source }));
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/time-entries/timesheet')) {
        return jsonRes({ ...week, days: [{ ...week.days[0], entries: rows }, ...week.days.slice(1)] });
      }
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    expect((await screen.findByTestId('time-entry-source-s0')).textContent).toBe('Timer');
    expect(screen.getByTestId('time-entry-source-s1').textContent).toBe('From location');
    expect(screen.getByTestId('time-entry-source-s2').textContent).toBe('From remote session');
    expect(screen.getByTestId('time-entry-source-s3').textContent).toBe('From Quick Support');
  });

  it('renders one money chip per currency in the week total, never a summed figure', async () => {
    render(<TimesheetPage />);
    const amounts = await screen.findByTestId('timesheet-billable-amounts');
    expect(amounts.textContent).toContain('€150.00');
    expect(amounts.textContent).toContain('$20.00');
    expect(amounts.textContent).not.toContain('170');
    expect(screen.getByTestId('timesheet-billable-amount-EUR').textContent).toBe('€150.00');
    expect(screen.getByTestId('timesheet-billable-amount-USD').textContent).toBe('$20.00');
  });

  it('omits the money chips when the week carries no billable amounts', async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/time-entries/timesheet')) return jsonRes({ ...week, totals: { totalMinutes: 90, billableMinutes: 90, billableAmounts: [] } });
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    const total = await screen.findByTestId('timesheet-total');
    expect(total.textContent).toContain('1h 30m');
    expect(screen.queryByTestId('timesheet-billable-amounts')).toBeNull();
    expect(total.textContent).not.toContain('$');
  });

  it('renders each entry rate in its stamped currency and a dash when unrated — no USD fallback', async () => {
    const jpy = { ...entry, id: 'te-2', hourlyRate: '50.00', currencyCode: 'JPY' };
    const unrated = { ...entry, id: 'te-3', hourlyRate: null, currencyCode: null, isBillable: false };
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/time-entries/timesheet')) {
        return jsonRes({ ...week, days: [{ ...week.days[0], entries: [entry, jpy, unrated] }, ...week.days.slice(1)] });
      }
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    expect((await screen.findByTestId('timesheet-rate-te-1')).textContent).toBe('€100.00');
    expect(screen.getByTestId('timesheet-rate-te-2').textContent).toBe('¥50');
    expect(screen.getByTestId('timesheet-rate-te-2').textContent).not.toContain('$');
    expect(screen.getByTestId('timesheet-rate-te-3').textContent).toBe('—');
    expect(screen.getByTestId('timesheet-entry-te-3').textContent).not.toContain('$');
  });

  // Review #5 (#3776): a billed entry may still have its description edited, but
  // the API rejects the PATCH (409 ENTRY_BILLED) if any locked field is PRESENT
  // in the body — so the body must carry only the description for billed rows.
  it('edits a billed entry with a description-only PATCH body and disables the locked inputs', async () => {
    const billed = { ...entry, id: 'te-b', billingStatus: 'billed' };
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/time-entries/timesheet')) return jsonRes({ ...week, days: [{ ...week.days[0], entries: [billed] }, ...week.days.slice(1)] });
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-edit-te-b'));
    expect((screen.getByTestId('timesheet-edit-billable-te-b') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('timesheet-edit-rate-te-b') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('timesheet-edit-description-te-b'), { target: { value: 'patching (rebooted twice)' } });
    fireEvent.click(screen.getByTestId('timesheet-edit-save-te-b'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((a) => a[0] === '/time-entries/te-b' && (a[1] as RequestInit)?.method === 'PATCH');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ description: 'patching (rebooted twice)' });
    });
  });

  it('edits an unbilled entry with the full body (description, isBillable, hourlyRate)', async () => {
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-edit-te-1'));
    expect((screen.getByTestId('timesheet-edit-rate-te-1') as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId('timesheet-edit-rate-te-1'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('timesheet-edit-save-te-1'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((a) => a[0] === '/time-entries/te-1' && (a[1] as RequestInit)?.method === 'PATCH');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ description: 'patching', isBillable: true, hourlyRate: 120 });
    });
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
