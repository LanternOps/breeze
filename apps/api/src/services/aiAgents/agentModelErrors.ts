/**
 * Leaf module (no imports) so the AI agents route and its tests can map this
 * error without loading the registry resolver's DB adapters.
 * agentModelBinding.ts re-exports it; there is one class.
 */

/**
 * An agent policy model (a `model` string or, W05, an `offeringId`) that
 * cannot be bound to a registry offering (AI model registry W03/W05).
 * `permission_required` (403, W05): the WRITER lacks the offering's
 * `required_permission` — a run skips that rule, so the write is its gate.
 * `model_unavailable` (400, W05): the offering fails another eligibility rule.
 */
export class AgentModelNotAllowedError extends Error {
  readonly status: 400 | 403 | 503;
  readonly code: 'invalid_model' | 'not_permitted' | 'registry_unavailable' | 'permission_required' | 'model_unavailable';

  constructor(message: string, code: AgentModelNotAllowedError['code']) {
    super(message);
    this.name = 'AgentModelNotAllowedError';
    this.code = code;
    this.status = code === 'registry_unavailable' ? 503 : code === 'permission_required' ? 403 : 400;
  }
}
