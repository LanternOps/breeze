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
 * `failure` is the turn's observed provider failure (`SdkTurnObservation.providerFailure`).
 * `sawOutput` is whether the turn produced any assistant output.
 *
 * Only a TERMINAL failure before any output cools the bound offering
 * (StreamingSessionManager.settleSdkTurn, W09 D5), so only then can the next
 * message resolve to a backup model. The wording never promises more than that.
 */
export function providerFailureMessage(
  failure: { cause: ProviderFailureCause; terminal: boolean } | null,
  sawOutput: boolean,
): string {
  if (!failure) return PROVIDER_FAILURE_GENERIC_MESSAGE;
  const cooled = failure.terminal && !sawOutput;
  const next = cooled
    ? ' Try again shortly. If a backup model is configured, Breeze uses it while this one recovers.'
    : ' Try again shortly.';
  return CAUSE_TEXT[failure.cause] + next;
}
