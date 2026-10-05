/**
 * HTTP answer for a one-shot (Messages API) surface whose model did not
 * resolve. Shared by the ticket-draft and Office ticket routes so both keep
 * the pre-registry contracts:
 *
 * - a deployment with NO platform credential answers `ai_unavailable` (503)
 *   and raises the shared hourly platform-key alert, exactly as
 *   getAnthropicClientForPartner did — the resolver reports an unconfigured
 *   platform connection as `connection_unavailable` BEFORE any client is
 *   built, so the factory's own alert never fires on that path;
 * - the registry-cutover gate is a transient 503;
 * - anything else is the recoverable 409 "choose another" with its code.
 *
 * Like the SDK surfaces' `ai_not_configured` mapping, the platform-key test is
 * deployment-wide, so an unavailable BYOK connection on a keyless deployment
 * is also reported as 503 here.
 */
import { isPlatformLlmConfigured } from '../llm/llmAvailability';
import { reportPlatformKeyMissing } from '../llm/platformKeyAlert';
import type { ModelUnavailable } from './resolveModel';

export type OneShotUnavailableAnswer =
  | { status: 503; body: { error: 'ai_unavailable' } }
  | { status: 503 | 409; body: { error: string; code: string; recoverable: true } };

/**
 * True (and the shared hourly platform-key alert raised) when an unresolved
 * model is `connection_unavailable` on a deployment with NO platform
 * credential at all. Every registry caller that can hit that path routes the
 * alert through here (one-shot routes, AI agent admission and dispatch), since
 * the resolver answers before any client is built and the factory's own alert
 * never fires.
 */
export function reportIfPlatformKeyMissing(turn: Pick<ModelUnavailable, 'reason'>): boolean {
  if (turn.reason !== 'connection_unavailable' || isPlatformLlmConfigured(process.env.ANTHROPIC_API_KEY, 'agent_sdk')) {
    return false;
  }
  reportPlatformKeyMissing();
  return true;
}

export function oneShotUnavailableAnswer(turn: ModelUnavailable): OneShotUnavailableAnswer {
  if (reportIfPlatformKeyMissing(turn)) {
    return { status: 503, body: { error: 'ai_unavailable' } };
  }
  return {
    status: turn.reason === 'registry_unavailable' ? 503 : 409,
    body: { error: turn.message, code: turn.reason, recoverable: true },
  };
}
