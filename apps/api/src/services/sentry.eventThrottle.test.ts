import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
vi.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
  setTag: vi.fn(),
}));

import { createEventThrottle, eventThrottleSignature } from './sentry';

function errorEvent(fn: string, lineno: number, extra: Record<string, unknown> = {}) {
  return {
    level: 'error',
    exception: { values: [{ type: 'Error', value: '[redacted]', stacktrace: { frames: [
      { function: 'processTicksAndRejections', lineno: 104 },
      { function: fn, lineno, colno: 85 },
    ] } }] },
    ...extra,
  };
}

describe('eventThrottleSignature', () => {
  it('separates call sites whose scrubbed messages are identical', () => {
    // BREEZE-4B/4C: every exception value is '[redacted]', so the message cannot
    // be the key — the throw site has to be.
    expect(eventThrottleSignature(errorEvent('planCanonicalCluster', 396661)))
      .not.toBe(eventThrottleSignature(errorEvent('planCanonicalMerge', 396620)));
  });

  it('keys message events on their event_code', () => {
    const a = eventThrottleSignature({ level: 'warning', tags: { event_code: 'db_context_held_too_long' } });
    const b = eventThrottleSignature({ level: 'warning', tags: { event_code: 'pool_saturated' } });
    expect(a).not.toBe(b);
  });

  it('prefers an explicit fingerprint', () => {
    const a = eventThrottleSignature(errorEvent('x', 1, { fingerprint: ['topology', 'reconcile'] }));
    const b = eventThrottleSignature(errorEvent('y', 2, { fingerprint: ['topology', 'reconcile'] }));
    expect(a).toBe(b);
  });
});

describe('createEventThrottle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('lets a burst through, then bounds a permanent failure retried every 2 s', () => {
    const throttle = createEventThrottle({ burst: 10, refillMs: 5 * 60_000 });
    let sent = 0;
    // One hour of a site that fails on every 2 s tick (BREEZE-4B shape).
    for (let i = 0; i < 1800; i += 1) {
      if (throttle(errorEvent('planCanonicalCluster', 396661))) sent += 1;
      vi.advanceTimersByTime(2000);
    }
    // 10 burst + one refill at each of 5, 10, … 55 min (the last tick is 59:58).
    expect(sent).toBe(10 + 11);
  });

  it('throttles each signature independently', () => {
    const throttle = createEventThrottle({ burst: 1, refillMs: 60_000 });
    expect(throttle(errorEvent('a', 1))).not.toBeNull();
    expect(throttle(errorEvent('a', 1))).toBeNull();
    expect(throttle(errorEvent('b', 2))).not.toBeNull();
  });

  it('bounds its memory by evicting the oldest signatures', () => {
    const throttle = createEventThrottle({ burst: 1, refillMs: 60_000, maxKeys: 2 });
    throttle(errorEvent('a', 1));
    throttle(errorEvent('b', 2));
    throttle(errorEvent('c', 3));
    // 'a' was evicted, so it starts with a fresh bucket.
    expect(throttle(errorEvent('a', 1))).not.toBeNull();
  });
});

describe('initSentry wiring', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; vi.resetModules(); initMock.mockClear(); });

  it('throttles in beforeSend, after scrubbing', async () => {
    vi.resetModules();
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry } = await import('./sentry');
    initSentry();
    const { beforeSend } = initMock.mock.calls[0]![0] as { beforeSend: (e: unknown) => unknown };
    const results = Array.from({ length: 50 }, () => beforeSend(errorEvent('loop', 7, { message: 'secret' })));
    const sent = results.filter(Boolean) as Array<Record<string, unknown>>;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(50);
    expect(sent[0]!.message).toBeUndefined();
  });
});

describe('OAuth errorId tag', () => {
  it('survives scrubbing so OAuth warnings group by errorId (BREEZE-4D)', async () => {
    const { scrubEvent } = await import('./sentry');
    const event = scrubEvent({ tags: { errorId: 'OAUTH_PROVIDER_GRANT_ERROR' } });
    expect(event.tags).toEqual({ errorId: 'OAUTH_PROVIDER_GRANT_ERROR' });
  });
});
