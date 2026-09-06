import { describe, it, expect, vi, beforeEach } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...args: unknown[]) => coreRequest(...args) }));

import {
  createTimeEntry,
  getRunningTimer,
  getTimesheet,
  startTimer,
  stopTimer,
  TimeEntryError,
  updateTimeEntry,
} from './timeEntries';

const ENTRY = {
  id: 'e1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', endedAt: null,
  durationMinutes: null, isBillable: true, billingStatus: 'not_billed', isApproved: false, description: null,
  // The API joins the ticket onto every entry (entrySelection in
  // timeEntryService.ts) so the timesheet can label a row without the ticket
  // being in the phone's filter-scoped ticket list, which excludes resolved
  // and other people's tickets.
  ticketNumber: 'T-2026-0002', ticketSubject: 'Printer offline',
};

beforeEach(() => { coreRequest.mockReset(); });

describe('getRunningTimer', () => {
  it('returns null when no timer is running', async () => {
    coreRequest.mockResolvedValue({ data: null });
    await expect(getRunningTimer()).resolves.toBeNull();
    expect(coreRequest).toHaveBeenCalledWith('/time-entries/running');
  });

  it('treats an empty response body (data undefined) as no timer running', async () => {
    coreRequest.mockResolvedValue({});
    await expect(getRunningTimer()).resolves.toBeNull();
  });

  it('narrows the running-timer payload', async () => {
    coreRequest.mockResolvedValue({
      data: {
        id: 't1', ticketId: 'k1', startedAt: '2026-08-23T10:00:00Z', description: 'onsite',
        ticketNumber: 'T-2026-0002', ticketSubject: 'Printer offline', extra: 'ignored',
      },
    });
    const timer = await getRunningTimer();
    // `localId: null` is the marker that the SERVER owns this timer, as
    // opposed to one this device is ticking that has no entry yet.
    expect(timer).toEqual({
      id: 't1',
      localId: null,
      ticketId: 'k1',
      startedAt: '2026-08-23T10:00:00Z',
      description: 'onsite',
      ticketNumber: 'T-2026-0002',
      ticketSubject: 'Printer offline',
    });
  });

  it('defaults the ticket label fields to null when the entry has no ticket', async () => {
    coreRequest.mockResolvedValue({
      data: { id: 't2', ticketId: null, startedAt: '2026-08-23T10:00:00Z', description: null },
    });
    const timer = await getRunningTimer();
    expect(timer).toMatchObject({ ticketId: null, ticketNumber: null, ticketSubject: null });
  });
});

describe('startTimer', () => {
  it('surfaces ENTRY_RUNNING as a typed error rather than throwing raw', async () => {
    coreRequest.mockRejectedValue(
      Object.assign(new Error('Timer start conflicted'), { status: 409, body: { code: 'ENTRY_RUNNING' } }),
    );
    await expect(startTimer({ ticketId: 'k1' })).rejects.toMatchObject({
      code: 'ENTRY_RUNNING',
      status: 409,
      statusCode: 409,
    });
    await expect(startTimer({ ticketId: 'k1' })).rejects.toBeInstanceOf(TimeEntryError);
  });

  it('maps the ApiError shape coreRequest actually throws ({ message, code, statusCode })', async () => {
    // `services/api.ts` rejects with a plain object, not an Error, and puts the
    // server's `code` at the top level with the HTTP status under `statusCode`.
    coreRequest.mockRejectedValue({ message: 'A timer is already running', code: 'ENTRY_RUNNING', statusCode: 409 });
    await expect(startTimer({ ticketId: 'k1' })).rejects.toMatchObject({
      name: 'TimeEntryError',
      message: 'A timer is already running',
      code: 'ENTRY_RUNNING',
      status: 409,
    });
  });

  it('omits absent optional fields instead of sending nulls', async () => {
    coreRequest.mockResolvedValue({ data: ENTRY });
    await startTimer({ ticketId: 'k1' });
    const [path, options] = coreRequest.mock.calls[0];
    expect(path).toBe('/time-entries/start');
    expect((options as { method: string }).method).toBe('POST');
    expect(JSON.parse((options as { body: string }).body)).toEqual({ ticketId: 'k1' });
  });
});

describe('stopTimer', () => {
  it('posts an empty body by default and narrows the stopped entry', async () => {
    coreRequest.mockResolvedValue({ data: { ...ENTRY, endedAt: '2026-08-23T10:30:00Z', durationMinutes: 30, extra: 1 } });
    const entry = await stopTimer();
    const [path, options] = coreRequest.mock.calls[0];
    expect(path).toBe('/time-entries/stop');
    expect(JSON.parse((options as { body: string }).body)).toEqual({});
    expect(entry).toEqual({ ...ENTRY, endedAt: '2026-08-23T10:30:00Z', durationMinutes: 30 });
  });

  it('surfaces NO_RUNNING_TIMER as a typed error', async () => {
    coreRequest.mockRejectedValue({ message: 'No running timer', code: 'NO_RUNNING_TIMER', statusCode: 404 });
    await expect(stopTimer({ isBillable: false })).rejects.toMatchObject({ code: 'NO_RUNNING_TIMER', status: 404 });
  });
});

