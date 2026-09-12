/**
 * SEC-150: the provider-response classification table, in isolation.
 *
 * The whole fail-closed contract rests on this function telling three things
 * apart that all arrive as "the expire call threw":
 *   - PERMANENT and safe   (`resource_missing` — nothing payable can exist)
 *   - PERMANENT and unsafe (dead/under-scoped credential — retrying is noise)
 *   - TRANSIENT            (timeout / rate limit / 5xx — the only retryable class)
 *
 * Misclassifying the second as the third blocks every transition on that
 * invoice forever; misclassifying the third as the first declares a live
 * session dead. Both are the finding, re-opened.
 */
import { describe, it, expect } from 'vitest';
import { classifyExpireError } from './stripeSessionRevocation';
import { checkoutSessionExpiry } from './invoiceCheckout';
import { StripeCredentialUnavailableError } from './stripeCredentialArchive';

/** Shaped like a Stripe SDK error: `type` + optional `code`. */
function stripeError(type: string, code?: string, message = 'stripe says no'): Error {
  return Object.assign(new Error(message), { type, ...(code ? { code } : {}) });
}

describe('classifyExpireError', () => {
  it('treats a missing session as REVOKED — nothing payable can exist', () => {
    expect(classifyExpireError(stripeError('StripeInvalidRequestError', 'resource_missing')))
      .toEqual({ kind: 'revoked', providerCode: 'resource_missing' });
  });

  it.each([
    ['authentication failure', stripeError('StripeAuthenticationError')],
    ['expired api key', stripeError('StripeInvalidRequestError', 'api_key_expired')],
    ['invalid account', stripeError('StripeInvalidRequestError', 'account_invalid')],
    ['restricted key without Checkout write', stripeError('StripePermissionError')],
  ])('treats %s as BLOCKED, not retryable', (_label, err) => {
    const outcome = classifyExpireError(err);
    expect(outcome.kind).toBe('blocked');
  });

  it.each([
    ['connection error', stripeError('StripeConnectionError')],
    ['rate limit', stripeError('StripeRateLimitError')],
    ['stripe 5xx', stripeError('StripeAPIError')],
    ['request timeout', stripeError('StripeInvalidRequestError', undefined, 'Request timed out')],
  ])('treats %s as RETRYABLE', (_label, err) => {
    expect(classifyExpireError(err).kind).toBe('retryable');
  });

  it('treats an unavailable archived credential as BLOCKED with the actionable reason', () => {
    const outcome = classifyExpireError(
      new StripeCredentialUnavailableError('gone', 'credential_unavailable'));
    expect(outcome).toMatchObject({ kind: 'blocked', providerCode: 'credential_unavailable' });
  });

  it('defers an unrecognised invalid-request refusal to a session read rather than guessing', () => {
    // "You may only expire a session that is open" is the same error shape for an
    // already-expired session (safe) and an already-PAID one (a real charge), so
    // this classification must stay retryable and let expireOneSession retrieve
    // the session's actual status.
    expect(classifyExpireError(stripeError('StripeInvalidRequestError', 'session_not_open')).kind)
      .toBe('retryable');
  });
});

describe('checkoutSessionExpiry', () => {
  it('stays inside Stripe\'s [30 min, 24 h] window at both ends of the hour', () => {
    const topOfHour = new Date('2026-09-10T12:00:00.000Z');
    const endOfHour = new Date('2026-09-10T12:59:59.000Z');
    for (const now of [topOfHour, endOfHour]) {
      const aheadSeconds = checkoutSessionExpiry(now).expiresAt - Math.floor(now.getTime() / 1000);
      expect(aheadSeconds).toBeGreaterThan(30 * 60);
      expect(aheadSeconds).toBeLessThan(24 * 3600);
    }
  });

  it('is stable within an hour so an idempotent replay keeps identical parameters', () => {
    const a = checkoutSessionExpiry(new Date('2026-09-10T12:00:00.000Z'));
    const b = checkoutSessionExpiry(new Date('2026-09-10T12:59:59.000Z'));
    expect(b).toEqual(a);
  });

  it('moves to a new quantum across the hour boundary so the key family changes with the params', () => {
    const a = checkoutSessionExpiry(new Date('2026-09-10T12:59:59.000Z'));
    const b = checkoutSessionExpiry(new Date('2026-09-10T13:00:00.000Z'));
    expect(b.quantum).toBe(a.quantum + 3600);
    expect(b.expiresAt).not.toBe(a.expiresAt);
  });
});
