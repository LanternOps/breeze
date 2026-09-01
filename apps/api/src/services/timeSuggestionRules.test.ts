import { describe, it, expect } from 'vitest';
import {
  dayWindowUtc, classifySignal, mergeSignals, suggestionKey, envelopeOf,
  rankTicketCandidates, validateConfirmRange,
  mergeRanges, overlapMs, alreadyLoggedVerdict, ALREADY_LOGGED_DROP_RATIO,
  type SignalRow, type TicketCandidateRow
} from './timeSuggestionRules';

const d = (s: string) => new Date(s);
const sig = (over: Partial<SignalRow>): SignalRow => ({
  id: 's1', type: 'desktop', deviceId: 'dev-1',
  startedAt: d('2026-08-29T14:02:00Z'), endedAt: d('2026-08-29T14:40:00Z'),
  durationSeconds: 2280, errorMessage: null, ...over
});

describe('dayWindowUtc (D9)', () => {
  it('UTC is the identity', () => {
    expect(dayWindowUtc('2026-08-29', 'UTC')).toEqual({ start: d('2026-08-29T00:00:00Z'), end: d('2026-08-30T00:00:00Z') });
  });
  it('uses the zone offset in force on that date', () => {
    expect(dayWindowUtc('2026-08-29', 'Europe/Berlin')).toEqual({ start: d('2026-08-28T22:00:00Z'), end: d('2026-08-29T22:00:00Z') });
  });
  it('spring-forward day is 23h long (America/New_York 2026-03-08)', () => {
    const w = dayWindowUtc('2026-03-08', 'America/New_York');
    expect(w.start).toEqual(d('2026-03-08T05:00:00Z'));
    expect(w.end).toEqual(d('2026-03-09T04:00:00Z'));
  });
  it('fall-back day is 25h long (America/New_York 2026-11-01)', () => {
    const w = dayWindowUtc('2026-11-01', 'America/New_York');
    expect(w.start).toEqual(d('2026-11-01T04:00:00Z'));
    expect(w.end).toEqual(d('2026-11-02T05:00:00Z'));
  });
  it('rolls over a month boundary when computing the next local midnight', () => {
    expect(dayWindowUtc('2026-08-31', 'UTC')).toEqual({ start: d('2026-08-31T00:00:00Z'), end: d('2026-09-01T00:00:00Z') });
  });
});

describe('classifySignal (F7/F8)', () => {
  it('recorded when duration_seconds is present', () => {
    expect(classifySignal(sig({}))).toEqual({ precision: 'recorded', durationSeconds: 2280 });
  });
  it('derived from ended_at - started_at when duration_seconds is NULL', () => {
    expect(classifySignal(sig({ durationSeconds: null }))).toEqual({ precision: 'derived', durationSeconds: 2280 });
  });
  it('unreliable for reaper-ended rows, no duration', () => {
    expect(classifySignal(sig({ durationSeconds: null, errorMessage: 'Session timed out: exceeded maximum session duration' })))
      .toEqual({ precision: 'unreliable', durationSeconds: null });
  });
  it('unreliable when derived length exceeds 8h', () => {
    expect(classifySignal(sig({ durationSeconds: null, endedAt: d('2026-08-30T00:00:00Z') })).precision).toBe('unreliable');
  });
  it('a recorded duration on a reaper row is still unreliable (the reaper never writes one, so this is defensive)', () => {
    expect(classifySignal(sig({ errorMessage: 'Session timed out: connection was never established' })).precision).toBe('unreliable');
  });
});

