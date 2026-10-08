import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

let canManageBilling = true;
// #8133: time_entries:write gates the Delete action separately from billing.
let canWriteTime = true;
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: (_r: string, action: string) => (action === 'write' ? canWriteTime : canManageBilling) }),
}));
beforeEach(() => { canManageBilling = true; canWriteTime = true; });
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import TimesheetPage from './TimesheetPage';
import { resetWorkTypeCache } from '../shared/WorkTypeSelect';

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
  resetWorkTypeCache();
  window.location.hash = '#week=2026-06-08';
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url === '/billing-profiles/work-types') return { ok: true, json: async () => ({ workTypes: [{ id: 'wt-2', name: 'On-site', isActive: true }] }) } as Response;
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

  it('renders AccessDenied (not a load error) when the own-sheet GET is 403', async () => {
    window.location.hash = '#week=2026-06-08';
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/time-entries/timesheet')) return { ok: false, status: 403, json: async () => ({}) } as Response;
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    expect(await screen.findByTestId('timesheet-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('timesheet-error')).not.toBeInTheDocument();
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
    expect(screen.getByTestId('timesheet-edit-work-type')).toBeDisabled();
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

  it('sends only changed billing overrides for an unbilled entry', async () => {
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-edit-te-1'));
    expect((screen.getByTestId('timesheet-edit-rate-te-1') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByTestId('timesheet-edit-rate-te-1')).toHaveProperty('readOnly', false);
    fireEvent.change(screen.getByTestId('timesheet-edit-rate-te-1'), { target: { value: '120' } });
    expect(screen.getByTestId('timesheet-edit-outcome-te-1')).toHaveTextContent('€120.00/h');
    fireEvent.click(screen.getByTestId('timesheet-edit-save-te-1'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((a) => a[0] === '/time-entries/te-1' && (a[1] as RequestInit)?.method === 'PATCH');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ description: 'patching', hourlyRate: 120 });
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

  // BQ-6: a PATCH 404 means the row was deleted underneath the tech (e.g. by
  // another session). Editing must not leave a ghost row stuck in edit mode —
  // exit edit mode and refetch so the row disappears from the list.
  it('exits edit mode and refetches the sheet when saving a 404d (deleted) entry', async () => {
    // Keyed on the exact requested weekStart, not a raw call count — the
    // component's "seed" mount fires an extra timesheet request for today's
    // Monday before the hash-adopted week=2026-06-08 request lands (#2421),
    // and a call-count-based counter would miscount which response is which.
    let weekCalls = 0;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/time-entries/te-1' && init?.method === 'PATCH') {
        return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as Response;
      }
      if (url.startsWith('/time-entries/timesheet?weekStart=2026-06-08')) {
        weekCalls += 1;
        // Second load of THIS week (post-404 refetch): the entry is gone.
        return jsonRes(weekCalls === 1 ? week : { ...week, days: [{ ...week.days[0], entries: [] }, ...week.days.slice(1)] });
      }
      if (url.startsWith('/time-entries/timesheet')) return jsonRes(week); // discarded seed-mount response
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-edit-te-1'));
    fireEvent.click(screen.getByTestId('timesheet-edit-save-te-1'));
    await waitFor(() => expect(screen.queryByTestId('timesheet-edit-description-te-1')).toBeNull());
    await waitFor(() => expect(weekCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByTestId('timesheet-entry-te-1')).toBeNull());
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

it('MOUNT: timesheet shows the Work Type column and PATCHes the selected workTypeId', async () => {
  render(<TimesheetPage />);
  expect(await screen.findByTestId('timesheet-header-work-type')).toHaveTextContent('Work Type');
  fireEvent.click(await screen.findByTestId('timesheet-edit-te-1'));
  const picker = screen.getByTestId('timesheet-edit-work-type');
  await waitFor(() => expect(picker).toBeEnabled());
  fireEvent.change(picker, { target: { value: 'wt-2' } });
  fireEvent.click(screen.getByTestId('timesheet-edit-save-te-1'));
  await waitFor(() => {
    const call = fetchWithAuth.mock.calls.find((args) => args[0] === '/time-entries/te-1' && args[1]?.method === 'PATCH');
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body).workTypeId).toBe('wt-2');
  });
});

it('MOUNT: displays an archived row label and can explicitly clear it', async () => {
  const priorRoute = fetchWithAuth.getMockImplementation()!;
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.startsWith('/time-entries/timesheet')) return jsonRes({ ...week, days: [{ ...week.days[0], entries: [{ ...entry, workTypeId: 'wt-old', workType: { id: 'wt-old', name: 'Legacy', isActive: false } }] }] });
    return priorRoute(url);
  });
  render(<TimesheetPage />);
  expect(await screen.findByTestId('timesheet-work-type-te-1')).toHaveTextContent('Legacy');
  fireEvent.click(screen.getByTestId('timesheet-edit-te-1'));
  const picker = screen.getByTestId('timesheet-edit-work-type');
  await waitFor(() => expect(picker).toBeEnabled());
  expect(picker).toHaveValue('wt-old');
  expect(picker).toHaveTextContent('Legacy (archived)');
  fireEvent.change(picker, { target: { value: '' } });
  fireEvent.click(screen.getByTestId('timesheet-edit-save-te-1'));
  await waitFor(() => {
    const call = fetchWithAuth.mock.calls.find((args) => args[0] === '/time-entries/te-1' && args[1]?.method === 'PATCH');
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body).workTypeId).toBeNull();
  });
});


it('shows the billing outcome and prevents unauthorized billing overrides', async () => {
  canManageBilling = false;
  render(<TimesheetPage />);
  expect(await screen.findByTestId('timesheet-outcome-te-1')).toHaveTextContent('€100.00');
  fireEvent.click(screen.getByTestId('timesheet-edit-te-1'));
  expect(screen.getByTestId('timesheet-edit-rate-te-1')).toHaveProperty('readOnly', true);
  expect(screen.getByTestId('timesheet-edit-billable-te-1')).toBeDisabled();
  fireEvent.click(screen.getByTestId('timesheet-edit-save-te-1'));
  await waitFor(() => expect(fetchWithAuth.mock.calls.some(([url, init]) => url === '/time-entries/te-1' && init?.method === 'PATCH')).toBe(true));
  const body = JSON.parse(fetchWithAuth.mock.calls.find(([url, init]) => url === '/time-entries/te-1' && init?.method === 'PATCH')![1].body);
  expect(body).not.toHaveProperty('hourlyRate');
  expect(body).not.toHaveProperty('isBillable');
});


it('preserves an overridden outcome when the work type changes', async () => {
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.startsWith('/time-entries/timesheet')) return jsonRes({ ...week, days: [{ ...week.days[0], entries: [{ ...entry, billingOverridden: true }] }, ...week.days.slice(1)] });
    if (url === '/billing-profiles/work-types') return { ok: true, json: async () => ({ workTypes: [{ id: 'wt-2', name: 'On-site', isActive: true }] }) } as Response;
    return jsonRes([]);
  });
  render(<TimesheetPage />);
  fireEvent.click(await screen.findByTestId('timesheet-edit-te-1'));
  await waitFor(() => expect(screen.getByTestId('timesheet-edit-work-type').querySelector('option[value="wt-2"]')).not.toBeNull());
  fireEvent.change(screen.getByTestId('timesheet-edit-work-type'), { target: { value: 'wt-2' } });
  expect(screen.getByTestId('timesheet-edit-outcome-te-1')).toHaveTextContent('€100.00/h');
  expect(screen.getByTestId('timesheet-edit-outcome-te-1')).not.toHaveTextContent('recalculated');
});

