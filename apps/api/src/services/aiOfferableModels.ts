// Dependency-free home for W00's offerable-model allowlist (#7587).
// aiCostTracker re-exports OFFERABLE_AI_MODELS for its existing importers.
// The session-model error moved to services/aiModels/sessionModel.ts (W03
// Task 9), where session creation now resolves its offering.

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
