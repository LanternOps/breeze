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
