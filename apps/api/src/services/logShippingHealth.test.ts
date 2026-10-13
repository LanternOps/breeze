import { describe, expect, it } from 'vitest';
import {
  LOG_SHIPPING_QUEUE_FAILING_DEPTH,
  LOG_SHIPPING_SUSTAINED_MS,
  classifyLogShippingBeat,
  deriveLogShipping,
  parseLogShipping,
  planLogShippingWrite,
  type LogShippingReport,
} from './logShippingHealth';

const NOW = new Date('2026-10-12T12:00:00.000Z');

const report = (over: Partial<LogShippingReport> = {}): LogShippingReport => ({
  schemaVersion: 1,
  queueDepth: 0,
  droppedLogs: 0,
  ...over,
});

const okParsed = (over: Partial<LogShippingReport> = {}) => ({ kind: 'ok' as const, report: report(over) });

const dev = (over: Partial<{
  logShippingState: string | null;
  logShippingFailureStartedAt: Date | null;
  logShippingLastError: string | null;
  status: string;
}> = {}) => ({
  logShippingState: null,
  logShippingFailureStartedAt: null,
  logShippingLastError: null,
  status: 'online',
  ...over,
});

describe('parseLogShipping', () => {
  it('undefined -> absent', () => {
    expect(parseLogShipping(undefined)).toEqual({ kind: 'absent' });
  });

  it('parses a valid object and strips unknown keys', () => {
    const p = parseLogShipping({
      schemaVersion: 1,
      lastAttemptAt: '2026-10-12T10:00:00Z',
      lastSuccessAt: '2026-10-12T09:59:00Z',
      lastAttemptOk: false,
      lastError: 'http 503',
      queueDepth: 412,
      droppedLogs: 0,
      surprise: 'x',
    });
    expect(p.kind).toBe('ok');
    if (p.kind === 'ok') {
      expect(p.report.lastError).toBe('http 503');
      expect(p.report.queueDepth).toBe(412);
      expect('surprise' in p.report).toBe(false);
    }
  });

  it('accepts non-UTC offsets on the display-only timestamps', () => {
    const p = parseLogShipping({
      schemaVersion: 1, queueDepth: 0, droppedLogs: 0, lastAttemptOk: true,
      lastAttemptAt: '2026-10-12T10:00:00+02:00', lastSuccessAt: '2026-10-12T10:00:00-05:00',
    });
    expect(p.kind).toBe('ok');
  });

  it.each([
    ['schemaVersion 2', { schemaVersion: 2, queueDepth: 0, droppedLogs: 0 }],
    ['queueDepth string', { schemaVersion: 1, queueDepth: 'x', droppedLogs: 0 }],
    ['negative queueDepth', { schemaVersion: 1, queueDepth: -1, droppedLogs: 0 }],
    ['negative droppedLogs', { schemaVersion: 1, queueDepth: 0, droppedLogs: -5 }],
    ['5KB lastError', { schemaVersion: 1, queueDepth: 0, droppedLogs: 0, lastError: 'x'.repeat(5000) }],
    ['non-bool lastAttemptOk', { schemaVersion: 1, queueDepth: 0, droppedLogs: 0, lastAttemptOk: 'no' }],
    ['bad timestamp', { schemaVersion: 1, queueDepth: 0, droppedLogs: 0, lastAttemptAt: 'yesterday' }],
    ['string', 'garbage'],
    ['null', null],
    ['array', []],
  ])('%s -> invalid (never coerced to a healthy zero)', (_n, raw) => {
    expect(parseLogShipping(raw)).toEqual({ kind: 'invalid' });
  });
});

