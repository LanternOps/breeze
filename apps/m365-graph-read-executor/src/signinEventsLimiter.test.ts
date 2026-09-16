import { describe, expect, it } from 'vitest';
import { createSigninEventsLimiter } from './signinEventsLimiter';
import { createSigninLimiter } from './signinLimiter';
import { renderMetrics, resetMetrics } from './metrics';

describe('app-wide sign-in EVENTS limiter (#5784 W05)', () => {
  it('starts full and drains one token per request', () => {
    let clock = 0;
    const limiter = createSigninEventsLimiter({ requestsPerMinute: 6, now: () => clock });
    expect(limiter.tokens()).toBe(6);
    for (let i = 0; i < 6; i += 1) expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
  });

  it('refills continuously, never above the burst ceiling', () => {
    let clock = 0;
    const limiter = createSigninEventsLimiter({ requestsPerMinute: 6, now: () => clock });
    for (let i = 0; i < 6; i += 1) limiter.tryTake();
    clock += 10_000;                        // 10 s at 6/min ⇒ exactly one token
    expect(limiter.tryTake()).toBe(true);
    expect(limiter.tryTake()).toBe(false);
    clock += 600_000;
    expect(limiter.tokens()).toBe(6);
  });

  it('never blocks — tryTake is synchronous and total', () => {
    const limiter = createSigninEventsLimiter({ requestsPerMinute: 1, now: () => 0 });
    expect(typeof limiter.tryTake()).toBe('boolean');
    expect(typeof limiter.tryTake()).toBe('boolean');
  });

  it('is a SEPARATE bucket from the sign-in ACTIVITY limiter', () => {
    // The whole point of the second bucket: /auditLogs/signIns and
    // /users?$select=signInActivity are different Graph surfaces, so draining
    // one must not starve the other.
    const activity = createSigninLimiter({ requestsPerMinute: 1, now: () => 0 });
    const events = createSigninEventsLimiter({ requestsPerMinute: 1, now: () => 0 });
    expect(activity.tryTake()).toBe(true);
    expect(activity.tryTake()).toBe(false);
    expect(events.tryTake()).toBe(true);
  });

  it('publishes whole remaining tokens on its OWN gauge', () => {
    resetMetrics();
    const limiter = createSigninEventsLimiter({ requestsPerMinute: 6, now: () => 0 });
    limiter.tryTake();
    const rendered = renderMetrics();
    expect(rendered).toContain('m365_signin_events_limiter_tokens 5');
    // The activity gauge is untouched — two buckets, two series.
    expect(rendered).toContain('m365_signin_limiter_tokens 0');
  });
});
