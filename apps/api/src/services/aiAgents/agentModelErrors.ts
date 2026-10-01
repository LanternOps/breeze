/**
 * Leaf module (no imports) so the AI agents route and its tests can map this
 * error without loading the registry resolver's DB adapters.
 * agentModelBinding.ts re-exports it; there is one class.
 */

/** An agent policy `model` that cannot be bound to a registry offering (AI model registry W03). */
export class AgentModelNotAllowedError extends Error {
  readonly status: 400 | 503;
  readonly code: 'invalid_model' | 'not_permitted' | 'registry_unavailable';

  constructor(message: string, code: AgentModelNotAllowedError['code']) {
    super(message);
    this.name = 'AgentModelNotAllowedError';
    this.code = code;
    this.status = code === 'registry_unavailable' ? 503 : 400;
  }
}
