/**
 * AI model registry W09 (#7607): what counts as a failover-eligible provider
 * failure (D8), and the deterministic per-hop reservation key. Pure.
 *
 * Only a provider STATUS response proves the call produced no output and
 * billed nothing. A timeout or a socket reset after send has an unknown
 * outcome and stays on W03's indeterminate path. A malformed request would
 * fail identically on every hop, so it is never a failover cause either.
 */
export const FAILOVER_CAUSES = [
  'ineligible', 'cooldown', 'rate_limited', 'overloaded', 'server_error', 'auth_failed', 'quota_exhausted',
] as const;
export type FailoverCause = (typeof FAILOVER_CAUSES)[number];
export type ProviderFailureCause = Exclude<FailoverCause, 'ineligible' | 'cooldown'>;

/** Upper bound of ai_invocations.failover_hop (DB CHECK): 1 stored-choice default + 5 fallbacks. */
export const MAX_FAILOVER_HOP = 6;
/** The Agent SDK retries a failing request itself; fail over after this many of its retries (agent runs). */
export const SDK_RETRIES_BEFORE_FAILOVER = 2;

/** D9. A key rotation clears the long ones early (clearConnectionCooldowns). */
export const COOLDOWN_TTL_MS: Readonly<Record<ProviderFailureCause, number>> = Object.freeze({
  rate_limited: 60_000,
  overloaded: 60_000,
  server_error: 60_000,
  auth_failed: 15 * 60_000,
  quota_exhausted: 15 * 60_000,
});

const LOW_CREDIT = /credit balance is too low/i;

export function classifyProviderStatus(
  status: number | null | undefined,
  errorType?: string | null,
  message?: string | null,
): ProviderFailureCause | null {
  switch (errorType) {
    case 'overloaded_error': return 'overloaded';
    case 'rate_limit_error': return 'rate_limited';
    case 'billing_error': return 'quota_exhausted';
    case 'authentication_error':
    case 'permission_error': return 'auth_failed';
    case 'api_error': return 'server_error';
    default: break;
  }
  if (status === 529) return 'overloaded';
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'quota_exhausted';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 400 && message && LOW_CREDIT.test(message)) return 'quota_exhausted';
  if (typeof status === 'number' && status >= 500 && status <= 504) return 'server_error';
  return null;
}

interface StatusErrorLike {
  status?: unknown;
  message?: unknown;
  error?: { type?: unknown; error?: { type?: unknown; message?: unknown } } | null;
  cause?: unknown;
}

/** An @anthropic-ai/sdk APIError anywhere in the first five `cause` levels. */
export function classifyProviderError(error: unknown): ProviderFailureCause | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const e = current as StatusErrorLike;
    if (typeof e.status === 'number') {
      const body = e.error && typeof e.error === 'object' ? e.error : null;
      const type = typeof body?.error?.type === 'string' ? body.error.type
        : typeof body?.type === 'string' && body.type !== 'error' ? body.type : null;
      const message = typeof body?.error?.message === 'string' ? body.error.message
        : typeof e.message === 'string' ? e.message : null;
      return classifyProviderStatus(e.status, type, message);
    }
    current = e.cause;
  }
  return null;
}

/** `SDKAssistantMessageError` / `SDKAPIRetryMessage.error` (agent-sdk 0.3.286) + its HTTP status. */
export function classifySdkAssistantError(
  error: string | null | undefined,
  status: number | null | undefined,
): ProviderFailureCause | null {
  switch (error) {
    case 'rate_limit': return 'rate_limited';
    case 'overloaded': return 'overloaded';
    case 'server_error': return 'server_error';
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'cloud_credential_error': return 'auth_failed';
    case 'billing_error':
    case 'account_on_hold': return 'quota_exhausted';
    case 'invalid_request':
    case 'model_not_found':
    case 'max_output_tokens':
    case 'verification_required': return null;
    default: return classifyProviderStatus(status ?? null);
  }
}

/**
 * W09 / PR #7775 review (D8): the classified provider status an agent-run hop
 * ENDS on. The CLI's own final api-error assistant message sets it (null when
 * unclassified); an `api_retry` clears it, since an error the CLI then retried
 * was not final. A result's `api_error_status` restates that final failure
 * with less detail (#7784: low credit is `billing_error` on the assistant
 * message but a bare 400 on the result), so it replaces the cause only when it
 * classifies, and never clears it. Everything else leaves it as it was.
 * Chat applies the equivalent rule in invocationUsage.observeSdkMessage.
 */
export function nextTerminalProviderCause(current: ProviderFailureCause | null, message: unknown): ProviderFailureCause | null {
  if (!message || typeof message !== 'object') return current;
  const m = message as { type?: unknown; subtype?: unknown; error?: unknown; api_error_status?: unknown };
  if (m.type === 'assistant' && typeof m.error === 'string') return classifySdkAssistantError(m.error, null);
  if (m.type === 'system' && m.subtype === 'api_retry') return null;
  if (m.type === 'result' && typeof m.api_error_status === 'number') return classifySdkAssistantError(null, m.api_error_status) ?? current;
  return current;
}

/** Hop 0 keeps the surface's own key (W03 behaviour, replay-compatible); hop n appends `:hop:n`. */
export function hopIdempotencyKey(base: string, hop: number): string {
  if (!Number.isInteger(hop) || hop < 0 || hop > MAX_FAILOVER_HOP) throw new Error(`invalid failover hop ${hop}`);
  return hop === 0 ? base : `${base}:hop:${hop}`;
}

/** D6: causes that leave a session's own choice in place (it is retried next turn). */
export const TRANSIENT_FAILOVER_CAUSES: ReadonlySet<FailoverCause> = new Set<FailoverCause>([
  'cooldown', 'rate_limited', 'overloaded', 'server_error', 'auth_failed', 'quota_exhausted',
]);

const CLI_RETRIES_ITSELF: ReadonlySet<ProviderFailureCause> = new Set(['rate_limited', 'overloaded', 'server_error']);

/**
 * Agent runs: fail over NOW? Never after output, never with nothing
 * configured. A 429/529/5xx is retried by the CLI itself; give it
 * SDK_RETRIES_BEFORE_FAILOVER tries first. A bad key or exhausted quota will
 * not fix itself, so it fails over at once.
 */
export function shouldFailOverNow(
  obs: { providerFailure: { cause: ProviderFailureCause; retries: number } | null; sawOutput: boolean },
  failoverRemaining: readonly string[],
): ProviderFailureCause | null {
  if (!obs.providerFailure || obs.sawOutput || failoverRemaining.length === 0) return null;
  if (CLI_RETRIES_ITSELF.has(obs.providerFailure.cause) && obs.providerFailure.retries < SDK_RETRIES_BEFORE_FAILOVER) return null;
  return obs.providerFailure.cause;
}