describe('classifyLogShippingBeat', () => {
  it('no completed attempt + empty queue -> quiet', () => {
    expect(classifyLogShippingBeat(report())).toBe('quiet');
  });
  it('lastAttemptOk true -> ok', () => {
    expect(classifyLogShippingBeat(report({ lastAttemptOk: true }))).toBe('ok');
  });
  it('lastAttemptOk false -> failing, regardless of timestamps', () => {
    expect(classifyLogShippingBeat(report({ lastAttemptOk: false }))).toBe('failing');
    expect(
      classifyLogShippingBeat(report({
        lastAttemptOk: false,
        lastAttemptAt: '2026-10-12T10:00:00Z',
        lastSuccessAt: '2026-10-12T10:00:00Z',
      })),
    ).toBe('failing');
    expect(
      classifyLogShippingBeat(report({
        lastAttemptOk: false,
        lastAttemptAt: '2026-10-12T10:00:00Z',
        lastSuccessAt: '2026-10-12T10:00:05Z',
      })),
    ).toBe('failing');
  });
  it('droppedLogs > 0 -> failing even when last attempt ok', () => {
    expect(classifyLogShippingBeat(report({ lastAttemptOk: true, droppedLogs: 3 }))).toBe('failing');
  });
  it('queue depth threshold: 400 failing, 399 ok', () => {
    expect(LOG_SHIPPING_QUEUE_FAILING_DEPTH).toBe(400);
    expect(classifyLogShippingBeat(report({ lastAttemptOk: true, queueDepth: 400 }))).toBe('failing');
    expect(classifyLogShippingBeat(report({ lastAttemptOk: true, queueDepth: 399 }))).toBe('ok');
  });
});

describe('planLogShippingWrite', () => {
  it('first report on a NULL device sets state only', () => {
    expect(planLogShippingWrite(dev(), okParsed({ lastAttemptOk: true }), NOW)).toEqual({
      logShippingState: 'ok',
    });
  });
  it('first quiet report on NULL device sets state only', () => {
    expect(planLogShippingWrite(dev(), okParsed(), NOW)).toEqual({ logShippingState: 'quiet' });
  });
  it('ok -> ok is a no-op', () => {
    expect(
      planLogShippingWrite(dev({ logShippingState: 'ok' }), okParsed({ lastAttemptOk: true }), NOW),
    ).toEqual({});
  });
  it('ok -> failing sets state, failureStartedAt = now, lastError', () => {
    expect(
      planLogShippingWrite(
        dev({ logShippingState: 'ok' }),
        okParsed({ lastAttemptOk: false, lastError: 'http 503' }),
        NOW,
      ),
    ).toEqual({
      logShippingState: 'failing',
      logShippingFailureStartedAt: NOW,
      logShippingLastError: 'http 503',
    });
  });
  it('quiet -> failing without lastError stores null error', () => {
    expect(
      planLogShippingWrite(dev({ logShippingState: 'quiet' }), okParsed({ droppedLogs: 2 }), NOW),
    ).toEqual({
      logShippingState: 'failing',
      logShippingFailureStartedAt: NOW,
      logShippingLastError: null,
    });
  });
  it('failing -> failing, same error -> no-op (episode start untouched)', () => {
    const started = new Date('2026-10-12T11:00:00Z');
    expect(
      planLogShippingWrite(
        dev({ logShippingState: 'failing', logShippingFailureStartedAt: started, logShippingLastError: 'http 503' }),
        okParsed({ lastAttemptOk: false, lastError: 'http 503' }),
        NOW,
      ),
    ).toEqual({});
  });
  it('failing -> failing, new error -> only lastError', () => {
    const started = new Date('2026-10-12T11:00:00Z');
    expect(
      planLogShippingWrite(
        dev({ logShippingState: 'failing', logShippingFailureStartedAt: started, logShippingLastError: 'http 503' }),
        okParsed({ lastAttemptOk: false, lastError: 'timeout' }),
        NOW,
      ),
    ).toEqual({ logShippingLastError: 'timeout' });
  });
  it('failing -> ok clears started_at and error', () => {
    const started = new Date('2026-10-12T11:00:00Z');
    expect(
      planLogShippingWrite(
        dev({ logShippingState: 'failing', logShippingFailureStartedAt: started, logShippingLastError: 'http 503' }),
        okParsed({ lastAttemptOk: true }),
        NOW,
      ),
    ).toEqual({
      logShippingState: 'ok',
      logShippingFailureStartedAt: null,
      logShippingLastError: null,
    });
  });
  it('absent on a reporting device resets all three to null', () => {
    expect(
      planLogShippingWrite(
        dev({ logShippingState: 'failing', logShippingFailureStartedAt: new Date(), logShippingLastError: 'x' }),
        { kind: 'absent' },
        NOW,
      ),
    ).toEqual({ logShippingState: null, logShippingFailureStartedAt: null, logShippingLastError: null });
    expect(
      planLogShippingWrite(dev({ logShippingState: 'ok' }), { kind: 'absent' }, NOW),
    ).toEqual({ logShippingState: null, logShippingFailureStartedAt: null, logShippingLastError: null });
  });
  it('absent on a NULL device is a no-op', () => {
    expect(planLogShippingWrite(dev(), { kind: 'absent' }, NOW)).toEqual({});
  });
  it('invalid on a failing device changes nothing', () => {
    expect(
      planLogShippingWrite(
        dev({ logShippingState: 'failing', logShippingFailureStartedAt: new Date(), logShippingLastError: 'x' }),
        { kind: 'invalid' },
        NOW,
      ),
    ).toEqual({});
    expect(planLogShippingWrite(dev(), { kind: 'invalid' }, NOW)).toEqual({});
  });
  it('success->failure inside one second still classifies failing', () => {
    expect(
      planLogShippingWrite(
        dev({ logShippingState: 'ok' }),
        okParsed({
          lastAttemptOk: false,
          lastAttemptAt: '2026-10-12T10:00:00Z',
          lastSuccessAt: '2026-10-12T10:00:00Z',
        }),
        NOW,
      ),
    ).toMatchObject({ logShippingState: 'failing' });
  });
  it('truncates lastError to 200 chars (defence in depth)', () => {
    const plan = planLogShippingWrite(
      dev({ logShippingState: 'ok' }),
      okParsed({ lastAttemptOk: false, lastError: 'e'.repeat(500) }),
      NOW,
    );
    expect(plan.logShippingLastError).toHaveLength(200);
  });
  it('does not re-write a long error every beat (compares truncated value)', () => {
    const started = new Date('2026-10-12T11:00:00Z');
    expect(
      planLogShippingWrite(
        dev({ logShippingState: 'failing', logShippingFailureStartedAt: started, logShippingLastError: 'e'.repeat(200) }),
        okParsed({ lastAttemptOk: false, lastError: 'e'.repeat(500) }),
        NOW,
      ),
    ).toEqual({});
  });
});

