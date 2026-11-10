/**
 * The facts about a model that tool profiles need (#11393 W01). Leaf module
 * (imports only @breeze/shared) so the candidate loader and `turnBinding.ts` can carry
 * them without pulling the tool registry into their import graphs; the
 * resolver itself lives in `toolExposure.ts`.
 */
import { aiToolAllowlistSchema, type AiToolAllowlist, type AiToolProfile } from '@breeze/shared';

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
  // The column is jsonb: a row that does not parse (hand-edited, a future
  // bug) is treated as an empty allow-list, so `custom` keeps only the
  // always-keep set and the surface floors decide, rather than throwing on
  // every turn.
  const raw = offering?.toolAllowlist ?? null;
  let toolAllowlist: AiToolAllowlist | null = null;
  if (raw !== null) {
    const parsed = aiToolAllowlistSchema.safeParse(raw);
    if (parsed.success) {
      toolAllowlist = parsed.data;
    } else {
      console.warn('[toolProfileFacts] stored tool_allowlist does not parse; treating it as empty');
      toolAllowlist = { domains: [], tools: [] };
    }
  }
  return {
    toolProfile: offering?.toolProfile ?? 'auto',
    toolAllowlist,
    effectiveWindow: null,
    transport,
  };
}