describe('worked vs billed hours on the timesheet (#4628 W03)', () => {
  const withEntry = (over: Record<string, unknown>, dayOver: Record<string, unknown> = {}) => ({
    ...week,
    days: [
      { date: '2026-06-08', totalMinutes: 30, billableMinutes: 30, ...dayOver, entries: [{ ...entry, ...over }] },
      ...['09', '10', '11', '12', '13', '14'].map((d) => ({ date: `2026-06-${d}`, totalMinutes: 0, billableMinutes: 0, entries: [] })),
    ],
    totals: { totalMinutes: 30, billableMinutes: 30, billableAmounts: [{ currencyCode: 'USD', amount: '225.00' }] },
  });
  const serve = (sheet: unknown) => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === '/billing-profiles/work-types') return { ok: true, json: async () => ({ workTypes: [] }) } as Response;
      if (url.startsWith('/time-entries/timesheet')) return jsonRes(sheet);
      if (url.startsWith('/users')) return jsonRes([{ id: 'u-1', name: 'Todd', email: 't@x' }]);
      return jsonRes({});
    });
  };

  it('shows billed vs worked on an entry row', async () => {
    serve(withEntry({ durationMinutes: 30, billableMinutes: 60 }));
    render(<TimesheetPage />);
    expect(await screen.findByText('0.50 h worked · 1.00 h billed')).toBeInTheDocument();
  });

  it('day totals still report ACTUAL minutes, not the billed quantity (§3.5)', async () => {
    // The day must carry a DIFFERENT billed figure, or the negative below is
    // unfalsifiable: with both at 30 nothing in the payload could render as
    // "1h 0m", and the assertion would pass however the component read it.
    serve(withEntry({ durationMinutes: 30, billableMinutes: 60 }, { billableMinutes: 60 }));
    render(<TimesheetPage />);
    expect((await screen.findByTestId('timesheet-day-2026-06-08')).textContent).toContain('30m');
    expect(screen.getByTestId('timesheet-day-2026-06-08').textContent).not.toContain('1h 0m');
  });

  it('adds no line when the billed quantity equals the worked time', async () => {
    serve(withEntry({ durationMinutes: 60, billableMinutes: 60 }));
    render(<TimesheetPage />);
    await screen.findByTestId('timesheet-entry-te-1');
    expect(screen.queryByText(/h worked ·/)).toBeNull();
  });
});

