import { describe, it, expect, beforeEach, vi } from 'vitest';

// Importing ./index pulls the DB module; stub the Sentry surface it uses so the
// unit test never loads the real SDK (mirrors dbWriteExpectingRows.test.ts).
vi.mock('../services/sentry', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import {
  shouldCaptureHeldContext,
  shouldReportHeldContextSite,
  __resetHeldContextCaptureThrottleForTests,
  __resetHeldContextAssertDedupeForTests,
} from './index';

// Guards the #1105 quota fix: the held-context warning must NOT emit one Sentry
// event per occurrence (8.6k events in a week exhausted the org budget and
// blinded all error reporting). It captures at most once per scope per window.
describe('shouldCaptureHeldContext (held-context Sentry-capture throttle)', () => {
  const W = 300_000; // 5-minute window

  beforeEach(() => {
    __resetHeldContextCaptureThrottleForTests();
  });

  it('throttleMs=0 disables throttling — always captures', () => {
    expect(shouldCaptureHeldContext('system', 1000, 0)).toBe(true);
    expect(shouldCaptureHeldContext('system', 1001, 0)).toBe(true);
    expect(shouldCaptureHeldContext('system', 1002, 0)).toBe(true);
  });

  it('captures the first hit for a scope, then throttles within the window', () => {
    expect(shouldCaptureHeldContext('system', 1_000, W)).toBe(true);     // first → capture
    expect(shouldCaptureHeldContext('system', 2_000, W)).toBe(false);    // +1s → throttled
    expect(shouldCaptureHeldContext('system', 300_999, W)).toBe(false);  // just under window
    expect(shouldCaptureHeldContext('system', 301_000, W)).toBe(true);   // window elapsed → capture
    expect(shouldCaptureHeldContext('system', 302_000, W)).toBe(false);  // throttled again
  });

  it('throttles each scope independently', () => {
    expect(shouldCaptureHeldContext('system', 0, W)).toBe(true);
    expect(shouldCaptureHeldContext('organization', 0, W)).toBe(true);
    expect(shouldCaptureHeldContext('partner', 0, W)).toBe(true);
    expect(shouldCaptureHeldContext('system', 1, W)).toBe(false);
    expect(shouldCaptureHeldContext('organization', 1, W)).toBe(false);
    expect(shouldCaptureHeldContext('partner', 1, W)).toBe(false);
  });

  it('quantifies the quota win: a constant-hold scope yields ~13/hr, not 720/hr', () => {
    let captures = 0;
    // One hold every 5s for an hour (721 holds) — the flood that drained quota.
    for (let t = 0; t <= 3_600_000; t += 5_000) {
      if (shouldCaptureHeldContext('system', t, W)) captures++;
    }
    expect(captures).toBe(13); // t=0,300k,600k,…,3.6M — a >98% reduction from 721
  });

  it('reset clears throttle state', () => {
    expect(shouldCaptureHeldContext('system', 1, W)).toBe(true);
    expect(shouldCaptureHeldContext('system', 2, W)).toBe(false);
    __resetHeldContextCaptureThrottleForTests();
    expect(shouldCaptureHeldContext('system', 2, W)).toBe(true);
  });
});

// Guards the second flavor of the same quota failure: the enqueue tripwire
// (assertOutsideHeldDbContext) marks a wrong CALL SITE, not N distinct errors.
// Unthrottled it produced ~2.2k Sentry events in a day from seven call sites
// (BREEZE-H) and helped exhaust the org quota. One capture per site per process
// is the whole signal; console.warn stays per-occurrence.
describe('shouldReportHeldContextSite (enqueue-tripwire Sentry-capture dedupe)', () => {
  beforeEach(() => {
    __resetHeldContextAssertDedupeForTests();
  });

  it('reports a given call site once, then suppresses it', () => {
    expect(shouldReportHeldContextSite('stack-a')).toBe(true);
    expect(shouldReportHeldContextSite('stack-a')).toBe(false);
    expect(shouldReportHeldContextSite('stack-a')).toBe(false);
  });

  it('tracks distinct call sites independently', () => {
    expect(shouldReportHeldContextSite('stack-a')).toBe(true);
    expect(shouldReportHeldContextSite('stack-b')).toBe(true);
    expect(shouldReportHeldContextSite('stack-a')).toBe(false);
    expect(shouldReportHeldContextSite('stack-b')).toBe(false);
  });

  it('reset clears the seen-set', () => {
    expect(shouldReportHeldContextSite('stack-a')).toBe(true);
    __resetHeldContextAssertDedupeForTests();
    expect(shouldReportHeldContextSite('stack-a')).toBe(true);
  });
});
