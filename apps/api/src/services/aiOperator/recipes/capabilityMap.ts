/**
 * Effect tool name → the capability key that gates it, derived from a recipe's
 * own `requires` list (R2 Task 1, G2).
 *
 * PURE — this file lives inside `recipes/` and is scanned by `purity.test.ts`.
 * It imports types only.
 *
 * Moved out of `identityOffboarding.ts`, where it was the module constant
 * `CAPABILITY_FOR_TOOL`, so a second recipe derives its own map instead of
 * reading offboarding's. The derivation is R1's, unchanged: declaration order,
 * a later capability naming the same tool wins, and the helpdesk umbrella is
 * excluded BY NAME.
 *
 * WHY THE UMBRELLA IS EXCLUDED. A recipe dispatched by the helpdesk agent
 * declares one blanket `agent_tool` capability naming EVERY effect tool,
 * because the agent's allowlist has to cover all of them (spec §6.8 / D3). It
 * gates no single tool. If it entered this map, every tool would map to it and
 * the per-effect capabilities — the premise of per-provider degradation, spec
 * §4.1 — would be unreachable. Other `agent_tool` capabilities (the Google
 * tool families) are per-effect gates and DO enter the map, so the exclusion
 * is by key, not by kind.
 */
import type { CapabilityRequirement } from './types';

/** The helpdesk agent's allowlist umbrella: names every effect tool, gates none. */
export const HELPDESK_ALLOWLIST_CAPABILITY = 'agent.helpdesk.tool_allowlist';

/** Effect tool → the capability key that gates it. Frozen. */
export function capabilityForTool(
  recipe: { readonly requires: readonly CapabilityRequirement[] },
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      recipe.requires
        .filter((c) => c.key !== HELPDESK_ALLOWLIST_CAPABILITY)
        .flatMap((c) => (c.toolNames ?? []).map((t) => [t, c.key] as const)),
    ),
  );
}
