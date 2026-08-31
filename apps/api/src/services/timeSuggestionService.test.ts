import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const {
  execCalls, execResults, settingsMock,
  inserted, deletedWhere, createEntryMock, orgLinkMock, readEntryMock,
} = vi.hoisted(() => ({
  execCalls: [] as unknown[],
  execResults: [] as unknown[][],
  settingsMock: vi.fn(),
  inserted: [] as unknown[],
  deletedWhere: [] as unknown[],
  createEntryMock: vi.fn(),
  orgLinkMock: vi.fn(),
  readEntryMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    execute: vi.fn((q: unknown) => { execCalls.push(q); return Promise.resolve(execResults.shift() ?? []); }),
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        inserted.push(v);
        return { onConflictDoNothing: () => ({ returning: () => Promise.resolve(Array.isArray(v) ? v : [v]) }) };
      },
    })),
    delete: vi.fn(() => ({ where: (w: unknown) => { deletedWhere.push(w); return Promise.resolve(); } })),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./timeSuggestionSettings', () => ({
  getSessionSuggestionSettings: (...a: unknown[]) => settingsMock(...a),
  SESSION_SUGGESTION_DEFAULTS: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 },
}));
vi.mock('./timeEntryService', async () => {
  const actual = await vi.importActual<typeof import('./timeEntryService')>('./timeEntryService');
  return {
    ...actual,
    createTimeEntry: (...a: unknown[]) => createEntryMock(...a),
    resolveAndLockOrgLink: (...a: unknown[]) => orgLinkMock(...a),
    readTimeEntryById: (...a: unknown[]) => readEntryMock(...a),
  };
});

import {
  listTimeSuggestions, countUnloggedSuggestions, loadSignals,
  confirmTimeSuggestion, dismissTimeSuggestions, undismissTimeSuggestions,
} from './timeSuggestionService';

const compiled = (i: number) => new PgDialect().sqlToQuery(execCalls[i] as never);
const actor = { userId: 'u1', partnerId: 'p1', manageAll: false, accessibleOrgIds: ['o1'], scope: 'partner' as const };
const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: 's1', type: 'desktop', device_id: 'd1', started_at: new Date('2026-08-29T14:02:00Z'), ended_at: new Date('2026-08-29T14:40:00Z'),
  duration_seconds: 2280, error_message: null, org_id: 'o1', org_name: 'ACME', org_type: 'customer', device_hostname: 'ACME-DC01',
  attributed_org_id: null, attributed_org_name: null, attribution_label: null, ...over,
});

beforeEach(() => {
  execCalls.length = 0; execResults.length = 0; settingsMock.mockReset();
  inserted.length = 0; deletedWhere.length = 0;
  createEntryMock.mockReset(); orgLinkMock.mockReset(); readEntryMock.mockReset();
});