describe('deriveLogShipping', () => {
  const failingRow = (ageMs: number, status = 'online') => ({
    status,
    logShippingState: 'failing',
    logShippingFailureStartedAt: new Date(NOW.getTime() - ageMs),
    logShippingLastError: 'http 503',
  });

  it('NULL -> unknown', () => {
    expect(deriveLogShipping(dev(), NOW)).toEqual({ state: 'unknown', failingSince: null, lastError: null });
  });
  it('ok -> healthy, quiet -> quiet (lastError never exposed)', () => {
    expect(deriveLogShipping(dev({ logShippingState: 'ok', logShippingLastError: 'x' }), NOW)).toEqual({
      state: 'healthy', failingSince: null, lastError: null,
    });
    expect(deriveLogShipping(dev({ logShippingState: 'quiet' }), NOW)).toEqual({
      state: 'quiet', failingSince: null, lastError: null,
    });
  });
  it('failing + offline -> unknown', () => {
    expect(deriveLogShipping(failingRow(LOG_SHIPPING_SUSTAINED_MS * 2, 'offline'), NOW)).toEqual({
      state: 'unknown', failingSince: null, lastError: null,
    });
  });
  it('failing + online, 29m59s -> healthy', () => {
    expect(deriveLogShipping(failingRow(LOG_SHIPPING_SUSTAINED_MS - 1000), NOW).state).toBe('healthy');
  });
  it('failing + online, exactly 30m -> failing with failingSince + lastError', () => {
    const d = deriveLogShipping(failingRow(LOG_SHIPPING_SUSTAINED_MS), NOW);
    expect(d).toEqual({
      state: 'failing',
      failingSince: new Date(NOW.getTime() - LOG_SHIPPING_SUSTAINED_MS).toISOString(),
      lastError: 'http 503',
    });
  });
  it('failing without a started_at is not reported as failing', () => {
    expect(
      deriveLogShipping({ ...failingRow(0), logShippingFailureStartedAt: null }, NOW).state,
    ).toBe('healthy');
  });
});
