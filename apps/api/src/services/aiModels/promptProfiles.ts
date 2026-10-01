/**
 * Prompt-profile hook (spec §7). resolveModel returns the model's profile and
 * system-prompt builders pass their prompt through applyPromptProfile. v1 ships
 * ONE prompt per surface, so this is the identity; W11 adds per-profile
 * variants, measured against the quality view. Keeping the call sites now
 * means W11 changes one file.
 */
import { PROMPT_PROFILES, type AiSurface, type PromptProfile } from '@breeze/shared';   // W01 (P1)

export { PROMPT_PROFILES, type PromptProfile };

export function toPromptProfile(value: string | null | undefined): PromptProfile {
  return (PROMPT_PROFILES as readonly string[]).includes(value ?? '') ? (value as PromptProfile) : 'generic';
}

export function applyPromptProfile(_surface: AiSurface, _profile: PromptProfile, systemPrompt: string): string {
  return systemPrompt;
}