describe('mergeSignals', () => {
  it('merges consecutive same-device sessions within the gap', () => {
    const a = sig({ id: 'a' });
    const b = sig({ id: 'b', startedAt: d('2026-08-29T14:45:00Z'), endedAt: d('2026-08-29T15:00:00Z') });
    const c = sig({ id: 'c', startedAt: d('2026-08-29T16:00:00Z'), endedAt: d('2026-08-29T16:10:00Z') });
    expect(mergeSignals([c, b, a], 10).map((g) => g.map((s) => s.id))).toEqual([['a', 'b'], ['c']]);
  });
  it('never merges across devices', () => {
    const a = sig({ id: 'a' });
    const b = sig({ id: 'b', deviceId: 'dev-2', startedAt: d('2026-08-29T14:41:00Z'), endedAt: d('2026-08-29T15:00:00Z') });
    expect(mergeSignals([a, b], 10)).toHaveLength(2);
  });
  it('gap 0 merges only overlapping/adjacent sessions', () => {
    const a = sig({ id: 'a' });
    const b = sig({ id: 'b', startedAt: d('2026-08-29T14:40:00Z'), endedAt: d('2026-08-29T15:00:00Z') });
    const c = sig({ id: 'c', startedAt: d('2026-08-29T15:00:01Z'), endedAt: d('2026-08-29T15:10:00Z') });
    expect(mergeSignals([a, b, c], 0)).toHaveLength(2);
  });
  it('a short nested session does not walk the comparison point backwards (review W06A)', () => {
    // A concurrent terminal + desktop pair on one device is ordinary. A short
    // member appended after a long one must NOT become the group's end: the
    // group's running MAX ended_at is what the next row is measured against.
    // Otherwise C — which lies entirely inside A's window — opens a second
    // group and we emit two OVERLAPPING suggestions, i.e. double-billed minutes.
    const a = sig({ id: 'a', type: 'terminal', startedAt: d('2026-08-29T10:00:00Z'), endedAt: d('2026-08-29T12:00:00Z'), durationSeconds: 7200 });
    const b = sig({ id: 'b', startedAt: d('2026-08-29T10:05:00Z'), endedAt: d('2026-08-29T10:10:00Z'), durationSeconds: 300 });
    const c = sig({ id: 'c', startedAt: d('2026-08-29T10:30:00Z'), endedAt: d('2026-08-29T10:40:00Z'), durationSeconds: 600 });
    expect(mergeSignals([a, b, c], 10).map((g) => g.map((s) => s.id))).toEqual([['a', 'b', 'c']]);
  });
  it('the running max also carries a later row that is only reachable via an earlier long member', () => {
    // A 10:00–12:00, B 10:05–10:10, D 12:05–12:20. D is 5 min after A's end
    // (inside the 10-min gap) but nearly 2h after B's — the last appended row.
    const a = sig({ id: 'a', startedAt: d('2026-08-29T10:00:00Z'), endedAt: d('2026-08-29T12:00:00Z'), durationSeconds: 7200 });
    const b = sig({ id: 'b', startedAt: d('2026-08-29T10:05:00Z'), endedAt: d('2026-08-29T10:10:00Z'), durationSeconds: 300 });
    const dd = sig({ id: 'd', startedAt: d('2026-08-29T12:05:00Z'), endedAt: d('2026-08-29T12:20:00Z'), durationSeconds: 900 });
    expect(mergeSignals([dd, b, a], 10).map((g) => g.map((s) => s.id))).toEqual([['a', 'b', 'd']]);
  });
  it('still splits when the true group end is beyond the gap', () => {
    // Guard against over-merging: E starts 11 min after the group's max end.
    const a = sig({ id: 'a', startedAt: d('2026-08-29T10:00:00Z'), endedAt: d('2026-08-29T12:00:00Z'), durationSeconds: 7200 });
    const b = sig({ id: 'b', startedAt: d('2026-08-29T10:05:00Z'), endedAt: d('2026-08-29T10:10:00Z'), durationSeconds: 300 });
    const e = sig({ id: 'e', startedAt: d('2026-08-29T12:11:00Z'), endedAt: d('2026-08-29T12:20:00Z'), durationSeconds: 540 });
    expect(mergeSignals([a, b, e], 10).map((g) => g.map((s) => s.id))).toEqual([['a', 'b'], ['e']]);
  });
});

describe('suggestionKey / envelopeOf', () => {
  it('key is sorted ids joined by +', () => {
    expect(suggestionKey(['b', 'a'])).toBe('a+b');
  });
  it('envelope spans the group; endedAt/duration null when any member is unreliable', () => {
    const a = { ...sig({ id: 'a' }), precision: 'recorded' as const };
    const b = { ...sig({ id: 'b', startedAt: d('2026-08-29T14:45:00Z'), endedAt: d('2026-08-29T15:00:00Z') }), precision: 'derived' as const };
    expect(envelopeOf([a, b])).toEqual({ startedAt: a.startedAt, endedAt: b.endedAt, durationMinutes: 58 });
    expect(envelopeOf([a, { ...b, precision: 'unreliable' as const }])).toEqual({ startedAt: a.startedAt, endedAt: null, durationMinutes: null });
  });
});

