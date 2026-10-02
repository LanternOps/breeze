/**
 * The pre-registry (legacy) model choice for every AI surface whose rule is
 * more than "the resolved partner default" (#7600, AI model registry W02).
 *
 * EXTRACTED, not re-implemented: each legacy call site called the function
 * below, and so did W02's parity oracle (retired in W03 Task 15 once the
 * legacy routing was frozen into parity/w03Goldens.json). It outlives the
 * routing cutover: W03's per-partner cutover
 * still runs the W02 projection, which uses these pickers. W08 deletes it.
 */
import type { ModelRates } from '@breeze/shared';
import { isPlatformModelSnapshotLoaded, peekPlatformModel } from './platformModelSnapshot';
import { platformRateSnapshot } from './pricing';

/** Extension AI's built-in default (services/extensionAi.ts). */
export const EXTENSION_AI_DEFAULT_MODEL = 'claude-haiku-4-5';

/** Office chat (routes/clientAi/sessions.ts): the policy's first allowed model, else the resolved default. */
export function legacyOfficeChatModel(allowedModels: readonly string[], resolvedModel: string): string {
  return allowedModels[0] ?? resolvedModel;
}

/** Extension AI (services/extensionAi.ts): caller → WORKSPACE_CONTENT_LLM_MODEL → Haiku. */
export function legacyExtensionModel(
  inputModel: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return inputModel ?? env.WORKSPACE_CONTENT_LLM_MODEL ?? EXTENSION_AI_DEFAULT_MODEL;
}

/** Script reviewer: the effective ai_script_policies.reviewer_model, else the env/platform reviewer default. */
export function legacyReviewerModel(policyReviewerModel: string | null, envReviewerModel: string): string {
  return policyReviewerModel ?? envReviewerModel;
}

/** AI agents (aiAgents/runLoop.ts): the merged policy model, else the resolved partner default. */
export function legacyAgentModel(effectiveModel: string | null, resolvedModel: string): string {
  return effectiveModel ?? resolvedModel;
}

/**
 * FROZEN copy of W00's aiCostTracker MODEL_PRICING (cents per MTok), moved
 * here in W03 Task 17 (plan R4) when the legacy cost tracker was deleted.
 * `cacheReadPerMillion` overrides the 0.1× input cache-read multiplier.
 * Projection input only: the per-partner cutover (legacyReconcile.ts) and the
 * compat remaps price backfilled non-platform offerings with it so the
 * registry matches what legacy billed. It never prices a live invocation —
 * that is priceInvocation over the resolver's rate snapshot. W08 deletes it.
 */
export const LEGACY_MODEL_RATES: Readonly<Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }>> = Object.freeze({
  'claude-sonnet-5-5': { inputPerMillion: 200, outputPerMillion: 1000 },
  'claude-opus-5-5': { inputPerMillion: 400, outputPerMillion: 2000, cacheReadPerMillion: 20 },
  'claude-fable-5-1': { inputPerMillion: 1000, outputPerMillion: 5000, cacheReadPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 500, outputPerMillion: 2500 },
  'claude-sonnet-4-6': { inputPerMillion: 300, outputPerMillion: 1500 },
  'claude-haiku-4-5': { inputPerMillion: 100, outputPerMillion: 500 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 100, outputPerMillion: 500 },
  'claude-fable-5': { inputPerMillion: 1000, outputPerMillion: 5000 },
  'claude-sonnet-4-5': { inputPerMillion: 300, outputPerMillion: 1500 },
  'claude-sonnet-4-5-20250929': { inputPerMillion: 300, outputPerMillion: 1500 },
});

/** W00's conservative last-resort rate for an id the table does not hold (Opus-tier). */
const LEGACY_DEFAULT_RATE = { inputPerMillion: 500, outputPerMillion: 2500 } as const;
const CACHE_READ_INPUT_MULTIPLIER = 0.1;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

function legacyTableRates(rate: { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }): ModelRates {
  return {
    inputCentsPerM: rate.inputPerMillion,
    outputCentsPerM: rate.outputPerMillion,
    cacheReadCentsPerM: rate.cacheReadPerMillion ?? rate.inputPerMillion * CACHE_READ_INPUT_MULTIPLIER,
    cacheWriteCentsPerM: rate.inputPerMillion * CACHE_WRITE_INPUT_MULTIPLIER,
  };
}

/**
 * The per-million rates legacy charged for `model`, resolved exactly as the
 * deleted calculateCostCents did: a priced row in the loaded platform
 * snapshot, else the frozen table (own keys only — a prototype name such as
 * 'constructor' is never a model id), else the legacy default.
 */
export function getLegacyModelRates(model: string): { rates: ModelRates; source: 'priced' | 'default_pricing' } {
  if (isPlatformModelSnapshotLoaded()) {
    const row = peekPlatformModel(model);
    const snapshot = row ? platformRateSnapshot(row) : null;
    if (snapshot) return { source: 'priced', rates: { ...snapshot.standard } };
  }
  const listed = Object.hasOwn(LEGACY_MODEL_RATES, model) ? LEGACY_MODEL_RATES[model] : undefined;
  if (listed) return { source: 'priced', rates: legacyTableRates(listed) };
  return { source: 'default_pricing', rates: legacyTableRates(LEGACY_DEFAULT_RATE) };
}
