import { coreRequest } from './api';

/**
 * Time-entry surface for mobile. `/api/v1/mobile/*` has no time routes, so the
 * phone calls the core endpoints (`apps/api/src/routes/timeEntries/timeEntries.ts`)
 * with the token it already holds — the same approach as `services/tickets.ts`.
 *
 * These interfaces describe the SUBSET of each response the app consumes. Extra
 * server fields are ignored at runtime; add one here when a screen needs it.
 *
 * Never send `currency` on any write: the server stamps `currency_code` once
 * and rejects clients that try to set it. `hourlyRate` is deliberately absent
 * from `CreateTimeEntryInput` — rates are never computed on the phone.
 */

export type BillingStatus = 'not_billed' | 'billed' | 'no_charge' | 'contract';

export interface RunningTimer {
  /**
   * The server entry id, or null for a timer that exists only on this device
   * because it was started while offline (see services/localTimer.ts). A null
   * id is what tells every surface that this timer has not been created yet:
   * it can be stopped and enqueued as a `create`, but never stopped through
   * `/time-entries/stop`, which would close somebody else's running entry.
   */
  id: string | null;
  /** Set while the timer is device-only; null once the server owns it. */
  localId: string | null;
  ticketId: string | null;
  /**
   * Ticket label fields, joined server-side onto every entry so a row can be
   * labelled without the ticket being in the phone's ticket list — that list
   * is filter-scoped (open, assigned to me, first 50), so resolved tickets and
   * other people's tickets are never in it. Null for device-only timers and
   * entries with no ticket.
   */
  ticketNumber?: string | null;
  ticketSubject?: string | null;
  startedAt: string;
  description: string | null;
}

export interface TimeEntry {
  id: string;
  ticketId: string | null;
  /** See RunningTimer.ticketNumber. */
  ticketNumber?: string | null;
  ticketSubject?: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  isBillable: boolean;
  billingStatus: BillingStatus;
  isApproved: boolean;
  description: string | null;
}

export interface CreateTimeEntryInput {
  ticketId?: string;
  startedAt: string;
  endedAt: string;
  description?: string;
  isBillable?: boolean;
  billingStatus?: BillingStatus;
}

export interface TimesheetDay {
  date: string;
  totalMinutes: number;
  billableMinutes: number;
  entries: TimeEntry[];
}

export interface TimesheetWeek {
  weekStart: string;
  days: TimesheetDay[];
  totals: { totalMinutes: number; billableMinutes: number };
}

export class TimeEntryError extends Error {
  /** Alias of `status`, matching the `statusCode` idiom used by `ApiError` and other mobile error shapes. */
  readonly statusCode?: number;

  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'TimeEntryError';
    this.statusCode = status;
  }
}

type ServerTimeEntry = TimeEntry & Record<string, unknown>;

interface ErrorPayload {
  message?: string;
  code?: string;
  status?: number;
  statusCode?: number;
  body?: { code?: string; error?: string };
}

/**
 * Time-entry errors that reach the phone include ENTRY_RUNNING (409),
 * NO_RUNNING_TIMER (404), ENTRY_BILLED (409), APPROVED_IMMUTABLE,
 * NOT_OWN_ENTRY, and ADMIN_REQUIRED.
 */
function asTimeEntryError(error: unknown): TimeEntryError {
  if (error instanceof TimeEntryError) return error;

  const payload = (typeof error === 'object' && error !== null ? error : {}) as ErrorPayload;
  return new TimeEntryError(
    payload.body?.error ?? payload.message ?? 'Time entry request failed',
    payload.code ?? payload.body?.code,
    payload.status ?? payload.statusCode
  );
}

