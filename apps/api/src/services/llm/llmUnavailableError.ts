/**
 * Leaf module (no imports) so the connection factory can throw it without
 * importing llmConfigResolver, whose import chain reaches back into
 * providerFidelityHarness via llmProviderCatalog and would form a module-init
 * cycle. llmConfigResolver re-exports it; there is one class.
 */
export class LlmUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'ai_unavailable';

  constructor(message = 'AI is unavailable until the Anthropic API key is reconnected.') {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}
