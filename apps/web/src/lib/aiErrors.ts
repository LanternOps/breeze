/**
 * #9428: which failed AI chat turns a "Try again" can fix.
 *
 * The server codes every turn `error` event (`AiStreamErrorCode`); the client
 * adds its own codes for failures no event describes (the fetch threw, or the
 * POST was refused with an HTTP status). Decided from the code only, never the
 * message text. A missing or unknown code (an older server, a new code this
 * build does not know) is never retryable.
 */
import type { AiStreamErrorCode } from '@breeze/shared';

/** Failures the client observes itself (no server event). */
export type AiClientErrorCode = 'disconnect' | 'http_5xx' | 'rejected' | 'rate_limited';

export type AiErrorCode = AiStreamErrorCode | AiClientErrorCode;

const RETRYABLE: ReadonlySet<string> = new Set<AiErrorCode>([
  'timeout',
  'disconnect',
  'http_5xx',
  'provider_error',
  'stream_error',
]);

export function isRetryableAiError(code: string | null | undefined): boolean {
  return typeof code === 'string' && RETRYABLE.has(code);
}

/**
 * The code for a message POST refused with this HTTP status and no code of its
 * own. A 429 is not retried (wait it out); any other 4xx (permission,
 * validation) would be refused again.
 */
export function classifyHttpFailure(status: number): AiClientErrorCode {
  if (status >= 500) return 'http_5xx';
  if (status === 429) return 'rate_limited';
  return 'rejected';
}

/**
 * How a retry re-sends a failed turn:
 * - `retry`: the turn ran and failed; its user row is stored and its bubble is
 *   on screen. Re-send with `retry: true` (no second bubble, no second row).
 * - `reload_first`: the stream broke (`disconnect` / `stream_error`); the turn
 *   may have finished server-side. Reload the transcript first and re-send only
 *   if it still ends with the failed message.
 * - `resend`: the POST was refused before the turn ran; nothing was stored and
 *   the bubble was dropped. Send the text again as a new message.
 */
export type AiRetryMode = 'retry' | 'reload_first' | 'resend';

export function retryModeFor(code: string): AiRetryMode {
  if (code === 'disconnect' || code === 'stream_error') return 'reload_first';
  if (code === 'http_5xx') return 'resend';
  return 'retry';
}

/**
 * The failed turn a "Try again" re-sends. `error` is the banner text at the
 * time of the failure: the target only describes the banner while they still
 * match (any later error replaces the text and so retires the target).
 */
export interface AiRetryTarget {
  sessionId: string;
  content: string;
  code: AiErrorCode;
  detail: string | null;
  mode: AiRetryMode;
  error: string;
}

/** The retry target that still describes the banner's error, else null. */
export function activeRetryTarget(state: { error: string | null; retryTarget: AiRetryTarget | null }): AiRetryTarget | null {
  const { error, retryTarget } = state;
  return retryTarget && error !== null && retryTarget.error === error ? retryTarget : null;
}