function compact(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function narrowRunningTimer(row: ServerTimeEntry): RunningTimer {
  return {
    id: row.id,
    localId: null,
    ticketId: row.ticketId ?? null,
    ticketNumber: row.ticketNumber ?? null,
    ticketSubject: row.ticketSubject ?? null,
    startedAt: row.startedAt,
    description: row.description ?? null,
  };
}

function narrowTimeEntry(row: ServerTimeEntry): TimeEntry {
  return {
    id: row.id,
    ticketId: row.ticketId ?? null,
    ticketNumber: row.ticketNumber ?? null,
    ticketSubject: row.ticketSubject ?? null,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? null,
    durationMinutes: row.durationMinutes ?? null,
    isBillable: Boolean(row.isBillable),
    billingStatus: row.billingStatus ?? 'not_billed',
    isApproved: Boolean(row.isApproved),
    description: row.description ?? null,
  };
}

export async function getRunningTimer(): Promise<RunningTimer | null> {
  try {
    const response = await coreRequest<{ data: ServerTimeEntry | null }>('/time-entries/running');
    // `coreRequest` resolves to `{}` on an empty 2xx body, so `data` may be
    // undefined as well as null; both mean "no timer running".
    return response.data == null ? null : narrowRunningTimer(response.data);
  } catch (error) {
    throw asTimeEntryError(error);
  }
}

export async function startTimer(input: {
  ticketId?: string;
  description?: string;
}): Promise<TimeEntry> {
  try {
    const response = await coreRequest<{ data: ServerTimeEntry }>('/time-entries/start', {
      method: 'POST',
      body: JSON.stringify(compact(input)),
    });
    return narrowTimeEntry(response.data);
  } catch (error) {
    throw asTimeEntryError(error);
  }
}

export async function stopTimer(
  input: { description?: string; isBillable?: boolean } = {}
): Promise<TimeEntry> {
  try {
    const response = await coreRequest<{ data: ServerTimeEntry }>('/time-entries/stop', {
      method: 'POST',
      body: JSON.stringify(compact(input)),
    });
    return narrowTimeEntry(response.data);
  } catch (error) {
    throw asTimeEntryError(error);
  }
}

export async function createTimeEntry(input: CreateTimeEntryInput): Promise<TimeEntry> {
  try {
    const response = await coreRequest<{ data: ServerTimeEntry }>('/time-entries', {
      method: 'POST',
      body: JSON.stringify(compact(input)),
    });
    return narrowTimeEntry(response.data);
  } catch (error) {
    throw asTimeEntryError(error);
  }
}

export async function getTimesheet(weekStart: string): Promise<TimesheetWeek> {
  try {
    const response = await coreRequest<{
      data: {
        weekStart: string;
        days: Array<{
          date: string;
          totalMinutes: number;
          billableMinutes: number;
          entries: ServerTimeEntry[];
        }>;
        totals: { totalMinutes: number; billableMinutes: number };
      };
    }>(`/time-entries/timesheet?weekStart=${encodeURIComponent(weekStart)}`);

    return {
      weekStart: response.data.weekStart,
      days: response.data.days.map((day) => ({
        date: day.date,
        totalMinutes: day.totalMinutes,
        billableMinutes: day.billableMinutes,
        entries: day.entries.map(narrowTimeEntry),
      })),
      totals: {
        totalMinutes: response.data.totals.totalMinutes,
        billableMinutes: response.data.totals.billableMinutes,
      },
    };
  } catch (error) {
    throw asTimeEntryError(error);
  }
}

/**
 * Fields the phone is allowed to correct after the fact.
 *
 * Deliberately narrower than `updateTimeEntrySchema`: `hourlyRate` is never
 * computed or sent from a phone, and `startedAt` is absent because moving the
 * START of an entry needs a date picker the timesheet does not have — a
 * mistyped boundary is worse than an uncorrected one. The TIMESHEET UI still
 * offers no boundary editing at all.
 *
 * `endedAt` exists for exactly one caller: the `closeEntry` replay path
 * (services/timeEntryReplay.ts). A timer the SERVER started can only be closed
 * at its true tap time by PATCHing that timestamp onto the running row —
 * `POST /time-entries/stop` stamps `endedAt = now`, which bills a 15:00 stop
 * to whenever the phone reconnected. `updateTimeEntrySchema.endedAt` carries no
 * `notFarFuture` refine and the service recomputes `durationMinutes`, so this
 * closes the row correctly with no backend change.
 */
export interface UpdateTimeEntryInput {
  description?: string | null;
  isBillable?: boolean;
  endedAt?: string;
}

export async function updateTimeEntry(
  id: string,
  input: UpdateTimeEntryInput
): Promise<TimeEntry> {
  try {
    const response = await coreRequest<{ data: ServerTimeEntry }>(
      `/time-entries/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(compact(input)) }
    );
    return narrowTimeEntry(response.data);
  } catch (error) {
    throw asTimeEntryError(error);
  }
}
