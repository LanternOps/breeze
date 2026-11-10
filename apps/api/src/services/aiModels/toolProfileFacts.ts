/**
 * The facts about a model that tool profiles need (#11393 W01). Leaf module
 * (type-only imports) so the candidate loader and `turnBinding.ts` can carry
 * them without pulling the tool registry into their import graphs; the
 * resolver itself lives in `toolExposure.ts`.
 */
import type { AiToolAllowlist, AiToolProfile } from '@breeze/shared';

/** The fingerprint of the identity exposure. Never a hex digest, so it cannot collide with a constrained one. */
export const FULL_IDENTITY_FINGERPRINT = 'full';

export interface ToolProfileFacts {
  toolProfile: AiToolProfile;
  toolAllowlist: AiToolAllowlist | null;
  /** Effective context window (override → min(discovered, fresh observed)); null = unknown. W02 fills it. */
  effectiveWindow: number | null;
  /** `gateway` = OpenAI-compatible translation (schemas can be compacted); `anthropic` = platform/BYO/catalog. */
  transport: 'gateway' | 'anthropic';
}

/** A model with no offering row: `auto` + unknown window = `full`. */
export const DEFAULT_TOOL_PROFILE_FACTS: Readonly<ToolProfileFacts> = Object.freeze({
  toolProfile: 'auto', toolAllowlist: null, effectiveWindow: null, transport: 'anthropic',
});

/**
 * Facts from an offering row. The window stays unknown until W02 reads the
 * `context_window_*` columns, so `auto` resolves to `full` for every offering
 * in W01 (ships dark).
 */
export function toolProfileFactsFrom(
  offering: { toolProfile?: AiToolProfile | null; toolAllowlist?: AiToolAllowlist | null } | null,
  transport: ToolProfileFacts['transport'],
): ToolProfileFacts {
  return {
    toolProfile: offering?.toolProfile ?? 'auto',
    toolAllowlist: offering?.toolAllowlist ?? null,
    effectiveWindow: null,
    transport,
  };
}
