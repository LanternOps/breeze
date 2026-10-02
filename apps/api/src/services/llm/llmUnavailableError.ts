/**
 * Leaf module (no imports) so the connection factory can throw it without
 * importing llmConfigResolver, whose import chain reaches back into
 * providerFidelityHarness via llmProviderCatalog and would form a module-init
 * cycle. llmConfigResolver re-exports it; there is one class.
 */
export class LlmUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'ai_unavailable';

  /**
   * @param reason The model resolver's failure reason (`ResolveFailureReason`,
   * e.g. `tools_unsupported`) when `message` is the resolver's user-facing
   * text. Only then is `message` safe to show a client (llmUnavailableBody).
   */
  constructor(
    message = 'AI is unavailable until the Anthropic API key is reconnected.',
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * The 503 body for an LlmUnavailableError (#7793). A resolver refusal says why
 * ("This AI model cannot use tools, which this feature needs.") with its reason
 * as `code`; anything else keeps the opaque `ai_unavailable`, because its
 * message was not written for a client.
 */
export function llmUnavailableBody(err: { message: string; reason?: string | null }): { error: string; code?: string } {
  return err.reason ? { error: err.message, code: err.reason } : { error: 'ai_unavailable' };
}
