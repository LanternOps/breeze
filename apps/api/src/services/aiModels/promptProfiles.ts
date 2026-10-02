/**
 * Prompt-profile hook (spec §7), filled in by W11 (#7609).
 *
 * resolveModel returns the model's prompt profile. The two Agent SDK prompt
 * builders (streamingSessionManager.getOrCreate, aiAgents/runLoop) ask
 * promptProvenanceFor() which variant this conversation gets, render the
 * system prompt with renderSystemPrompt(), and hand the SAME provenance to
 * settleInvocation, so every ledger row records the prompt that was actually
 * sent (ai_invocations.prompt_profile / prompt_variant). Variants and their
 * rollout live in promptVariants.ts.
 */
import { PROMPT_PROFILES, type AiSurface, type PromptProfile } from '@breeze/shared';   // W01 (P1)
import { PROMPT_VARIANTS, appendPromptGuidance, getPromptVariant, selectPromptVariant } from './promptVariants';

export { PROMPT_PROFILES, type PromptProfile };

export function toPromptProfile(value: string | null | undefined): PromptProfile {
  return (PROMPT_PROFILES as readonly string[]).includes(value ?? '') ? (value as PromptProfile) : 'generic';
}

/** The prompt a model call was built with: its profile and the variant appended (null = the base prompt). */
export interface PromptProvenance {
  profile: PromptProfile;
  variant: string | null;
}

/**
 * The variant this conversation gets. `subjectId` is the breeze session id
 * (chat-like surfaces) or the agent run id: the canary is sticky per subject.
 */
export function promptProvenanceFor(input: { surface: AiSurface; profile: PromptProfile; subjectId: string | null }): PromptProvenance {
  const variant = selectPromptVariant(input, PROMPT_VARIANTS);
  return { profile: input.profile, variant: variant?.id ?? null };
}

export function renderSystemPrompt(systemPrompt: string, provenance: PromptProvenance): string {
  if (!provenance.variant) return systemPrompt;
  const variant = getPromptVariant(provenance.variant, PROMPT_VARIANTS);
  if (!variant) {
    // Unreachable in-process (provenance comes from promptProvenanceFor over
    // the same registry); the base prompt is the safe answer.
    console.warn('[promptProfiles] unknown prompt variant; sending the base prompt', { variant: provenance.variant });
    return systemPrompt;
  }
  return appendPromptGuidance(systemPrompt, variant);
}
