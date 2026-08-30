import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { execCalls, execResults, settingsMock } = vi.hoisted(() => ({
  execCalls: [] as unknown[],
  execResults: [] as unknown[][],
  settingsMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { execute: vi.fn((q: unknown) => { execCalls.push(q); return Promise.resolve(execResults.shift() ?? []); }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./timeSuggestionSettings', () => ({
  getSessionSuggestionSettings: (...a: unknown[]) => settingsMock(...a),
  SESSION_SUGGESTION_DEFAULTS: { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 },
}));

import { listTimeSuggestions, countUnloggedSuggestions, loadSignals } from './timeSuggestionService';

const compiled = (i: number) => new PgDialect().sqlToQuery(execCalls[i] as never);
const actor = { userId: 'u1', partnerId: 'p1', manageAll: false, accessibleOrgIds: ['o1'], scope: 'partner' as const };
const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: 's1', type: 'desktop', device_id: 'd1', started_at: new Date('2026-08-29T14:02:00Z'), ended_at: new Date('2026-08-29T14:40:00Z'),
  duration_seconds: 2280, error_message: null, org_id: 'o1', org_name: 'ACME', org_type: 'customer', device_hostname: 'ACME-DC01',
  attributed_org_id: null, attributed_org_name: null, attribution_label: null, ...over,
});

beforeEach(() => { execCalls.length = 0; execResults.length = 0; settingsMock.mockReset(); });

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