describe('createTimeEntry', () => {
  it('posts to the collection, never sends currency, and drops undefined fields', async () => {
    coreRequest.mockResolvedValue({ data: { ...ENTRY, endedAt: '2026-08-23T11:00:00Z', durationMinutes: 60 } });
    await createTimeEntry({
      ticketId: 'k1',
      startedAt: '2026-08-23T10:00:00Z',
      endedAt: '2026-08-23T11:00:00Z',
      description: undefined,
      isBillable: true,
    });
    const [path, options] = coreRequest.mock.calls[0];
    expect(path).toBe('/time-entries');
    expect((options as { method: string }).method).toBe('POST');
    const body = JSON.parse((options as { body: string }).body);
    expect(body).toEqual({
      ticketId: 'k1',
      startedAt: '2026-08-23T10:00:00Z',
      endedAt: '2026-08-23T11:00:00Z',
      isBillable: true,
    });
    expect(body).not.toHaveProperty('currency');
  });

  it('wraps ENTRY_BILLED conflicts in TimeEntryError', async () => {
    coreRequest.mockRejectedValue({ message: 'Entry already billed', code: 'ENTRY_BILLED', statusCode: 409 });
    await expect(
      createTimeEntry({ startedAt: '2026-08-23T10:00:00Z', endedAt: '2026-08-23T11:00:00Z' }),
    ).rejects.toBeInstanceOf(TimeEntryError);
    await expect(
      createTimeEntry({ startedAt: '2026-08-23T10:00:00Z', endedAt: '2026-08-23T11:00:00Z' }),
    ).rejects.toMatchObject({ code: 'ENTRY_BILLED', status: 409 });
  });

  it('pins the defaults applied to a sparse server payload', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'e2', startedAt: '2026-08-23T10:00:00Z' } });
    const entry = await createTimeEntry({ startedAt: '2026-08-23T10:00:00Z', endedAt: '2026-08-23T11:00:00Z' });
    expect(entry).toEqual({
      id: 'e2',
      ticketId: null,
      ticketNumber: null,
      ticketSubject: null,
      startedAt: '2026-08-23T10:00:00Z',
      endedAt: null,
      durationMinutes: null,
      isBillable: false,
      billingStatus: 'not_billed',
      isApproved: false,
      description: null,
    });
  });
});

describe('getTimesheet', () => {
  it('requests the week and narrows days, entries and totals', async () => {
    coreRequest.mockResolvedValue({
      data: {
        weekStart: '2026-08-17',
        days: [
          { date: '2026-08-17', totalMinutes: 60, billableMinutes: 30, entries: [{ ...ENTRY, endedAt: 'x', durationMinutes: 60, serverOnly: true }] },
        ],
        totals: { totalMinutes: 60, billableMinutes: 30, billableAmounts: [{ currencyCode: 'USD', amount: 50 }] },
      },
    });
    const week = await getTimesheet('2026-08-17');
    expect(coreRequest).toHaveBeenCalledWith('/time-entries/timesheet?weekStart=2026-08-17');
    expect(week.weekStart).toBe('2026-08-17');
    expect(week.totals).toEqual({ totalMinutes: 60, billableMinutes: 30 });
    expect(week.days).toHaveLength(1);
    expect(week.days[0]).toMatchObject({ date: '2026-08-17', totalMinutes: 60, billableMinutes: 30 });
    expect(week.days[0].entries[0]).toEqual({ ...ENTRY, endedAt: 'x', durationMinutes: 60 });
  });
});

describe('updateTimeEntry', () => {
  it('PATCHes only the fields the caller passed', async () => {
    coreRequest.mockResolvedValue({ data: { ...ENTRY, description: 'fixed' } });
    await updateTimeEntry('e1', { description: 'fixed' });
    const [path, options] = coreRequest.mock.calls[0];
    expect(path).toBe('/time-entries/e1');
    expect((options as { method: string }).method).toBe('PATCH');
    expect(JSON.parse((options as { body: string }).body)).toEqual({ description: 'fixed' });
  });

  it('sends an explicit false for isBillable rather than dropping it', async () => {
    // `compact` drops undefined, and `false` is a legitimate value here — a
    // dropped one silently leaves the entry billable.
    coreRequest.mockResolvedValue({ data: { ...ENTRY, isBillable: false } });
    await updateTimeEntry('e1', { isBillable: false });
    const [, options] = coreRequest.mock.calls[0];
    expect(JSON.parse((options as { body: string }).body)).toEqual({ isBillable: false });
  });

  it('surfaces a locked row as a typed error the screen can name', async () => {
    coreRequest.mockRejectedValue(
      Object.assign(new Error('Entry is billed'), { statusCode: 409, code: 'ENTRY_BILLED' })
    );
    await expect(updateTimeEntry('e1', { description: 'x' })).rejects.toMatchObject({
      code: 'ENTRY_BILLED',
      status: 409,
    });
  });
});
