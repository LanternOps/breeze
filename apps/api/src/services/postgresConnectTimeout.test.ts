import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONNECT_TIMEOUT_CODE,
  POSTGRES_CONNECT_TIMEOUT_SECONDS,
  diagnoseConnectTimeout,
  isPostgresConnectTimeout,
  safeDiagnoseConnectTimeout,
} from './postgresConnectTimeout';
import type { EventLoopLagReading } from './eventLoopMonitor';

/** The exact error shape postgres.js builds in `Errors.connection()`. */
function connectTimeoutError(): Error {
  return Object.assign(new Error('write CONNECT_TIMEOUT db.internal:5432'), {
    code: CONNECT_TIMEOUT_CODE,
    errno: CONNECT_TIMEOUT_CODE,
    address: 'db.internal',
    port: 5432,
  });
}

/** How Drizzle presents the same failure: own `.code` undefined, driver on `.cause`. */
function drizzleWrapped(cause: Error): Error {
  return Object.assign(new Error('Failed query: select 1'), { cause });
}

function reading(overrides: Partial<EventLoopLagReading> = {}): EventLoopLagReading {
  const worstLagMs = overrides.worstLagMs ?? 0;
  return {
    monitored: true,
    coversWindow: true,
    sampledMaxLagMs: worstLagMs,
    inFlightLagMs: 0,
    worstLagMs,
    sampleCount: 1,
    ...overrides,
  };
}

