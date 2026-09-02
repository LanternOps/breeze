import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...args: unknown[]) => coreRequest(...args) }));

import {
  getSuggestions,
  confirmSuggestion,
  dismissSuggestion,
  undismissSuggestion,
  TimeSuggestionError,
} from './timeSuggestions';

const SIG = { kind: 'remote_session' as const, id: '3f2f1d8e-1111-4222-8333-444455556666' };
const S = '2026-08-29T10:00:00.000Z';
const E = '2026-08-29T10:45:00.000Z';

const SUGGESTION = {
  key: 'k1',
  signals: [{ ...SIG, type: 'terminal', startedAt: S, endedAt: E, precision: 'exact' }],
  startedAt: S,
  endedAt: E,
  durationMinutes: 45,
  device: { id: 'd1', hostname: 'HOST-1' },
  org: { id: 'o1', name: 'Acme' },
  quickSupport: null,
  candidateTicket: null,
  otherTickets: [],
  suggestedSource: 'remote_session',
  alreadyLoggedOverlapMinutes: 0,
};

beforeEach(() => { coreRequest.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('getSuggestions', () => {
  it('encodes date and the device tz', async () => {
    coreRequest.mockResolvedValue({ data: { enabled: true, date: '2026-08-29', timezone: 'Europe/Berlin', suggestions: [], unloggedCount: 0 } });
    await getSuggestions('2026-08-29', 'Europe/Berlin');
    expect(coreRequest).toHaveBeenCalledWith(
      '/time-entries/suggestions?date=2026-08-29&tz=Europe%2FBerlin',
    );
  });

  it('defaults tz to the device zone from Intl', async () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
      resolvedOptions: () => ({ timeZone: 'America/Chicago' }),
    } as unknown as Intl.DateTimeFormat);
    coreRequest.mockResolvedValue({ data: { enabled: true, date: '2026-08-29', timezone: 'America/Chicago', suggestions: [], unloggedCount: 0 } });
    await getSuggestions('2026-08-29');
    expect(coreRequest).toHaveBeenCalledWith(
      '/time-entries/suggestions?date=2026-08-29&tz=America%2FChicago',
    );
  });

  it('narrows the result, preserving alreadyLoggedOverlapMinutes', async () => {
    coreRequest.mockResolvedValue({
      data: { enabled: true, date: '2026-08-29', timezone: 'UTC', unloggedCount: 1,
              suggestions: [{ ...SUGGESTION, alreadyLoggedOverlapMinutes: 12 }] },
    });
    const result = await getSuggestions('2026-08-29', 'UTC');
    expect(result.enabled).toBe(true);
    expect(result.unloggedCount).toBe(1);
    expect(result.suggestions[0]!.alreadyLoggedOverlapMinutes).toBe(12);
  });

  it('treats a missing suggestions array as an empty day rather than throwing', async () => {
    coreRequest.mockResolvedValue({ data: { enabled: false, date: '2026-08-29', timezone: 'UTC' } });
    const result = await getSuggestions('2026-08-29', 'UTC');
    expect(result.enabled).toBe(false);
    expect(result.suggestions).toEqual([]);
    expect(result.unloggedCount).toBe(0);
  });
});

describe('confirmSuggestion', () => {
  it('POSTs to /suggestions/confirm and never sends source/orgId/currency', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'e1', ticketId: null, startedAt: S, endedAt: E, durationMinutes: 45, isBillable: true, billingStatus: 'not_billed', isApproved: false, description: null } });
    await confirmSuggestion({ signals: [SIG], startedAt: S, endedAt: E, ticketId: null });

    const [path, options] = coreRequest.mock.calls[0]!;
    expect(path).toBe('/time-entries/suggestions/confirm');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string);
    for (const k of ['source', 'orgId', 'currency', 'currencyCode', 'hourlyRate']) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it('reports replay:false for a fresh 201 and replay:true when the server says so', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'e1', startedAt: S, endedAt: E } });
    await expect(confirmSuggestion({ signals: [SIG], startedAt: S, endedAt: E, ticketId: null }))
      .resolves.toMatchObject({ replay: false });

    coreRequest.mockResolvedValue({ data: { id: 'e1', startedAt: S, endedAt: E }, replay: true });
    await expect(confirmSuggestion({ signals: [SIG], startedAt: S, endedAt: E, ticketId: null }))
      .resolves.toMatchObject({ replay: true });
  });

  it('omits ticketId entirely when it is undefined, but sends an explicit null', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'e1', startedAt: S, endedAt: E } });
    await confirmSuggestion({ signals: [SIG], startedAt: S, endedAt: E });
    expect(JSON.parse(coreRequest.mock.calls[0]![1].body as string)).not.toHaveProperty('ticketId');

    coreRequest.mockReset();
    coreRequest.mockResolvedValue({ data: { id: 'e1', startedAt: S, endedAt: E } });
    await confirmSuggestion({ signals: [SIG], startedAt: S, endedAt: E, ticketId: null });
    expect(JSON.parse(coreRequest.mock.calls[0]![1].body as string).ticketId).toBeNull();
  });
});

describe('dismiss / undismiss', () => {
  it('dismiss POSTs and undismiss DELETEs the same path', async () => {
    coreRequest.mockResolvedValue({});
    await dismissSuggestion([SIG]);
    expect(coreRequest.mock.calls[0]![0]).toBe('/time-entries/suggestions/dismiss');
    expect(coreRequest.mock.calls[0]![1].method).toBe('POST');

    coreRequest.mockReset();
    coreRequest.mockResolvedValue({});
    await undismissSuggestion([SIG]);
    expect(coreRequest.mock.calls[0]![0]).toBe('/time-entries/suggestions/dismiss');
    expect(coreRequest.mock.calls[0]![1].method).toBe('DELETE');
  });

  it('sends only { signals } — the server schema is .strict() and rejects extras', async () => {
    coreRequest.mockResolvedValue({});
    await dismissSuggestion([SIG]);
    expect(JSON.parse(coreRequest.mock.calls[0]![1].body as string)).toEqual({ signals: [SIG] });
  });
});

describe('error surface', () => {
  it('surfaces the HTTP status so the queue can branch on 409/410/404/403', async () => {
    coreRequest.mockRejectedValue({ status: 409, body: { error: 'Already dismissed', code: 'SUGGESTION_DISMISSED' } });
    await expect(confirmSuggestion({ signals: [SIG], startedAt: S, endedAt: E, ticketId: null }))
      .rejects.toMatchObject({ name: 'TimeSuggestionError', status: 409, statusCode: 409, code: 'SUGGESTION_DISMISSED' });
  });

  it('falls back to statusCode when the thrown shape uses that alias', async () => {
    coreRequest.mockRejectedValue({ statusCode: 403, message: 'disabled' });
    await expect(getSuggestions('2026-08-29', 'UTC')).rejects.toMatchObject({ status: 403 });
  });

  it('a network failure with no status becomes status undefined, not 0', async () => {
    // classifyDrainOutcome maps a missing status to retry; inventing a 0 here
    // would let a real 0 and "no status at all" become indistinguishable.
    coreRequest.mockRejectedValue(new Error('Network request failed'));
    await expect(getSuggestions('2026-08-29', 'UTC')).rejects.toMatchObject({
      name: 'TimeSuggestionError', status: undefined,
    });
  });

  it('re-throws an existing TimeSuggestionError unchanged', async () => {
    const original = new TimeSuggestionError('boom', 'X', 500);
    coreRequest.mockRejectedValue(original);
    await expect(getSuggestions('2026-08-29', 'UTC')).rejects.toBe(original);
  });
});
