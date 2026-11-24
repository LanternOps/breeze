import type { EmailSendHeldError } from '../email';

/**
 * What a caller does with a held send (#12249). There is no hold queue and no
 * midnight release: the held error carries `retryAt`, and each sender applies
 * its own policy to it.
 *
 * - Queue and outbox senders call `heldSendDecision` with the time the message
 *   was first attempted and their own maximum age. Inside it they reschedule to
 *   `retryAt`; past it they drop the message and log why (`logHeldSendDropped`).
 * - Synchronous routes whose request has not committed anything answer with
 *   `heldSendHttpResponse`: 429 + Retry-After over the cap, 409 for an
 *   administrator's suspension. Never a 500, never a 200 that looks sent.
 * - Routes that already committed their state change (a quote flipped to sent,
 *   an access request decided) keep their 2xx and report the email as held in
 *   their existing `emailed: false` shape: a 4xx would claim the action failed.
 * - Anonymous routes that answer the same whatever happened (portal forgot
 *   password, trust-page access request) keep that answer: a 4xx would tell an
 *   outsider whether an address exists.
 */

export type HeldSendDecision =
  | { action: 'reschedule'; at: Date }
  | { action: 'drop'; reason: string };

export interface HeldSendDecisionOptions {
  /** When the message was first attempted (job timestamp, row created_at). */
  firstAttemptAt: Date | number;
  /** The sender's own limit: past firstAttemptAt + maxAgeMs the message is dropped. */
  maxAgeMs: number;
  /**
   * Spread over-cap retries by up to this much after `retryAt`, so every held
   * partner does not retry in the same instant at 00:00 UTC. Default 15 min.
   * Never pushes the retry past the deadline.
   */
  jitterMs?: number;
  rng?: () => number;
}

const DEFAULT_JITTER_MS = 15 * 60 * 1000;

/**
 * Structural check instead of `instanceof`, so this module needs only a type
 * import of email.ts (no runtime cycle) and callers whose suites mock
 * services/email still recognise the error.
 */
export function isEmailSendHeldError(err: unknown): err is EmailSendHeldError {
  return err instanceof Error
    && err.name === 'EmailSendHeldError'
    && (err as { retryAt?: unknown }).retryAt instanceof Date
    && typeof (err as { reason?: unknown }).reason === 'string';
}

export function heldSendDecision(err: EmailSendHeldError, opts: HeldSendDecisionOptions): HeldSendDecision {
  const first = typeof opts.firstAttemptAt === 'number' ? opts.firstAttemptAt : opts.firstAttemptAt.getTime();
  const deadline = first + opts.maxAgeMs;
  const retryAt = err.retryAt.getTime();
  if (!Number.isFinite(retryAt) || !Number.isFinite(deadline) || retryAt > deadline) {
    return { action: 'drop', reason: `held:${err.reason}:past_max_age` };
  }
  const jitter = err.reason === 'over_cap'
    ? Math.floor((opts.rng ?? Math.random)() * (opts.jitterMs ?? DEFAULT_JITTER_MS))
    : 0;
  return { action: 'reschedule', at: new Date(Math.min(retryAt + jitter, deadline)) };
}

/**
 * The one log line for a held message given up on. Identifiers only: never
 * the recipient or the body.
 */
export function logHeldSendDropped(site: string, err: EmailSendHeldError, fields: Record<string, unknown> = {}): void {
  console.warn('[email] held send dropped', {
    site,
    reason: err.reason,
    partnerId: err.partnerId,
    purpose: err.purpose,
    retryAt: err.retryAt.toISOString(),
    ...fields,
  });
}

export interface HeldSendHttpResponse {
  status: 409 | 429;
  headers: Record<string, string>;
  body: { error: string; code: 'EMAIL_SEND_HELD'; reason: EmailSendHeldError['reason']; retryAt: string };
}

/** Fixed strings only: the error's message names the partner id and purpose. */
const HTTP_ERROR: Record<EmailSendHeldError['reason'], string> = {
  over_cap: 'Email not sent: this account has reached its daily sending limit. Try again after the limit resets.',
  domain_suspended: 'Email not sent: sending from this account\'s email domain is suspended. Contact support.',
};

export function heldSendHttpResponse(err: EmailSendHeldError, now: Date = new Date()): HeldSendHttpResponse {
  const body = { error: HTTP_ERROR[err.reason], code: 'EMAIL_SEND_HELD' as const, reason: err.reason, retryAt: err.retryAt.toISOString() };
  if (err.reason === 'over_cap') {
    const seconds = Math.max(1, Math.ceil((err.retryAt.getTime() - now.getTime()) / 1000));
    return { status: 429, headers: { 'Retry-After': String(seconds) }, body };
  }
  return { status: 409, headers: {}, body };
}
