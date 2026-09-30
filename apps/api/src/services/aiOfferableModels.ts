// Dependency-free home for the offerable-model allowlist and the error a
// session raises when it asks for a model outside it (#7587). Kept out of
// aiCostTracker.ts / aiAgent.ts so request-path code (session creation, the
// /ai/sessions route) can use both without importing — or having to mock —
// those heavy modules. aiCostTracker re-exports OFFERABLE_AI_MODELS for its
// existing importers.

// Models a partner may pin as their BYOK default. MODEL_PRICING keeps legacy
// snapshot ids for cost attribution on old sessions; those must not be offered
// (or accepted) as new defaults — a retired snapshot pinned partner-wide fails
// every AI session against the partner's own key.
// Also the allowlist for a session's requested `model` on the platform key (#7587).
// The 4.x / fable-5 ids stay so existing partner pins keep validating.
export const OFFERABLE_AI_MODELS: readonly string[] = Object.freeze([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
]);

/** A session was requested on a model this org's AI config may not use (#7587). */
export class InvalidSessionModelError extends Error {
  readonly status = 400;
  readonly code = 'invalid_model';

  constructor(model: string) {
    super(`Model "${model}" is not available for AI sessions.`);
    this.name = 'InvalidSessionModelError';
  }
}
