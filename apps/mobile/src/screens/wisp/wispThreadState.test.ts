import { describe, expect, it } from 'vitest';

import type { WispConcern, WispConcernSeverity } from '../../services/wisp';
import {
  INITIAL_WISP_SESSION,
  approvalOpenTarget,
  approvalRequestIdForIntent,
  concernSections,
  initialExpandedConcern,
  wispSessionReducer,
  type WispSessionEvent,
  type WispSessionState,
} from './wispThreadState';

const now = new Date('2026-10-19T12:00:00Z');
const c = (id: string, sev: WispConcernSeverity, extra: Partial<WispConcern> = {}): WispConcern =>
  ({
    id,
    orgId: 'o',
    subject: { kind: 'ticket', id },
    summary: id,
    severity: sev,
    status: 'open',
    snoozedUntil: null,
    approvalIntentId: null,
    updatedAt: '2026-10-19T10:00:00Z',
    recipient: null,
    ...extra,
  }) as WispConcern;

describe('concernSections', () => {
  it('groups and orders sections', () => {
    const s = concernSections(
      [c('a', 'low'), c('b', 'high', { approvalIntentId: 'i1' }), c('x', 'medium', { status: 'resolved' })],
      now,
    );
    expect(s.map((x) => x.key)).toEqual(['needs_you', 'open', 'done']);
    expect(s.map((x) => x.title)).toEqual(['Needs you', 'Open', 'Done']);
    expect(s[1].concerns.map((x) => x.id)).toEqual(['a']);
  });
  it('sorts by severity then updatedAt desc, unparseable last', () => {
    const s = concernSections(
      [
        c('l', 'low'),
        c('h-old', 'high', { updatedAt: '2026-10-18T10:00:00Z' }),
        c('h-new', 'high', { updatedAt: '2026-10-19T11:00:00Z' }),
        c('h-bad', 'high', { updatedAt: 'nope' }),
        c('m', 'medium'),
        c('i', 'info'),
      ],
      now,
    );
    expect(s[0].concerns.map((x) => x.id)).toEqual(['h-new', 'h-old', 'h-bad', 'm', 'l', 'i']);
  });
  it('treats expired/invalid snoozes as open, future as snoozed', () => {
    const s = concernSections(
      [
        c('past', 'low', { status: 'snoozed', snoozedUntil: '2026-10-19T11:00:00Z' }),
        c('nul', 'low', { status: 'snoozed', snoozedUntil: null }),
        c('bad', 'low', { status: 'snoozed', snoozedUntil: 'zzz' }),
        c('fut', 'low', { status: 'snoozed', snoozedUntil: '2026-10-20T11:00:00Z' }),
        c('dis', 'low', { status: 'dismissed' }),
      ],
      now,
    );
    expect(s.map((x) => x.key)).toEqual(['open', 'snoozed', 'done']);
    expect(s[0].concerns.map((x) => x.id).sort()).toEqual(['bad', 'nul', 'past']);
    expect(s[1].concerns.map((x) => x.id)).toEqual(['fut']);
  });
  it('expired snoozed with approval goes to needs_you; empty input gives []', () => {
    const s = concernSections(
      [c('p', 'low', { status: 'snoozed', snoozedUntil: '2026-10-01T00:00:00Z', approvalIntentId: 'i' })],
      now,
    );
    expect(s.map((x) => x.key)).toEqual(['needs_you']);
    expect(concernSections([], now)).toEqual([]);
  });
  it('does not mutate input', () => {
    const input = [c('a', 'low'), c('b', 'high')];
    const copy = structuredClone(input);
    concernSections(input, now);
    expect(input).toEqual(copy);
  });
});

describe('approvalOpenTarget', () => {
  it('only for open with an intent', () => {
    expect(approvalOpenTarget({ status: 'open', approvalIntentId: 'i1' })).toBe('i1');
    expect(approvalOpenTarget({ status: 'resolved', approvalIntentId: 'i1' })).toBeNull();
    expect(approvalOpenTarget({ status: 'dismissed', approvalIntentId: 'i1' })).toBeNull();
    expect(approvalOpenTarget({ status: 'open', approvalIntentId: null })).toBeNull();
    expect(approvalOpenTarget({ status: 'open', approvalIntentId: '' })).toBeNull();
    expect(approvalOpenTarget({ status: 'snoozed', approvalIntentId: 'i1' })).toBeNull();
  });
});

describe('initialExpandedConcern', () => {
  const list = [c('a', 'low')];
  const p = (concernId?: string | null) => ({ threadId: 't', grantId: 'g', concernId });
  it('resolves only present ids', () => {
    expect(initialExpandedConcern(p('zzz'), list)).toBeNull();
    expect(initialExpandedConcern(p('a'), list)).toBe('a');
    expect(initialExpandedConcern(p(undefined), list)).toBeNull();
    expect(initialExpandedConcern(p(null), list)).toBeNull();
    expect(initialExpandedConcern(p(''), list)).toBeNull();
  });
});

