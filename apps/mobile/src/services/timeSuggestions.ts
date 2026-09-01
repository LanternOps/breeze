import { coreRequest } from './api';

/**
 * Auto-suggested time entries (W06, #3900). Like `services/timeEntries.ts`, the
 * phone calls the CORE routes (`apps/api/src/routes/timeEntries/suggestions.ts`)
 * with the token it already holds — `/api/v1/mobile/*` has no time routes.
 *
 * This is a thin typed wrapper. It carries no retry logic: replaying a failed
 * confirm is `services/timeEntryQueue.ts`'s job, and it needs the HTTP status to
 * branch, which is why every error here is a `TimeSuggestionError` with `status`.
 *
 * Never send `source`, `orgId`, `currency` or `hourlyRate` on a confirm. The
 * server stamps provenance and currency itself and the request schema is
 * `.strict()`, so an extra key is a 400, not a silently ignored field.
 */

export interface SuggestionSignalRef {
  kind: 'remote_session';
  id: string;
}

export interface TimeSuggestionSignal extends SuggestionSignalRef {
  type: 'terminal' | 'desktop' | 'file_transfer';
  startedAt: string;
  endedAt: string;
  precision: string;
}

export interface TimeSuggestion {
  key: string;
  signals: TimeSuggestionSignal[];
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
  device: { id: string; hostname: string } | null;
  org: { id: string; name: string } | null;
  quickSupport: { attributionLabel: string | null; attributedOrgName: string | null } | null;
  candidateTicket: {
    id: string;
    ticketNumber: string;
    subject: string;
    status: string;
    reason: 'closed_by_you' | 'assigned_to_you';
  } | null;
  otherTickets: Array<{ id: string; ticketNumber: string; subject: string }>;
  suggestedSource: 'remote_session' | 'support_session';
  /**
   * F19: minutes of this window already covered by an existing time entry. The
   * server drops a window that is mostly covered, so a value > 0 here is a
   * PARTIAL overlap the sheet has to show — never silently ignore it, or the
   * technician double-bills the covered minutes.
   */
  alreadyLoggedOverlapMinutes: number;
}

export interface ListSuggestionsResult {
  enabled: boolean;
  date: string;
  timezone: string;
  suggestions: TimeSuggestion[];
  unloggedCount: number;
}

export interface ConfirmSuggestionInput {
  signals: SuggestionSignalRef[];
  startedAt: string;
  /** Omitted for an open-ended window; the server closes it. */
  endedAt?: string;
  /** `null` clears the ticket link explicitly; `undefined` omits the key. */
  ticketId?: string | null;
  description?: string;
}

export interface ConfirmSuggestionResult {
  entry: Record<string, unknown>;
  /**
   * True when the server answered 200 rather than 201: the decisions ledger
   * already held this confirm. That is a SUCCESS for the user (their time is
   * logged), not a conflict — see `classifyDrainOutcome`.
   */
  replay: boolean;
}

export class TimeSuggestionError extends Error {
  /** Alias of `status`, matching `TimeEntryError` and the other mobile error shapes. */
  readonly statusCode?: number;

  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'TimeSuggestionError';
    this.statusCode = status;
  }
}

interface ErrorPayload {
  message?: string;
  code?: string;
  status?: number;
  statusCode?: number;
  body?: { code?: string; error?: string };
}

function asSuggestionError(error: unknown): TimeSuggestionError {
  if (error instanceof TimeSuggestionError) return error;

  const payload = (typeof error === 'object' && error !== null ? error : {}) as ErrorPayload;
  return new TimeSuggestionError(
    payload.body?.error ?? payload.message ?? 'Time suggestion request failed',
    payload.code ?? payload.body?.code,
    // Deliberately left undefined when the transport gave us no status (a
    // network failure). Substituting 0 would make "offline" indistinguishable
    // from a server that really answered 0.
    payload.status ?? payload.statusCode
  );
}

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function narrowSuggestion(row: Partial<TimeSuggestion>): TimeSuggestion {
  return {
    key: row.key ?? '',
    signals: row.signals ?? [],
    startedAt: row.startedAt ?? '',
    endedAt: row.endedAt ?? null,
    durationMinutes: row.durationMinutes ?? null,
    device: row.device ?? null,
    org: row.org ?? null,
    quickSupport: row.quickSupport ?? null,
    candidateTicket: row.candidateTicket ?? null,
    otherTickets: row.otherTickets ?? [],
    suggestedSource: row.suggestedSource ?? 'remote_session',
    alreadyLoggedOverlapMinutes: row.alreadyLoggedOverlapMinutes ?? 0,
  };
}

export async function getSuggestions(
  date: string,
  tz: string = deviceTimeZone()
): Promise<ListSuggestionsResult> {
  try {
    const query = `date=${encodeURIComponent(date)}&tz=${encodeURIComponent(tz)}`;
    const response = await coreRequest<{ data?: Partial<ListSuggestionsResult> }>(
      `/time-entries/suggestions?${query}`
    );
    const data = response.data ?? {};
    return {
      enabled: Boolean(data.enabled),
      date: data.date ?? date,
      timezone: data.timezone ?? tz,
      suggestions: (data.suggestions ?? []).map(narrowSuggestion),
      unloggedCount: data.unloggedCount ?? 0,
    };
  } catch (error) {
    throw asSuggestionError(error);
  }
}

export async function confirmSuggestion(
  input: ConfirmSuggestionInput
): Promise<ConfirmSuggestionResult> {
  try {
    // `ticketId: null` is meaningful (log without a ticket) so it must survive;
    // only `undefined` keys are dropped.
    const body = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined)
    );
    const response = await coreRequest<{ data: Record<string, unknown>; replay?: boolean }>(
      '/time-entries/suggestions/confirm',
      { method: 'POST', body: JSON.stringify(body) }
    );
    return { entry: response.data, replay: response.replay === true };
  } catch (error) {
    throw asSuggestionError(error);
  }
}

async function dismissRequest(signals: SuggestionSignalRef[], method: 'POST' | 'DELETE'): Promise<void> {
  try {
    await coreRequest('/time-entries/suggestions/dismiss', {
      method,
      body: JSON.stringify({ signals }),
    });
  } catch (error) {
    throw asSuggestionError(error);
  }
}

export function dismissSuggestion(signals: SuggestionSignalRef[]): Promise<void> {
  return dismissRequest(signals, 'POST');
}

export function undismissSuggestion(signals: SuggestionSignalRef[]): Promise<void> {
  return dismissRequest(signals, 'DELETE');
}