describe('loadSignals — compiled SQL carries the isolation predicates (F1)', () => {
  it('binds user_id, partner_id, the NOT EXISTS decision filter and the org allowlist', async () => {
    execResults.push([]);
    await loadSignals({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['o1', 'o2'], window: { start: new Date('2026-08-29T00:00:00Z'), end: new Date('2026-08-30T00:00:00Z') } });
    const { sql, params } = compiled(0);
    expect(sql).toMatch(/rs\.user_id = \$\d/);
    expect(sql).toMatch(/o\.partner_id = \$\d/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM time_suggestion_decisions/);
    expect(sql).toMatch(/rs\.org_id = ANY\(/);
    expect(sql).toMatch(/rs\.status IN \('disconnected', ?'failed'\)/);
    expect(sql).toMatch(/AT TIME ZONE 'UTC'/);
    expect(params).toEqual(expect.arrayContaining(['u1', 'p1']));
  });
  it('omits the org allowlist for system scope (null) but never the user/partner predicates', async () => {
    execResults.push([]);
    await loadSignals({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: null, ids: ['s1'] });
    const { sql } = compiled(0);
    expect(sql).not.toMatch(/rs\.org_id = ANY/);
    expect(sql).toMatch(/rs\.user_id = \$\d/);
    expect(sql).toMatch(/o\.partner_id = \$\d/);
    expect(sql).toMatch(/rs\.id = ANY\(/);
  });
  // #2655 regression: an array must reach Postgres as ONE BOUND PARAM PER
  // ELEMENT inside an ARRAY[...] constructor. `ANY(${ids}::uuid[])` binds the
  // whole JS array as a single param and dies with `malformed array literal`
  // against a real server while every mock here happily accepts it. Caught by
  // timeSuggestionDecisionsRls.integration.test.ts; pinned in the unit job so
  // the fast suite fails too.
  it('binds ONE param per org id inside ARRAY[...]::uuid[], never the array as one param', async () => {
    execResults.push([]);
    await loadSignals({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['o1', 'o2'], ids: ['s1'] });
    const { sql, params } = compiled(0);
    expect(sql).toMatch(/rs\.org_id = ANY\(ARRAY\[\$\d+, \$\d+\]::uuid\[\]\)/);
    expect(sql).toMatch(/rs\.id = ANY\(ARRAY\[\$\d+\]::uuid\[\]\)/);
    expect(params).toEqual(expect.arrayContaining(['o1', 'o2', 's1']));
  });

  it('an EMPTY org allowlist renders ARRAY[]::uuid[] — matches nothing, never "no filter"', async () => {
    execResults.push([]);
    await loadSignals({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: [], ids: ['s1'] });
    expect(compiled(0).sql).toMatch(/rs\.org_id = ANY\(ARRAY\[\]::uuid\[\]\)/);
  });

  it('an EMPTY org allowlist still narrows (it must never read as "no filter")', async () => {
    execResults.push([]);
    await loadSignals({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: [], ids: ['s1'] });
    expect(compiled(0).sql).toMatch(/rs\.org_id = ANY\(/);
  });
  it('includeDecided drops ONLY the decision filter, never a tenancy predicate', async () => {
    execResults.push([]);
    await loadSignals({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['o1'], ids: ['s1'], includeDecided: true });
    const { sql } = compiled(0);
    expect(sql).not.toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/rs\.user_id = \$\d/);
    expect(sql).toMatch(/o\.partner_id = \$\d/);
    expect(sql).toMatch(/rs\.org_id = ANY\(/);
  });
});

// QUERY ORDER TRAP: listTimeSuggestions issues THREE queries, in this order —
//   0 signals (loadSignals)  1 already-logged ranges (loadLoggedRanges, F19)  2 ticket candidates
// so every test below queues an `execResults.push([])` for the ranges query
// between the signals push and the tickets push. Miss it and the ticket rows
// are consumed as logged ranges and the assertion fails in a confusing place.
describe('listTimeSuggestions', () => {
  it('returns enabled:false and no query when the partner flag is off (F10)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r).toEqual({ enabled: false, date: '2026-08-29', timezone: 'UTC', suggestions: [], unloggedCount: 0 });
    expect(execCalls).toHaveLength(0);
  });
  it('builds a suggestion with device, org, recorded precision and a preselected closed ticket', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'Europe/Berlin' });
    execResults.push([sessionRow()]);                       // 0 signals
    execResults.push([]);                                   // 1 F19 already-logged ranges
    execResults.push([{ id: 't1', ticket_number: 'TKT-1041', subject: 'Printer', status: 'closed', org_id: 'o1', device_id: 'd1', assigned_to: null, closed_by: 'u1', closed_at: new Date('2026-08-29T15:00:00Z'), actor_status_change_at: null, actor_status_change_to: null }]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.enabled).toBe(true);
    expect(r.timezone).toBe('Europe/Berlin');
    expect(r.unloggedCount).toBe(1);
    expect(r.suggestions[0]).toMatchObject({
      key: 's1', durationMinutes: 38, device: { id: 'd1', hostname: 'ACME-DC01' }, org: { id: 'o1', name: 'ACME' },
      quickSupport: null, suggestedSource: 'remote_session',
      candidateTicket: { id: 't1', ticketNumber: 'TKT-1041', reason: 'closed_by_you' },
      signals: [expect.objectContaining({ kind: 'remote_session', id: 's1', precision: 'recorded' })],
    });
  });
  it('drops sessions shorter than minSessionSeconds', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ duration_seconds: 45, ended_at: new Date('2026-08-29T14:02:45Z') })]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions).toEqual([]);
    expect(r.unloggedCount).toBe(0);
  });
  it('merges two adjacent same-device sessions into one keyed suggestion', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ id: 'b', started_at: new Date('2026-08-29T14:45:00Z'), ended_at: new Date('2026-08-29T15:00:00Z'), duration_seconds: 900 }), sessionRow({ id: 'a' })]);
    execResults.push([]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.key).toBe('a+b');
    expect(r.suggestions[0]!.durationMinutes).toBe(58);
  });
  it('Quick Support: hidden org -> org:null, attribution shown, support_session, ticket candidates restricted to the attributed org (D4/D6/F12)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ org_type: 'quick_support', org_name: 'Quick Support', device_hostname: null, attributed_org_id: 'o-acme', attributed_org_name: 'ACME', attribution_label: 'Bob @ ACME' })]);
    execResults.push([]);   // F19 ranges
    execResults.push([]);   // tickets
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions[0]).toMatchObject({ org: null, device: null, suggestedSource: 'support_session', quickSupport: { attributionLabel: 'Bob @ ACME', attributedOrgName: 'ACME' } });
    expect(compiled(2).sql).toMatch(/t\.org_id = \$\d/);   // 0 signals, 1 ranges, 2 tickets
  });
  it('Quick Support with NO attributed org pairs no tickets at all (F12)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ org_type: 'quick_support', device_hostname: null })]);
    execResults.push([]);   // F19 ranges
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions[0]).toMatchObject({ org: null, candidateTicket: null, otherTickets: [] });
    expect(execCalls).toHaveLength(2); // no ticket query was issued
  });
  it('reaper-ended session is unreliable: no duration, endedAt null (F7)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ duration_seconds: null, error_message: 'Session timed out: exceeded maximum session duration', ended_at: new Date('2026-08-30T14:02:00Z') })]);
    execResults.push([]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-30' });
    expect(r.suggestions[0]).toMatchObject({ endedAt: null, durationMinutes: null, signals: [expect.objectContaining({ precision: 'unreliable' })] });
  });
  it('rejects a bad tz with INVALID_TZ and a date older than 31 days with INVALID_RANGE', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    await expect(listTimeSuggestions(actor, { date: '2026-08-29', tz: 'Mars/Olympus' })).rejects.toMatchObject({ code: 'INVALID_TZ', status: 400 });
    await expect(listTimeSuggestions(actor, { date: '2020-01-01' })).rejects.toMatchObject({ code: 'INVALID_RANGE', status: 400 });
    expect(execCalls).toHaveLength(0);
  });

  // ── F19: already logged by hand or by /start + /stop ──────────────────────
  it('drops a session the technician already logged (>= 80% covered) — no duplicate one tap away', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow()]);                                   // 14:02–14:40, 38 min
    execResults.push([{ range_start: new Date('2026-08-29T14:00:00Z'), range_end: new Date('2026-08-29T14:45:00Z') }]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions).toEqual([]);
    expect(r.unloggedCount).toBe(0);
  });
  it('keeps a partially covered session and reports the residual overlap', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow()]);                                   // 38 min
    execResults.push([{ range_start: new Date('2026-08-29T14:02:00Z'), range_end: new Date('2026-08-29T14:12:00Z') }]); // 10 min = 26%
    execResults.push([]);                                              // tickets
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.alreadyLoggedOverlapMinutes).toBe(10);
  });
  it('reports 0 overlap when nothing is logged', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow()]);
    execResults.push([]);
    execResults.push([]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-29' });
    expect(r.suggestions[0]!.alreadyLoggedOverlapMinutes).toBe(0);
  });
  it('the ranges query binds the actor and treats a running timer as [started_at, now)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow()]);
    execResults.push([]);
    execResults.push([]);
    await listTimeSuggestions(actor, { date: '2026-08-29' });
    const { sql, params } = compiled(1);
    expect(sql).toMatch(/te\.user_id = \$\d/);
    expect(sql).toMatch(/COALESCE\(te\.ended_at, b\.now_utc\)/);
    expect(sql).toMatch(/GREATEST\(te\.started_at, b\.day_start\)/);
    expect(sql).toMatch(/LEAST\(COALESCE\(te\.ended_at, b\.now_utc\), b\.day_end\)/);
    expect(params).toEqual(expect.arrayContaining(['u1']));
  });
  it('an unreliable window is never dropped by F19 — we cannot measure it (F7)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ duration_seconds: null, error_message: 'Session timed out: exceeded maximum session duration', ended_at: new Date('2026-08-30T14:02:00Z') })]);
    execResults.push([{ range_start: new Date('2026-08-30T00:00:00Z'), range_end: new Date('2026-08-30T23:59:00Z') }]);
    execResults.push([]);
    const r = await listTimeSuggestions(actor, { date: '2026-08-30' });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]!.alreadyLoggedOverlapMinutes).toBe(0);
  });
  it('reads another technician’s day when a userId is supplied (the route gates manageAll)', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([]);
    execResults.push([]);
    await listTimeSuggestions(actor, { date: '2026-08-29', userId: 'u-other' });
    expect(compiled(0).params).toEqual(expect.arrayContaining(['u-other']));
    expect(compiled(0).params).not.toEqual(expect.arrayContaining(['u1']));
    // …and the F19 already-logged query must follow the SAME technician. If it
    // bound the actor instead, a dispatcher's own logged day would subtract
    // from the technician's sessions and silently empty the list (review W06A).
    expect(compiled(1).params).toEqual(expect.arrayContaining(['u-other']));
    expect(compiled(1).params).not.toEqual(expect.arrayContaining(['u1']));
  });
});

