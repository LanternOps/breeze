import { describe, expect, it, vi } from 'vitest';
import { EmailSendHeldError } from '../email';
import { heldSendDecision, heldSendHttpResponse } from './heldSend';

const PARTNER = '11111111-1111-1111-1111-111111111111';

function held(reason: 'over_cap' | 'domain_suspended', retryAt: string): EmailSendHeldError {
  return new EmailSendHeldError({ reason, partnerId: PARTNER, purpose: 'invoice.sent', retryAt: new Date(retryAt) });
}

const HOUR = 60 * 60 * 1000;

describe('heldSendDecision (#12249: reschedule within a maximum age, else drop)', () => {
  it('reschedules to retryAt when that is inside the maximum age', () => {
    const decision = heldSendDecision(held('over_cap', '2026-11-20T00:00:00Z'), {
      firstAttemptAt: new Date('2026-11-19T15:00:00Z'), maxAgeMs: 26 * HOUR, jitterMs: 0,
    });
    expect(decision).toEqual({ action: 'reschedule', at: new Date('2026-11-20T00:00:00Z') });
  });

  it('drops with a reason when retryAt is past the maximum age', () => {
    const decision = heldSendDecision(held('over_cap', '2026-11-20T00:00:00Z'), {
      firstAttemptAt: new Date('2026-11-19T15:00:00Z'), maxAgeMs: 30 * 60 * 1000, jitterMs: 0,
    });
    expect(decision).toEqual({ action: 'drop', reason: 'held:over_cap:past_max_age' });
  });

  it('the boundary: exactly at the deadline still reschedules, one millisecond past drops', () => {
    const first = new Date('2026-11-19T00:00:00Z');
    expect(heldSendDecision(held('domain_suspended', '2026-11-19T01:00:00Z'), { firstAttemptAt: first, maxAgeMs: HOUR, jitterMs: 0 }).action)
      .toBe('reschedule');
    expect(heldSendDecision(held('domain_suspended', '2026-11-19T01:00:00.001Z'), { firstAttemptAt: first, maxAgeMs: HOUR, jitterMs: 0 }))
      .toEqual({ action: 'drop', reason: 'held:domain_suspended:past_max_age' });
  });

  // Every partner held over the cap would otherwise retry in the same instant at
  // 00:00 UTC.
  it('spreads an over-cap retry by up to jitterMs, never earlier than retryAt and never past the deadline', () => {
    const rng = vi.fn(() => 0.5);
    const decision = heldSendDecision(held('over_cap', '2026-11-20T00:00:00Z'), {
      firstAttemptAt: new Date('2026-11-19T15:00:00Z'), maxAgeMs: 26 * HOUR, jitterMs: 10 * 60 * 1000, rng,
    });
    expect(decision).toEqual({ action: 'reschedule', at: new Date('2026-11-20T00:05:00Z') });

    const tight = heldSendDecision(held('over_cap', '2026-11-20T00:00:00Z'), {
      firstAttemptAt: new Date('2026-11-19T00:00:00Z'), maxAgeMs: 24 * HOUR, jitterMs: 10 * 60 * 1000, rng: () => 0.99,
    });
    expect(tight).toEqual({ action: 'reschedule', at: new Date('2026-11-20T00:00:00Z') });
  });
});

describe('heldSendHttpResponse (#12249: a synchronous send answers 4xx, never 500 or a silent 200)', () => {
  it('over the cap → 429 with Retry-After in seconds, rounded up', () => {
    const res = heldSendHttpResponse(held('over_cap', '2026-11-20T00:00:00Z'), new Date('2026-11-19T23:59:58.500Z'));
    expect(res.status).toBe(429);
    expect(res.headers).toEqual({ 'Retry-After': '2' });
    expect(res.body).toEqual({
      error: expect.stringMatching(/daily sending limit/),
      code: 'EMAIL_SEND_HELD',
      reason: 'over_cap',
      retryAt: '2026-11-20T00:00:00.000Z',
    });
  });

  it('an administrator suspension → 409, no Retry-After (its end is unknown)', () => {
    const res = heldSendHttpResponse(held('domain_suspended', '2026-11-19T17:00:00Z'), new Date('2026-11-19T16:00:00Z'));
    expect(res.status).toBe(409);
    expect(res.headers).toEqual({});
    expect(res.body).toMatchObject({ code: 'EMAIL_SEND_HELD', reason: 'domain_suspended' });
    expect(res.body.error).toMatch(/suspended/);
  });

  // The error message carries the partner id and purpose; the response must not.
  it('builds the body from fixed strings, never the error message', () => {
    for (const reason of ['over_cap', 'domain_suspended'] as const) {
      const text = JSON.stringify(heldSendHttpResponse(held(reason, '2026-11-20T00:00:00Z'), new Date('2026-11-19T00:00:00Z')));
      expect(text).not.toContain(PARTNER);
      expect(text).not.toContain('invoice.sent');
    }
  });
});