// #8133: delete an entry from the timesheet row.
describe('TimesheetPage — delete entry (#8133)', () => {
  beforeEach(() => { showToast.mockReset(); });
  const sheetWith = (rows: unknown[]) => ({ ...week, days: [{ ...week.days[0], entries: rows }, ...week.days.slice(1)] });
  const routeWith = (rows: unknown[], onDelete: (url: string) => Response) => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return onDelete(url);
      if (url.startsWith('/time-entries/timesheet')) return jsonRes(sheetWith(rows));
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
  };

  it('deletes an unbilled entry only after the confirm dialog, then reloads the week', async () => {
    routeWith([entry], () => jsonRes({ deleted: true }));
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-delete-te-1'));
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/time-entries/te-1', expect.anything());
    expect((await screen.findByTestId('timesheet-delete-dialog')).textContent).toContain('T-2026-0042');
    const loads = () => fetchWithAuth.mock.calls.filter(([u]) => String(u).startsWith('/time-entries/timesheet'));
    const loadsBefore = loads().length;
    fireEvent.click(screen.getByTestId('timesheet-delete-confirm'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/te-1', expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Entry deleted' })));
    await waitFor(() => expect(loads().length).toBe(loadsBefore + 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(loads().length).toBe(loadsBefore + 1);
  });

  it('reloads once (via the timer event) after deleting the running timer', async () => {
    routeWith([{ ...entry, id: 'run-1', endedAt: null }], () => jsonRes({ deleted: true }));
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-delete-run-1'));
    const loads = () => fetchWithAuth.mock.calls.filter(([u]) => String(u).startsWith('/time-entries/timesheet'));
    const loadsBefore = loads().length;
    fireEvent.click(await screen.findByTestId('timesheet-delete-confirm'));
    await waitFor(() => expect(loads().length).toBe(loadsBefore + 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(loads().length).toBe(loadsBefore + 1);
  });

  it('does not reload the old week when a delete settles after the user moved on', async () => {
    let resolveDelete: (r: Response) => void = () => {};
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Promise<Response>((r) => { resolveDelete = r; });
      if (url.startsWith('/time-entries/timesheet')) return jsonRes(sheetWith([entry]));
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-delete-te-1'));
    fireEvent.click(await screen.findByTestId('timesheet-delete-confirm'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/te-1', expect.objectContaining({ method: 'DELETE' })));
    fireEvent.click(screen.getByTestId('timesheet-prev-week'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(expect.stringContaining('weekStart=2026-06-01')));
    const loads = () => fetchWithAuth.mock.calls.filter(([u]) => String(u).startsWith('/time-entries/timesheet'));
    const settledBefore = loads().length;
    resolveDelete(jsonRes({ deleted: true }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    await new Promise((r) => setTimeout(r, 50));
    expect(loads().length).toBe(settledBefore);
    expect(String(loads().at(-1)?.[0])).toContain('weekStart=2026-06-01');
  });

  it('a delete that settles after a week switch leaves the new week\'s confirm open and usable', async () => {
    let resolveDelete: (r: Response) => void = () => {};
    const older = { ...entry, id: 'te-old', startedAt: '2026-06-01T09:00:00Z', endedAt: '2026-06-01T10:30:00Z' };
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Promise<Response>((r) => { resolveDelete = r; });
      if (url.startsWith('/time-entries/timesheet')) {
        return jsonRes(url.includes('weekStart=2026-06-01')
          ? { ...sheetWith([older]), weekStart: '2026-06-01', days: [{ ...week.days[0], date: '2026-06-01', entries: [older] }, ...week.days.slice(1)] }
          : sheetWith([entry]));
      }
      if (url.startsWith('/users')) return jsonRes([]);
      return jsonRes({});
    });
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-delete-te-1'));
    fireEvent.click(await screen.findByTestId('timesheet-delete-confirm'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/time-entries/te-1', expect.objectContaining({ method: 'DELETE' })));
    fireEvent.click(screen.getByTestId('timesheet-prev-week'));
    fireEvent.click(await screen.findByTestId('timesheet-delete-te-old'));
    expect(await screen.findByTestId('timesheet-delete-dialog')).toBeInTheDocument();
    expect((screen.getByTestId('timesheet-delete-confirm') as HTMLButtonElement).disabled).toBe(false);
    resolveDelete(jsonRes({ deleted: true }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('timesheet-delete-dialog')).toBeInTheDocument();
    expect((screen.getByTestId('timesheet-delete-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('localizes the not-found refusal', async () => {
    routeWith([entry], () => ({ ok: false, status: 404, json: async () => ({ error: 'Time entry not found', code: 'ENTRY_NOT_FOUND' }) }) as Response);
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-delete-te-1'));
    fireEvent.click(await screen.findByTestId('timesheet-delete-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'This entry no longer exists.' })));
  });

  it('names no ticket for a standalone entry', async () => {
    routeWith([{ ...entry, id: 'solo-1', ticketId: null, ticketNumber: null }], () => jsonRes({ deleted: true }));
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-delete-solo-1'));
    const text = (await screen.findByTestId('timesheet-delete-dialog')).textContent ?? '';
    expect(text).toContain('This permanently removes the 1h 30m entry. It can\'t be undone.');
    expect(text).not.toContain('null');
    // No dead link for an entry without a ticket.
    const row = screen.getByTestId('timesheet-entry-solo-1');
    expect(row.querySelector('a[href="/tickets/null"]')).toBeNull();
  });

  it('closes an open confirm when the week changes, deleting nothing', async () => {
    routeWith([entry], () => jsonRes({ deleted: true }));
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-delete-te-1'));
    expect(await screen.findByTestId('timesheet-delete-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('timesheet-prev-week'));
    await waitFor(() => expect(screen.queryByTestId('timesheet-delete-dialog')).toBeNull());
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/time-entries/te-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('uses delete wording when the server says the entry is not the caller\'s', async () => {
    routeWith([entry], () => ({ ok: false, status: 403, json: async () => ({ error: 'You can only manage your own time entries', code: 'NOT_OWN_ENTRY' }) }) as Response);
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-delete-te-1'));
    fireEvent.click(await screen.findByTestId('timesheet-delete-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'You can only delete your own time entries.',
    })));
  });

  it('offers no Delete on an invoiced entry', async () => {
    routeWith([{ ...entry, id: 'billed-1', billingStatus: 'billed' }, { ...entry, id: 'open-1' }], () => jsonRes({}));
    render(<TimesheetPage />);
    expect(await screen.findByTestId('timesheet-delete-open-1')).toBeInTheDocument();
    expect(screen.queryByTestId('timesheet-delete-billed-1')).toBeNull();
  });

  it('offers no Delete without time-entry write permission', async () => {
    canWriteTime = false;
    routeWith([entry], () => jsonRes({}));
    render(<TimesheetPage />);
    expect(await screen.findByTestId('timesheet-edit-te-1')).toBeInTheDocument();
    expect(screen.queryByTestId('timesheet-delete-te-1')).toBeNull();
  });

  it('shows the friendly refusal when the server says the entry is invoiced', async () => {
    routeWith([entry], () => ({ ok: false, status: 409, json: async () => ({ error: 'This entry has been invoiced and cannot be deleted; void the invoice first', code: 'ENTRY_BILLED' }) }) as Response);
    render(<TimesheetPage />);
    fireEvent.click(await screen.findByTestId('timesheet-delete-te-1'));
    fireEvent.click(await screen.findByTestId('timesheet-delete-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: "This entry has been invoiced and can't be deleted. Void the invoice first.",
    })));
  });
});