describe('countUnloggedSuggestions (W07 hook)', () => {
  it('returns the post-filter count under system context with the explicit partner predicate', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ id: 'a' }), sessionRow({ id: 'b', device_id: 'd2', started_at: new Date('2026-08-29T16:00:00Z'), ended_at: new Date('2026-08-29T16:30:00Z'), duration_seconds: 1800 })]);
    execResults.push([]);   // F19 ranges
    await expect(countUnloggedSuggestions({ userId: 'u1', partnerId: 'p1', date: '2026-08-29' })).resolves.toBe(2);
    expect(compiled(0).sql).toMatch(/o\.partner_id = \$\d/);
    expect(compiled(0).sql).toMatch(/rs\.user_id = \$\d/);
  });
  it('applies the same F19 filter as list — the push count can never exceed what the screen shows', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow({ id: 'a' }), sessionRow({ id: 'b', device_id: 'd2', started_at: new Date('2026-08-29T16:00:00Z'), ended_at: new Date('2026-08-29T16:30:00Z'), duration_seconds: 1800 })]);
    execResults.push([{ range_start: new Date('2026-08-29T16:00:00Z'), range_end: new Date('2026-08-29T16:30:00Z') }]);
    await expect(countUnloggedSuggestions({ userId: 'u1', partnerId: 'p1', date: '2026-08-29' })).resolves.toBe(1);
  });
  it('is 0 when the flag is off', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    await expect(countUnloggedSuggestions({ userId: 'u1', partnerId: 'p1', date: '2026-08-29' })).resolves.toBe(0);
    expect(execCalls).toHaveLength(0);
  });
  it('never issues a ticket query — it returns a number, not content', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    execResults.push([sessionRow()]);
    execResults.push([]);
    await countUnloggedSuggestions({ userId: 'u1', partnerId: 'p1', date: '2026-08-29' });
    expect(execCalls).toHaveLength(2);
  });
});

