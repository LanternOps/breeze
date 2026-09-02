import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/api', () => ({ coreRequest: vi.fn() }));

import { entriesForWeek, timesheetPhase } from './timesheetLoadState';
import type { TimeEntry } from '../../services/timeEntries';

const entry: TimeEntry = {
  id: 'e1',
  ticketId: 'k1',
  startedAt: '2026-08-24T09:00:00.000Z',
  endedAt: '2026-08-24T09:40:00.000Z',
  durationMinutes: 40,
  isBillable: true,
  billingStatus: 'not_billed',
  isApproved: false,
  description: null,
};

describe('entriesForWeek', () => {
  it('returns the entries when they were fetched for this week', () => {
    expect(entriesForWeek({ week: '2026-08-24', entries: [entry] }, '2026-08-24')).toEqual([entry]);
  });

  it('refuses entries fetched for a DIFFERENT week', () => {
    // The T7 defect: the previous week's rows made `entries !== null`, so the
    // error branch was unreachable and the failed week rendered as empty.
    expect(entriesForWeek({ week: '2026-08-17', entries: [entry] }, '2026-08-24')).toBeNull();
  });

  it('has nothing to show before the first load', () => {
    expect(entriesForWeek(null, '2026-08-24')).toBeNull();
  });
});

describe('timesheetPhase', () => {
  it('shows the error when a load failed and this week has no data', () => {
    // Renders "Could not load your timesheet" + Try again, NOT a week of zeroes.
    expect(
      timesheetPhase({ loading: false, loadError: 'Could not load your timesheet.', entries: null })
    ).toBe('error');
  });

  it('shows the spinner while the first load of a week is in flight', () => {
    expect(timesheetPhase({ loading: true, loadError: null, entries: null })).toBe('spinner');
  });

  it('keeps the rows when a REFRESH of an already-loaded week fails', () => {
    // The failure is a banner over real data, not a blanked screen.
    expect(timesheetPhase({ loading: false, loadError: 'boom', entries: [entry] })).toBe('week');
  });

  it('shows a genuinely empty week as a week', () => {
    expect(timesheetPhase({ loading: false, loadError: null, entries: [] })).toBe('week');
  });
});
