// Dependency-free home for the offerable-model allowlist and the error a
// session raises when it asks for a model outside it (#7587). Kept out of
// aiCostTracker.ts / aiAgent.ts so request-path code (session creation, the
// /ai/sessions route) can use both without importing — or having to mock —
// those heavy modules. aiCostTracker re-exports OFFERABLE_AI_MODELS for its
// existing importers.

// W00 (#7587) offerable-model list. Since W01 (#7599) no production code reads
// it: offerability is `ai_platform_models.platform_offered` (see
// services/aiModels/platformModels.ts listOfferableModelIds /
// isOfferablePlatformModel). It stays exported, and re-exported by
// aiCostTracker.ts, only until W03 deletes it with MODEL_PRICING (spec §8).
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