// ── Task 8: confirm / dismiss / undismiss ───────────────────────────────────
const enabled = () => settingsMock.mockResolvedValue({ settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
const SIG1 = { kind: 'remote_session' as const, id: 's1' };
const confirmBody = { signals: [SIG1], startedAt: new Date('2026-08-29T14:02:00Z'), endedAt: new Date('2026-08-29T14:40:00Z') };

describe('confirmTimeSuggestion', () => {
  it('403 SUGGESTIONS_DISABLED when the flag is off', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SUGGESTIONS_DISABLED', status: 403 });
    expect(execCalls).toHaveLength(0);
  });

  it('takes an advisory xact lock per signal, then 404s a signal the caller cannot see (F2)', async () => {
    enabled();
    execResults.push([]);   // advisory lock
    execResults.push([]);   // loadSignals (ids) -> nothing visible
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SIGNAL_NOT_FOUND', status: 404 });
    expect(compiled(0).sql).toMatch(/pg_advisory_xact_lock/);
    // The lock key must be per (user, signal) — never a bare signal id, or two
    // technicians confirming different sessions would serialise on each other.
    expect(compiled(0).params).toEqual(expect.arrayContaining(['u1:remote_session:s1']));
  });

  it('locks a merged suggestion in SORTED id order regardless of request order (deadlock guard)', async () => {
    // Two overlapping merged suggestions that acquire the same ids in opposite
    // orders would deadlock. The fixture is deliberately UNSORTED — a sorted
    // one cannot discriminate the `[...ids].sort()`.
    enabled();
    execResults.push([]);   // lock s1
    execResults.push([]);   // lock s2
    execResults.push([]);   // loadSignals -> nothing visible, we only want the locks
    await expect(confirmTimeSuggestion(
      { ...confirmBody, signals: [{ kind: 'remote_session' as const, id: 's2' }, { kind: 'remote_session' as const, id: 's1' }] },
      actor,
    )).rejects.toMatchObject({ code: 'SIGNAL_NOT_FOUND' });
    expect(compiled(0).params).toEqual(expect.arrayContaining(['u1:remote_session:s1']));
    expect(compiled(1).params).toEqual(expect.arrayContaining(['u1:remote_session:s2']));
  });

  it('re-reads signals under the caller RLS + org allowlist (a forged id can only 404)', async () => {
    enabled();
    execResults.push([], []);
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SIGNAL_NOT_FOUND' });
    const { sql } = compiled(1);
    expect(sql).toMatch(/rs\.user_id = \$\d/);
    expect(sql).toMatch(/o\.partner_id = \$\d/);
    expect(sql).toMatch(/rs\.org_id = ANY\(/);
    expect(sql).toMatch(/rs\.id = ANY\(/);
    expect(sql).not.toMatch(/NOT EXISTS/); // includeDecided: a decided signal must reach the ledger branches
  });

  it('happy path: creates a closed entry with remote_session provenance + org link and writes one confirmed decision per signal', async () => {
    enabled();
    execResults.push([]);                                   // lock
    execResults.push([sessionRow()]);                       // signals (includeDecided)
    execResults.push([]);                                   // existing decisions
    orgLinkMock.mockResolvedValue({ orgId: 'o1', currencyCode: 'EUR' });
    createEntryMock.mockResolvedValue({ id: 'e1', orgId: 'o1', ticketId: null, source: 'remote_session' });
    const r = await confirmTimeSuggestion(confirmBody, actor);
    expect(r).toEqual({ entry: expect.objectContaining({ id: 'e1' }), replay: false });
    expect(createEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ startedAt: confirmBody.startedAt, endedAt: confirmBody.endedAt }),
      expect.objectContaining({ userId: 'u1' }),
      { source: 'remote_session', orgLink: { orgId: 'o1', currencyCode: 'EUR' } }
    );
    expect(inserted[0]).toEqual([expect.objectContaining({ partnerId: 'p1', userId: 'u1', signalKind: 'remote_session', signalId: 's1', decision: 'confirmed', timeEntryId: 'e1' })]);
  });

  it('never lets the client choose org, currency or source', async () => {
    enabled();
    execResults.push([], [sessionRow()], []);
    orgLinkMock.mockResolvedValue({ orgId: 'o1', currencyCode: 'EUR' });
    createEntryMock.mockResolvedValue({ id: 'e1', orgId: 'o1' });
    await confirmTimeSuggestion(confirmBody, actor);
    const input = createEntryMock.mock.calls[0]![0] as Record<string, unknown>;
    for (const k of ['source', 'orgId', 'currency', 'currencyCode', 'partnerId']) {
      expect(input).not.toHaveProperty(k);
    }
  });

  it('with a ticket: no org link is resolved (the ticket path stamps org/currency) and a ticket in another org is 422 ORG_MISMATCH (F3)', async () => {
    enabled();
    execResults.push([], [sessionRow()], []);
    execResults.push([{ org_id: 'o-other' }]);              // ticket org probe
    await expect(confirmTimeSuggestion({ ...confirmBody, ticketId: 't-1' }, actor)).rejects.toMatchObject({ code: 'ORG_MISMATCH', status: 422 });
    expect(orgLinkMock).not.toHaveBeenCalled();
    expect(createEntryMock).not.toHaveBeenCalled();
  });

  it('with a matching ticket: passes the ticket through and resolves no org link', async () => {
    enabled();
    execResults.push([], [sessionRow()], []);
    execResults.push([{ org_id: 'o1' }]);
    createEntryMock.mockResolvedValue({ id: 'e6', orgId: 'o1', ticketId: 't-1' });
    await confirmTimeSuggestion({ ...confirmBody, ticketId: 't-1' }, actor);
    expect(orgLinkMock).not.toHaveBeenCalled();
    expect(createEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 't-1' }),
      expect.anything(),
      { source: 'remote_session', orgLink: null }
    );
  });

  it('a ticket that does not exist is 404 TICKET_NOT_FOUND', async () => {
    enabled();
    execResults.push([], [sessionRow()], [], []);
    await expect(confirmTimeSuggestion({ ...confirmBody, ticketId: 't-gone' }, actor)).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND', status: 404 });
  });

  it('Quick Support with no ticket: org NULL, support_session, description prefixed with the attribution label (D6)', async () => {
    enabled();
    execResults.push([], [sessionRow({ org_type: 'quick_support', attribution_label: 'Bob @ ACME' })], []);
    createEntryMock.mockResolvedValue({ id: 'e2', orgId: null });
    await confirmTimeSuggestion({ ...confirmBody, description: 'reset password' }, actor);
    expect(orgLinkMock).not.toHaveBeenCalled();
    expect(createEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Bob @ ACME — reset password' }),
      expect.anything(),
      { source: 'support_session', orgLink: null }
    );
  });

  it('Quick Support WITH a ticket: support_session provenance and no org-agreement check (the QS org is hidden)', async () => {
    // A QS session has no real org, so the F3 `ticket.org_id !== head.orgId`
    // guard is deliberately skipped — a ticket in any org the caller can see
    // under RLS is accepted, and createTimeEntry's own ticket path is what
    // authorises the org. Pin both halves so neither becomes incidental.
    enabled();
    execResults.push([], [sessionRow({ org_type: 'quick_support', org_id: 'o-hidden-qs', attribution_label: 'Bob @ ACME' })], []);
    execResults.push([{ org_id: 'o-different' }]);          // ticket org probe — must NOT raise ORG_MISMATCH
    createEntryMock.mockResolvedValue({ id: 'e7', orgId: 'o-different', ticketId: 't-1' });
    await confirmTimeSuggestion({ ...confirmBody, ticketId: 't-1' }, actor);
    expect(orgLinkMock).not.toHaveBeenCalled();
    expect(createEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 't-1' }),
      expect.anything(),
      { source: 'support_session', orgLink: null }
    );
  });

  it('replay: every signal already confirmed to one entry -> 200 same entry, no new writes (F4)', async () => {
    enabled();
    execResults.push([], [sessionRow()]);
    execResults.push([{ signal_id: 's1', decision: 'confirmed', time_entry_id: 'e1' }]);
    readEntryMock.mockResolvedValue({ id: 'e1', orgId: 'o1', durationMinutes: 38 });
    const r = await confirmTimeSuggestion(confirmBody, actor);
    expect(r.replay).toBe(true);
    expect(r.entry).toMatchObject({ id: 'e1', durationMinutes: 38 });
    expect(createEntryMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('replay whose entry has since vanished is 410, never a silent second entry', async () => {
    enabled();
    execResults.push([], [sessionRow()]);
    execResults.push([{ signal_id: 's1', decision: 'confirmed', time_entry_id: 'e1' }]);
    readEntryMock.mockResolvedValue(null);
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SUGGESTION_ENTRY_DELETED', status: 410 });
    expect(createEntryMock).not.toHaveBeenCalled();
  });

  it('tombstone: confirmed decision whose entry was deleted -> 410 (F5)', async () => {
    enabled();
    execResults.push([], [sessionRow()], [{ signal_id: 's1', decision: 'confirmed', time_entry_id: null }]);
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SUGGESTION_ENTRY_DELETED', status: 410 });
  });

  it('dismissed -> 409', async () => {
    enabled();
    execResults.push([], [sessionRow()], [{ signal_id: 's1', decision: 'dismissed', time_entry_id: null }]);
    await expect(confirmTimeSuggestion(confirmBody, actor)).rejects.toMatchObject({ code: 'SUGGESTION_DISMISSED', status: 409 });
  });

  it('signals spanning two orgs -> 422 ORG_MISMATCH', async () => {
    enabled();
    execResults.push([], []);                                                   // one lock per signal
    execResults.push([sessionRow({ id: 's1' }), sessionRow({ id: 's2', org_id: 'o2' })]);
    execResults.push([]);                                                       // decisions
    await expect(confirmTimeSuggestion({ ...confirmBody, signals: [SIG1, { kind: 'remote_session', id: 's2' }] }, actor))
      .rejects.toMatchObject({ code: 'ORG_MISMATCH' });
    expect(createEntryMock).not.toHaveBeenCalled();
  });

  it('edits outside +/-15 min -> 400 RANGE_OUTSIDE_SIGNAL', async () => {
    enabled();
    execResults.push([], [sessionRow()], []);
    await expect(confirmTimeSuggestion({ ...confirmBody, startedAt: new Date('2026-08-29T13:00:00Z') }, actor))
      .rejects.toMatchObject({ code: 'RANGE_OUTSIDE_SIGNAL', status: 400 });
    expect(createEntryMock).not.toHaveBeenCalled();
  });

  it('unreliable member without endedAt -> 400 ENDED_AT_REQUIRED', async () => {
    enabled();
    execResults.push([], [sessionRow({ duration_seconds: null, error_message: 'Session timed out: exceeded maximum session duration' })], []);
    await expect(confirmTimeSuggestion({ signals: confirmBody.signals, startedAt: confirmBody.startedAt }, actor))
      .rejects.toMatchObject({ code: 'ENDED_AT_REQUIRED', status: 400 });
  });

  it('endedAt omitted on a reliable signal -> envelope end is used', async () => {
    enabled();
    execResults.push([], [sessionRow()], []);
    orgLinkMock.mockResolvedValue({ orgId: 'o1', currencyCode: 'EUR' });
    createEntryMock.mockResolvedValue({ id: 'e1', orgId: 'o1' });
    await confirmTimeSuggestion({ signals: confirmBody.signals, startedAt: confirmBody.startedAt }, actor);
    expect(createEntryMock.mock.calls[0]![0]).toMatchObject({ endedAt: new Date('2026-08-29T14:40:00Z') });
  });

  it('a partial ledger (one of two signals already confirmed) refuses rather than double-logging', async () => {
    enabled();
    execResults.push([], []);
    execResults.push([sessionRow({ id: 's1' }), sessionRow({ id: 's2' })]);
    execResults.push([{ signal_id: 's1', decision: 'confirmed', time_entry_id: 'e1' }]);
    // Assert the CODE, not just the 409: a client branching on `code` must be
    // able to tell this from a genuinely dismissed suggestion, whose remediation
    // (restore it first) cannot work here (review W06A).
    await expect(confirmTimeSuggestion({ ...confirmBody, signals: [SIG1, { kind: 'remote_session', id: 's2' }] }, actor))
      .rejects.toMatchObject({ status: 409, code: 'SUGGESTION_PARTIALLY_LOGGED' });
    expect(createEntryMock).not.toHaveBeenCalled();
  });
});

describe('dismiss / undismiss', () => {
  it('dismiss re-validates ownership via the signal query then inserts ON CONFLICT DO NOTHING', async () => {
    enabled();
    execResults.push([sessionRow()]);
    const recordAuditMutation = vi.fn();
    await dismissTimeSuggestions([SIG1], { ...actor, recordAuditMutation });
    expect(compiled(0).sql).toMatch(/rs\.user_id = \$\d/);
    expect(inserted[0]).toEqual([expect.objectContaining({ decision: 'dismissed', timeEntryId: null, userId: 'u1', partnerId: 'p1' })]);
    expect(recordAuditMutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'time_suggestion.dismissed' }));
  });
  it('a MERGED dismiss records one audit mutation per signal, each with a bare id (review W06A)', async () => {
    // `writeAuditEventAsync` keeps `resource_id` only when the value is a uuid.
    // A joined "<uuidA>+<uuidB>" would land resource_id NULL and an entryIds
    // array whose one element is not an id — forensically dead rows.
    enabled();
    execResults.push([sessionRow({ id: 's1' }), sessionRow({ id: 's2' })]);
    const recordAuditMutation = vi.fn();
    await dismissTimeSuggestions([SIG1, { kind: 'remote_session', id: 's2' }], { ...actor, recordAuditMutation });
    expect(recordAuditMutation).toHaveBeenCalledTimes(2);
    expect(recordAuditMutation.mock.calls.map((c) => (c[0] as { entryId: string }).entryId)).toEqual(['s1', 's2']);
  });
  it('dismiss 404s a signal the caller cannot see', async () => {
    enabled();
    execResults.push([]);
    await expect(dismissTimeSuggestions([SIG1], actor)).rejects.toMatchObject({ code: 'SIGNAL_NOT_FOUND' });
    expect(inserted).toHaveLength(0);
  });
  it('dismiss 403s when the flag is off', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    await expect(dismissTimeSuggestions([SIG1], actor)).rejects.toMatchObject({ code: 'SUGGESTIONS_DISABLED', status: 403 });
  });
  it("undismiss deletes the actor's dismissed rows and confirmed rows with a NULL entry only", async () => {
    enabled();
    const recordAuditMutation = vi.fn();
    await undismissTimeSuggestions([SIG1], { ...actor, recordAuditMutation });
    const where = new PgDialect().sqlToQuery(deletedWhere[0] as never);
    expect(where.sql).toMatch(/"user_id" = \$\d/);
    expect(where.sql).toMatch(/"decision" = \$\d/);
    expect(where.sql).toMatch(/"time_entry_id" is null/i);
    expect(where.sql).toMatch(/"signal_id" in \(/i);
    expect(recordAuditMutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'time_suggestion.undismissed' }));
  });
  it('undismiss 403s when the flag is off', async () => {
    settingsMock.mockResolvedValue({ settings: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 }, timezone: 'UTC' });
    await expect(undismissTimeSuggestions([SIG1], actor)).rejects.toMatchObject({ code: 'SUGGESTIONS_DISABLED', status: 403 });
    expect(deletedWhere).toHaveLength(0);
  });
});
