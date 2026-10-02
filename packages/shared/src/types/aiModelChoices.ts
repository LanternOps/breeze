/**
 * Picker and turn-provenance DTOs (AI model registry W05, #7603). Shared by
 * the API and the web. The settings-UI DTOs stay in ./aiModelRegistry.ts (W04).
 */
import type { EffortLevel, ModelSpeed, OfferingOptions } from '../validators/aiModelOptions';

export type AiContinuationReason = 'cross_connection' | 'connection_changed' | 'transcript_too_large' | 'fit_unverifiable';

/** Body of the 409 the messages route returns when a switch cannot resume. */
export interface AiContinuationRequired {
  error: string;
  code: 'continuation_required';
  reason: AiContinuationReason;
  recoverable: true;
  target: { offeringId: string | null; displayName: string };
}

export interface AiModelPriceHint {
  /** Cents per million tokens, standard speed. */
  inputCentsPerM: number;
  outputCentsPerM: number;
  /** The fast-mode rate, only when Fast is selectable on this offering. */
  fast: { inputCentsPerM: number; outputCentsPerM: number } | null;
}

export interface AiModelChoiceDto {
  offeringId: string;
  displayName: string;
  /** The model's context window (max input tokens); null = unknown. */
  contextTokens: number | null;
  funding: 'platform' | 'partner_key';
  priceHint: AiModelPriceHint;
  thinkingMode: 'adaptive' | 'budget' | 'none' | 'unknown';
  /** What the composer may offer for THIS offering on THIS surface's transport. */
  options: {
    effort: EffortLevel[];
    speed: ModelSpeed[];
    budgetThinking: boolean;
  };
  /** The options a turn gets when the user picks nothing (assignment → offering default). */
  defaults: OfferingOptions;
  /** null = selectable. Only `permission_required` is ever listed disabled. */
  disabled: null | { reason: 'permission_required'; permission: string; roleNames: string[] };
}

export interface AiModelChoicesDto {
  surface: 'chat' | 'ai_agents';
  /** Chat: false hides the whole menu and the option controls (spec §11). */
  allowUserChoice: boolean;
  defaultOfferingId: string | null;
  /** Default first, then by display name. Empty when choice is locked (chat). */
  choices: AiModelChoiceDto[];
  /** The session's stamped choice (chat with a sessionId), else null. */
  current: { offeringId: string | null; options: OfferingOptions | null } | null;
}

/** What actually ran a turn (spec §11; W05 spike constraint 5). */
export interface AiTurnModel {
  requestedModel: string;
  requestedDisplayName: string;
  servedModel: string;
  servedDisplayName: string;
  /** The served model differs from the requested one (refusal fallback, CLI swap). */
  fallbackUsed: boolean;
  /** The options the turn was billed with: fast only if it was served fast. */
  appliedOptions: OfferingOptions;
  /** Fast was requested but the provider served standard (429 cooldown). */
  fastDowngraded: boolean;
}
