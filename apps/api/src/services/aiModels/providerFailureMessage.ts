/**
 * #7785: the client-safe chat error for a turn that failed on a provider
 * status error. The Agent SDK CLI ends such a turn with a "success" result
 * flagged `is_error` (after its own retries); its synthetic assistant text is
 * raw provider output and is never shown. These strings are fixed text: no
 * provider body, host, or credential ever reaches them.
 */
import type { ProviderFailureCause } from './failover';

export const PROVIDER_FAILURE_GENERIC_MESSAGE = 'The AI model could not complete this response. Try again.';

const CAUSE_TEXT: Readonly<Record<ProviderFailureCause, string>> = Object.freeze({
  overloaded: 'The AI model is overloaded right now.',
  rate_limited: 'The AI model provider is rate-limiting requests right now.',
  server_error: 'The AI model provider returned a server error.',
  auth_failed: 'The AI model provider rejected the credentials for this model.',
  quota_exhausted: 'The AI model provider account for this model is out of credit or quota.',
});

/**
 * #9534: who can fix a rejected key. The platform key is the server's own
 * ANTHROPIC_API_KEY — nothing a partner user can change, so they are sent to
 * their administrator. Every other connection carries a key a partner
 * administrator configured for the model. Unknown owner keeps CAUSE_TEXT.
 * (Before this, the turn showed the CLI's own "Invalid API key · Fix external
 * API key", which pointed a hosted user at a BYO-key page that cannot fix a
 * server credential.)
 */
const AUTH_FAILED_TEXT = Object.freeze({
  platform: "The AI provider rejected the server's API key. Contact your administrator.",
  partner: 'The AI provider rejected the API key configured for this model. An administrator can update it in the AI model settings.',
});

export interface ProviderFailureMessageOptions {
  /** The turn ran on the platform connection (the server's own key). */
  platformKey?: boolean;
}

/**
 * `cause` is the turn's TERMINAL provider failure cause
 * (`SdkTurnObservation.providerFailure` with `terminal: true`), or null. A
 * non-terminal cause is an `api_retry` the CLI may have recovered from, so it
 * must never be passed here: it would blame a later, unrelated failure on it.
 * `sawOutput` is whether the turn produced any assistant output.
 *
 * A terminal failure before any output cools the bound offering
 * (StreamingSessionManager.settleSdkTurn, W09 D5), so only then can the next
 * message resolve to a backup model. The wording never promises more than that.
 *
 * A rejected key with a known owner (`opts.platformKey`) is never told to "try
 * again shortly": a bad key does not fix itself.
 */
export function providerFailureMessage(
  cause: ProviderFailureCause | null,
  sawOutput: boolean,
  opts: ProviderFailureMessageOptions = {},
): string {
  if (!cause) return PROVIDER_FAILURE_GENERIC_MESSAGE;
  const backup = sawOutput ? '' : ' If a backup model is configured, Breeze uses it in the meantime.';
  if (cause === 'auth_failed' && opts.platformKey !== undefined) {
    return (opts.platformKey ? AUTH_FAILED_TEXT.platform : AUTH_FAILED_TEXT.partner) + backup;
  }
  const next = sawOutput
    ? ' Try again shortly.'
    : ' Try again shortly. If a backup model is configured, Breeze uses it while this one recovers.';
  return CAUSE_TEXT[cause] + next;
}