describe('isPostgresConnectTimeout', () => {
  afterEach(() => {
    delete process.env.EVENT_LOOP_STARVATION_WARN_MS;
  });

  it('matches the raw driver error', () => {
    expect(isPostgresConnectTimeout(connectTimeoutError())).toBe(true);
  });

  it('matches through the Drizzle .cause chain', () => {
    // The whole reason pgErrorCode walks `.cause`: a top-level `.code` check
    // misses every timeout raised inside a Drizzle query.
    expect(isPostgresConnectTimeout(drizzleWrapped(connectTimeoutError()))).toBe(true);
  });

  it('does not match other postgres connection errors', () => {
    for (const code of ['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'ECONNRESET', '23505']) {
      expect(isPostgresConnectTimeout(Object.assign(new Error(code), { code }))).toBe(false);
    }
  });

  it('does not match non-errors or undefined', () => {
    expect(isPostgresConnectTimeout(undefined)).toBe(false);
    expect(isPostgresConnectTimeout(null)).toBe(false);
    expect(isPostgresConnectTimeout('CONNECT_TIMEOUT')).toBe(false);
    expect(isPostgresConnectTimeout(new Error('plain'))).toBe(false);
  });
});

describe('diagnoseConnectTimeout', () => {
  afterEach(() => {
    delete process.env.EVENT_LOOP_STARVATION_WARN_MS;
  });

  it('returns null for anything that is not a connect timeout', () => {
    expect(diagnoseConnectTimeout(new Error('boom'), reading())).toBeNull();
    expect(diagnoseConnectTimeout(undefined, reading())).toBeNull();
  });

  it('blames the event loop when lag reaches the threshold', () => {
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
    const d = diagnoseConnectTimeout(connectTimeoutError(), reading({ worstLagMs: 11_500 }))!;

    expect(d.cause).toBe('event-loop-starvation');
    expect(d.worstLagMs).toBe(11_500);
    expect(d.lagBucket).toBe('over-10s');
    expect(d.windowMs).toBe(POSTGRES_CONNECT_TIMEOUT_SECONDS * 1_000);
    // The message must state the measurement and steer AWAY from the DB, since
    // sending the investigation at the database is the failure mode #3022 is about.
    expect(d.message).toContain('11500ms');
    expect(d.message).toMatch(/NOT a database or network fault/);
  });

  it('blames connectivity when the loop was healthy', () => {
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
    const d = diagnoseConnectTimeout(connectTimeoutError(), reading({ worstLagMs: 12 }))!;

    expect(d.cause).toBe('connectivity');
    expect(d.lagBucket).toBe('under-1s');
    expect(d.message).toMatch(/handshake itself failed/);
  });

  it('treats the threshold as inclusive', () => {
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
    expect(diagnoseConnectTimeout(connectTimeoutError(), reading({ worstLagMs: 1_000 }))!.cause)
      .toBe('event-loop-starvation');
    expect(diagnoseConnectTimeout(connectTimeoutError(), reading({ worstLagMs: 999 }))!.cause)
      .toBe('connectivity');
  });

  it('reports "unknown" — never "connectivity" — when no monitor is running', () => {
    // This is the important negative case. Falling back to "connectivity"
    // without evidence would silently reproduce the misdiagnosis this module
    // exists to prevent, and would do it with the authority of a verdict.
    const d = diagnoseConnectTimeout(
      connectTimeoutError(),
      reading({ monitored: false, worstLagMs: 0 }),
    )!;

    expect(d.cause).toBe('unknown');
    expect(d.lagBucket).toBe('unknown');
    expect(d.message).toMatch(/neither ruled in nor out/);
    expect(d.message).not.toMatch(/handshake itself failed/);
  });

  it('honours a tuned starvation threshold below the connect window', () => {
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '5000';
    const d = diagnoseConnectTimeout(connectTimeoutError(), reading({ worstLagMs: 2_000 }))!;
    expect(d.cause).toBe('connectivity');
    expect(d.starvationThresholdMs).toBe(5_000);
  });

  it('caps the threshold at the connect window so a full-window stall can never read as connectivity', () => {
    // EVENT_LOOP_STARVATION_WARN_MS is a warning-volume knob. An operator
    // quieting a noisy instance must not be able to make a 12s stall — which
    // alone consumed the whole 10s budget — report "the event loop stayed
    // healthy, check database reachability".
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '15000';
    const d = diagnoseConnectTimeout(connectTimeoutError(), reading({ worstLagMs: 12_000 }))!;
    expect(d.cause).toBe('event-loop-starvation');
    expect(d.starvationThresholdMs).toBe(10_000);
  });

  it('reports "unknown" when a running monitor cannot vouch for the whole window', () => {
    // monitored: true but coversWindow: false — the monitor booted less than
    // 10s ago, or samples more coarsely than the window is wide. Its zero means
    // "not observed", and must never be read as "the loop was fine".
    const d = diagnoseConnectTimeout(
      connectTimeoutError(),
      reading({ monitored: true, coversWindow: false, worstLagMs: 0 }),
    )!;
    expect(d.cause).toBe('unknown');
    expect(d.lagBucket).toBe('unknown');
    expect(d.message).not.toMatch(/handshake itself failed/);
  });

  it('diagnoses a Drizzle-wrapped timeout identically', () => {
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
    const d = diagnoseConnectTimeout(
      drizzleWrapped(connectTimeoutError()),
      reading({ worstLagMs: 6_000 }),
    )!;
    expect(d.cause).toBe('event-loop-starvation');
    expect(d.lagBucket).toBe('5s-10s');
  });

  it('rounds sub-millisecond lag rather than leaking a float into the tag/message', () => {
    process.env.EVENT_LOOP_STARVATION_WARN_MS = '1000';
    const d = diagnoseConnectTimeout(
      connectTimeoutError(),
      reading({ worstLagMs: 1_234.5678 }),
    )!;
    expect(d.worstLagMs).toBe(1_235);
    expect(d.message).toContain('1235ms');
  });

  it('falls back to the live monitor when no reading is injected', () => {
    // No monitor is started in this suite, so the singleton reports unmonitored
    // — which must surface as 'unknown', proving the production call path
    // (diagnoseConnectTimeout(err) with one argument) is wired to the monitor.
    const d = diagnoseConnectTimeout(connectTimeoutError())!;
    expect(d.cause).toBe('unknown');
  });

  it('keeps connect_timeout at 10s — raising it alone is explicitly not the fix', () => {
    // Guards the #3022 conclusion against a well-meaning "just bump the
    // timeout" edit: a longer budget only makes the failing request hold its
    // slot for longer while the loop is still starved.
    expect(POSTGRES_CONNECT_TIMEOUT_SECONDS).toBe(10);
  });
});

describe('connect_timeout drift guard', () => {
  it('matches the literal actually passed to the postgres.js pool', () => {
    // db/index.ts deliberately does NOT import POSTGRES_CONNECT_TIMEOUT_SECONDS
    // — that edge would drag this module and the event-loop monitor into the DB
    // module's import graph (see the comment at the pool config). The cost of
    // that decision is a duplicated literal, so pin the two together here:
    // if they drift, the classifier inspects a window that is not the budget
    // that expired, and every verdict it produces is measured over the wrong
    // interval.
    const source = readFileSync(
      fileURLToPath(new URL('../db/index.ts', import.meta.url)),
      'utf8',
    );
    const match = source.match(/connect_timeout:\s*(\d+)\s*,/);
    expect(match, 'connect_timeout not found in db/index.ts pool config').not.toBeNull();
    expect(Number(match![1])).toBe(POSTGRES_CONNECT_TIMEOUT_SECONDS);
  });
});

describe('safeDiagnoseConnectTimeout', () => {
  it('returns null instead of throwing when the error resists inspection', () => {
    // Both production call sites run while an error is already in flight; in
    // Hono's onError a throw would cost the request its JSON 500 AND stop the
    // original error from ever reaching Sentry.
    const hostile = {
      get code(): string { throw new Error('exploding getter'); },
    };
    expect(() => safeDiagnoseConnectTimeout(hostile)).not.toThrow();
    expect(safeDiagnoseConnectTimeout(hostile)).toBeNull();
  });

  it('agrees with diagnoseConnectTimeout on well-behaved errors', () => {
    const err = connectTimeoutError();
    expect(safeDiagnoseConnectTimeout(err)?.cause).toBe(diagnoseConnectTimeout(err)?.cause);
    expect(safeDiagnoseConnectTimeout(new Error('unrelated'))).toBeNull();
  });
});
