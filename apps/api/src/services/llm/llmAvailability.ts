import { getConfig } from '../../config/validate';
import type { ResolvedLlmConfig } from './llmConfigResolver';

/**
 * The ONE answer to "can a model actually be called for this org?", shared by
 * chat, the script builder and the topology AI readiness check.
 *
 * `resolveLlmConfig` alone is not that answer: its `platform` result means
 * only "no partner BYO key applies", and carries whatever
 * `ANTHROPIC_API_KEY` happens to be — possibly nothing. Callers that stopped
 * at `source !== 'unavailable'` started sessions on a server with no model
 * key at all; the model turn then ran with no credentials and the surface
 * showed an empty or "partial" answer instead of saying AI is not set up.
 *
 * - `ai_unavailable`: a partner BYO config exists but cannot be used (bad or
 *   undecryptable key, delisted / unverified catalog provider). Fixed by
 *   reconnecting the partner's provider.
 * - `ai_not_configured`: the platform path has no credential at all. Fixed by
 *   an administrator adding a model provider key to the server (or a partner
 *   BYO key).
 */
export type LlmUnusableCode = 'ai_unavailable' | 'ai_not_configured';

/**
 * Every credential the PLATFORM (non-partner) AI subprocess can authenticate
 * with. `ANTHROPIC_AUTH_TOKEN` is the documented self-host credential for an
 * `ANTHROPIC_BASE_URL` gateway (#1412), used instead of `ANTHROPIC_API_KEY`.
 * The SDK child-env builder (streamingSessionManager) strips exactly this set
 * from a partner session, so the two lists cannot drift.
 */
export const PLATFORM_LLM_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export const AI_NOT_CONFIGURED_MESSAGE =
  'AI is not configured on this server. An administrator needs to add a model provider key.';

/** Response body for the `ai_not_configured` refusal: readable text plus the stable code the web renders. */
export const AI_NOT_CONFIGURED_BODY = { error: AI_NOT_CONFIGURED_MESSAGE, code: 'ai_not_configured' } as const;

export class LlmNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = 'ai_not_configured';

  constructor(message = AI_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = 'LlmNotConfiguredError';
  }
}

/**
 * Platform chat runs on an OpenAI-compatible endpoint instead of the Agent
 * SDK (`MCP_LLM_PROVIDER=openai-compatible`; its URL, model and key are
 * boot-validated). False before the config is validated.
 */
export function isOpenAICompatibleProvider(): boolean {
  try {
    return getConfig().MCP_LLM_PROVIDER === 'openai-compatible';
  } catch {
    return false;
  }
}

function present(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Whether the platform path has any model credential. `apiKey` is the
 * resolved platform config's snapshot of `ANTHROPIC_API_KEY` (the same env var
 * when omitted).
 */
export function isPlatformLlmConfigured(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): boolean {
  const credentialPresent = PLATFORM_LLM_CREDENTIAL_ENV_KEYS.some((key) =>
    present(key === 'ANTHROPIC_API_KEY' ? apiKey : process.env[key]));
  return credentialPresent || isOpenAICompatibleProvider();
}

/** Why no model can be called for `resolved`, or null when one can. */
export function llmUnusableCode(resolved: ResolvedLlmConfig): LlmUnusableCode | null {
  if (resolved.source === 'unavailable') return 'ai_unavailable';
  if (resolved.source === 'platform' && !isPlatformLlmConfigured(resolved.apiKey)) return 'ai_not_configured';
  return null;
}