describe('rankTicketCandidates (flow step 6, F14)', () => {
  const env = { startedAt: d('2026-08-29T14:02:00Z'), endedAt: d('2026-08-29T14:40:00Z') };
  const t = (over: Partial<TicketCandidateRow>): TicketCandidateRow => ({
    id: 't1', ticketNumber: 'TKT-1041', subject: 'Printer', status: 'closed', orgId: 'o1',
    assignedTo: null, closedBy: null, closedAt: null, actorStatusChangeAt: null, actorStatusChangeTo: null, ...over
  });
  it('preselects the one ticket the actor closed inside [start-2h, end+4h]', () => {
    const r = rankTicketCandidates([t({ closedBy: 'me', closedAt: d('2026-08-29T15:00:00Z') })], 'me', env);
    expect(r.candidate?.reason).toBe('closed_by_you');
    expect(r.otherTickets).toEqual([]);
  });
  it('a status_change comment by the actor to resolved counts as closed_by_you', () => {
    const r = rankTicketCandidates([t({ status: 'resolved', actorStatusChangeAt: d('2026-08-29T14:50:00Z'), actorStatusChangeTo: 'resolved' })], 'me', env);
    expect(r.candidate?.reason).toBe('closed_by_you');
  });
  it('a close outside the window does not qualify', () => {
    const r = rankTicketCandidates([t({ closedBy: 'me', closedAt: d('2026-08-29T20:00:00Z') })], 'me', env);
    expect(r.candidate).toBeNull();
    expect(r.otherTickets).toHaveLength(1);
  });
  it('two rank-a ties -> no preselection, both listed (ambiguity is never guessed)', () => {
    const r = rankTicketCandidates([
      t({ id: 'a', closedBy: 'me', closedAt: d('2026-08-29T15:00:00Z') }),
      t({ id: 'b', closedBy: 'me', closedAt: d('2026-08-29T15:10:00Z') })
    ], 'me', env);
    expect(r.candidate).toBeNull();
    expect(r.otherTickets.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });
  it('falls back to the single open ticket assigned to the actor', () => {
    const r = rankTicketCandidates([t({ status: 'open', assignedTo: 'me' })], 'me', env);
    expect(r.candidate?.reason).toBe('assigned_to_you');
  });
  it('someone else closing it is not a signal about me', () => {
    const r = rankTicketCandidates([t({ closedBy: 'other', closedAt: d('2026-08-29T15:00:00Z') })], 'me', env);
    expect(r.candidate).toBeNull();
  });
  it('caps otherTickets at 3', () => {
    const r = rankTicketCandidates(['a', 'b', 'c', 'd', 'e'].map((id) => t({ id, status: 'open' })), 'me', env);
    expect(r.otherTickets).toHaveLength(3);
  });
  it('unreliable envelope (endedAt null) uses start + 8h as the end for the window', () => {
    const r = rankTicketCandidates([t({ closedBy: 'me', closedAt: d('2026-08-29T23:00:00Z') })], 'me', { startedAt: env.startedAt, endedAt: null });
    expect(r.candidate?.reason).toBe('closed_by_you'); // 14:02 + 8h + 4h = 02:02 next day
  });
});

describe('validateConfirmRange (confirm step 3)', () => {
  const env = { startedAt: d('2026-08-29T14:02:00Z'), endedAt: d('2026-08-29T14:40:00Z') };
  it('accepts edits within +/-15 min of both ends', () => {
    expect(validateConfirmRange(env, { startedAt: d('2026-08-29T13:50:00Z'), endedAt: d('2026-08-29T14:50:00Z') })).toBeNull();
  });
  it('rejects a start more than 15 min early', () => {
    expect(validateConfirmRange(env, { startedAt: d('2026-08-29T13:40:00Z'), endedAt: env.endedAt })).toBe('RANGE_OUTSIDE_SIGNAL');
  });
  it('rejects an end more than 15 min late', () => {
    expect(validateConfirmRange(env, { startedAt: env.startedAt, endedAt: d('2026-08-29T15:00:00Z') })).toBe('RANGE_OUTSIDE_SIGNAL');
  });
  it('unreliable envelope: endedAt is mandatory and capped at start + 8h', () => {
    const un = { startedAt: env.startedAt, endedAt: null };
    expect(validateConfirmRange(un, { startedAt: env.startedAt })).toBe('ENDED_AT_REQUIRED');
    expect(validateConfirmRange(un, { startedAt: env.startedAt, endedAt: d('2026-08-29T16:00:00Z') })).toBeNull();
    expect(validateConfirmRange(un, { startedAt: env.startedAt, endedAt: d('2026-08-29T22:03:00Z') })).toBe('RANGE_OUTSIDE_SIGNAL');
  });
});

// ── F19: the technician may have logged this work already ────────────────────
// A 100-minute window: 10:00 -> 11:40.
const W = { startedAt: d('2026-08-29T10:00:00Z'), endedAt: d('2026-08-29T11:40:00Z') };
const range = (from: string, to: string) => ({ startedAt: d(from), endedAt: d(to) });

describe('mergeRanges (F19 - never double-count overlapping entries)', () => {
  it('unions overlapping and touching ranges, leaves disjoint ones alone', () => {
    expect(mergeRanges([
      range('2026-08-29T10:00:00Z', '2026-08-29T10:30:00Z'),
      range('2026-08-29T10:20:00Z', '2026-08-29T10:50:00Z'),   // overlaps the first
      range('2026-08-29T10:50:00Z', '2026-08-29T11:00:00Z'),   // touches the second
      range('2026-08-29T11:30:00Z', '2026-08-29T11:40:00Z'),   // disjoint
    ])).toEqual([
      range('2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z'),
      range('2026-08-29T11:30:00Z', '2026-08-29T11:40:00Z'),
    ]);
  });
  it('is order-independent', () => {
    const a = range('2026-08-29T11:00:00Z', '2026-08-29T11:10:00Z');
    const b = range('2026-08-29T10:00:00Z', '2026-08-29T10:10:00Z');
    expect(mergeRanges([a, b])).toEqual(mergeRanges([b, a]));
  });
  it('does not mutate its input', () => {
    const a = range('2026-08-29T10:00:00Z', '2026-08-29T10:30:00Z');
    const b = range('2026-08-29T10:20:00Z', '2026-08-29T10:50:00Z');
    mergeRanges([a, b]);
    expect(a.endedAt).toEqual(d('2026-08-29T10:30:00Z'));
  });
  it('two entries covering the SAME half hour count as half an hour, not an hour', () => {
    const dup = [range('2026-08-29T10:00:00Z', '2026-08-29T10:30:00Z'), range('2026-08-29T10:00:00Z', '2026-08-29T10:30:00Z')];
    expect(overlapMs(W, dup)).toBe(30 * 60_000);
  });
});

describe('overlapMs (F19)', () => {
  it('clips ranges to the window on both sides', () => {
    expect(overlapMs(W, [range('2026-08-29T09:00:00Z', '2026-08-29T10:20:00Z')])).toBe(20 * 60_000);
    expect(overlapMs(W, [range('2026-08-29T11:30:00Z', '2026-08-29T13:00:00Z')])).toBe(10 * 60_000);
  });
  it('is 0 for a window with no end (unreliable member) - never drop what we cannot measure (F7)', () => {
    expect(overlapMs({ startedAt: W.startedAt, endedAt: null }, [range('2026-08-29T10:00:00Z', '2026-08-29T11:40:00Z')])).toBe(0);
  });
  it('is 0 with no logged entries', () => {
    expect(overlapMs(W, [])).toBe(0);
  });
  it('ignores a range entirely outside the window', () => {
    expect(overlapMs(W, [range('2026-08-29T08:00:00Z', '2026-08-29T09:00:00Z')])).toBe(0);
  });
});

describe('alreadyLoggedVerdict - threshold table (F19)', () => {
  // 100-minute window; each case logs N minutes from 10:00.
  const cases: Array<[pct: number, minutes: number, drop: boolean]> = [
    [0, 0, false],
    [50, 50, false],
    [79, 79, false],
    [80, 80, true],     // exactly at the threshold DROPS (>= not >)
    [100, 100, true],
  ];
  it.each(cases)('%i%% overlap -> drop=%s', (_pct, minutes, drop) => {
    const ranges = minutes === 0 ? [] : [{ startedAt: W.startedAt, endedAt: new Date(W.startedAt.getTime() + minutes * 60_000) }];
    expect(alreadyLoggedVerdict(W, ranges)).toEqual({ overlapMinutes: minutes, drop });
  });
  it('the threshold is a named constant at 0.8, not a literal', () => {
    expect(ALREADY_LOGGED_DROP_RATIO).toBe(0.8);
  });
  it('rounds the reported minutes but thresholds on milliseconds', () => {
    // 79 min 40 s = 79.67% -> still below 0.8, reported as 80 min.
    const ranges = [{ startedAt: W.startedAt, endedAt: new Date(W.startedAt.getTime() + (79 * 60 + 40) * 1000) }];
    expect(alreadyLoggedVerdict(W, ranges)).toEqual({ overlapMinutes: 80, drop: false });
  });
  it('an unreliable window is never dropped, whatever is logged (F7)', () => {
    expect(alreadyLoggedVerdict({ startedAt: W.startedAt, endedAt: null }, [range('2026-08-29T00:00:00Z', '2026-08-29T23:59:00Z')]))
      .toEqual({ overlapMinutes: 0, drop: false });
  });
});