describe('wispSessionReducer', () => {
  const run = (events: WispSessionEvent[], s: WispSessionState = INITIAL_WISP_SESSION) =>
    events.reduce(wispSessionReducer, s);
  const streamed = (): WispSessionState =>
    run([
      { type: 'creating' },
      { type: 'created', sessionId: 's1' },
      { type: 'userSent', id: 'u1', content: 'hi', sentAt: 't0' },
      { type: 'delta', id: 'a1', delta: 'Hel', sentAt: 't1' },
      { type: 'delta', id: 'a1', delta: 'lo', sentAt: 't1' },
    ]);

  it('creating/created', () => {
    const s = run([{ type: 'creating' }]);
    expect(s.status).toBe('creating');
    expect(wispSessionReducer(s, { type: 'created', sessionId: 's1' })).toMatchObject({
      sessionId: 's1',
      status: 'idle',
    });
    const s3 = wispSessionReducer({ ...INITIAL_WISP_SESSION, status: 'streaming' }, { type: 'created', sessionId: 's' });
    expect(s3.status).toBe('streaming');
  });
  it('streams deltas into one assistant row', () => {
    const s = streamed();
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(s.messages[1]).toMatchObject({ role: 'assistant', content: 'Hello', isStreaming: true });
    expect(s.status).toBe('streaming');
  });
  it('done', () => {
    const s = wispSessionReducer(streamed(), { type: 'done' });
    expect(s.status).toBe('idle');
    expect(s.messages[1]).toMatchObject({ isStreaming: false });
  });
  it('failed', () => {
    const s = wispSessionReducer(streamed(), { type: 'failed', error: 'boom' });
    expect(s).toMatchObject({ status: 'error', error: 'boom' });
    expect(s.messages[1]).toMatchObject({ failed: true, isStreaming: false });
    expect(s.messages[0]).not.toHaveProperty('failed');
  });
  it('reset', () => {
    expect(wispSessionReducer(streamed(), { type: 'reset' })).toEqual(INITIAL_WISP_SESSION);
  });
  it('merges tool events keeping placeholder name and input', () => {
    const s = run([
      {
        type: 'toolEvent',
        id: 'a1',
        sentAt: 't',
        event: { toolUseId: 'x', toolName: 'wisp_foo', state: 'started', input: { k: 1 } },
      },
      {
        type: 'toolEvent',
        id: 'a1',
        sentAt: 't',
        event: { toolUseId: 'x', toolName: 'tool', state: 'completed', output: 'ok' },
      },
      { type: 'toolEvent', id: 'a1', sentAt: 't', event: { toolUseId: 'y', toolName: 'other', state: 'started' } },
    ]);
    const m = s.messages[0];
    if (m.role !== 'assistant') throw new Error('expected assistant');
    expect(m.toolEvents).toHaveLength(2);
    expect(m.toolEvents[0]).toEqual({
      toolUseId: 'x',
      toolName: 'wisp_foo',
      state: 'completed',
      output: 'ok',
      input: { k: 1 },
    });
    expect(m.content).toBe('');
    expect(m.isStreaming).toBe(true);
  });
  it('never mutates its input', () => {
    const base = streamed();
    const snapshot = structuredClone(base);
    const deepFreeze = (o: unknown): void => {
      if (o && typeof o === 'object') {
        Object.values(o as object).forEach(deepFreeze);
        Object.freeze(o);
      }
    };
    deepFreeze(base);
    const events: WispSessionEvent[] = [
      { type: 'delta', id: 'a1', delta: '!', sentAt: 't' },
      { type: 'toolEvent', id: 'a1', sentAt: 't', event: { toolUseId: 'x', toolName: 'n', state: 'started' } },
      { type: 'userSent', id: 'u2', content: 'x', sentAt: 't' },
      { type: 'done' },
      { type: 'failed', error: 'e' },
      { type: 'reset' },
    ];
    for (const e of events) wispSessionReducer(base, e);
    expect(base).toEqual(snapshot);
  });
});

describe('approvalRequestIdForIntent (Review Focus 4)', () => {
  // A concern names its approval card by ACTION INTENT id; the mobile takeover
  // is keyed by APPROVAL REQUEST id (one row per approver). Focusing the intent
  // id directly would 404 and never open the card.
  const row = (id: string, intentId: string | null | undefined, status = 'pending') => ({ id, intentId, status });

  it("maps the intent to this user's pending approval row", () => {
    expect(approvalRequestIdForIntent([row('a1', 'i0'), row('a2', 'i1')], 'i1')).toBe('a2');
  });

  it('is null when the matching row was decided elsewhere', () => {
    expect(approvalRequestIdForIntent([row('a2', 'i1', 'approved')], 'i1')).toBeNull();
  });

  it('is null when no row carries the intent (older server, or not this user)', () => {
    expect(approvalRequestIdForIntent([row('a1', undefined), row('a3', null)], 'i1')).toBeNull();
    expect(approvalRequestIdForIntent([], 'i1')).toBeNull();
  });

  it('never matches an empty intent id', () => {
    expect(approvalRequestIdForIntent([row('a1', '')], '')).toBeNull();
  });
});
