import { describe, expect, it } from 'vitest';
import { createSigninLimiter } from './signinLimiter';
import { renderMetrics, resetMetrics } from './metrics';

describe('app-wide sign-in activity limiter', () => {
  it('starts full and drains one token per request', () => {
    let clock = 0;
    const limiter = createSigninLimiter({ requestsPerMinute: 4, now: () => clock });
    expect(limiter.tokens()).toBe(4);
    for (let i = 0; i < 4; i += 1) expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
    expect(limiter.tokens()).toBe(0);
  });

  it('refills continuously, never above the burst ceiling', () => {
    let clock = 0;
    const limiter = createSigninLimiter({ requestsPerMinute: 4, now: () => clock });
    for (let i = 0; i < 4; i += 1) limiter.tryTake();
    clock += 15_000;                       // 15 s at 4/min ⇒ exactly one token
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
    clock += 600_000;                      // ten minutes of idling
    expect(limiter.tokens()).toBe(4);      // capped at the burst ceiling
  });

  it('never blocks — tryTake is synchronous and total', () => {
    const limiter = createSigninLimiter({ requestsPerMinute: 1, now: () => 0 });
    expect(typeof limiter.tryTake()).toBe('boolean');
    expect(typeof limiter.tryTake()).toBe('boolean');
  });

  it('publishes whole remaining tokens as a gauge', () => {
    resetMetrics();
    let clock = 0;
    const limiter = createSigninLimiter({ requestsPerMinute: 4, now: () => clock });
    limiter.tryTake();
    expect(renderMetrics()).toContain('m365_signin_limiter_tokens 3');
  });
});
