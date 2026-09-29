/**
 * A-W04 (#6151): per-session Agent SDK tool-search policy.
 *
 * Tool search defers every MCP tool except the registry's `alwaysLoad` core
 * set; the model loads the rest on demand through the SDK's `ToolSearch`
 * built-in. It only works when the built-in is present in `query({ tools })` —
 * `tools: []` removes it and the CLI silently sends every tool non-deferred,
 * which is why the A-W01 baseline never saw search activate.
 *
 * The decision is written into the child env as an explicit
 * `ENABLE_TOOL_SEARCH`, never inherited from the CLI's default:
 * - static-subset surfaces (Helper, script builder, client AI, topology,
 *   headless agents) never search, whatever the operator override says;
 * - `AI_TOOL_SEARCH=off` is the operator kill switch;
 * - a session with too few turns left for a search round-trip keeps the full
 *   list, so the search cannot consume its last turn;
 * - a first-party Anthropic host searches; any other base URL (catalog
 *   endpoint, self-host gateway) keeps today's full list, because proxies may
 *   reject `tool_reference` blocks — unless the operator sets
 *   `AI_TOOL_SEARCH=on` for a proxy known to forward them.
 */

export const SDK_TOOL_SEARCH_BUILTIN = 'ToolSearch';
export const TOOL_SEARCH_MIN_REMAINING_TURNS = 4;

const FIRST_PARTY_HOSTS = new Set(['api.anthropic.com']);

export type ToolSearchOverride = 'auto' | 'on' | 'off';

export type ToolSearchReason =
  | 'first_party_host'
  | 'operator_forced'
  | 'surface_static'
  | 'operator_off'
  | 'low_turn_budget'
  | 'non_first_party_host';

export interface ToolSearchPolicy {
  enabled: boolean;
  reason: ToolSearchReason;
  /** Value for `query({ options: { tools } })`. */
  tools: string[];
  /** Merged over the child env so the CLI never falls back to its own default. */
  env: { ENABLE_TOOL_SEARCH: 'true' | 'false' };
}

/** `AI_TOOL_SEARCH` env: auto (default) | on | off. Anything else reads as auto. */
export function toolSearchOverride(env: NodeJS.ProcessEnv = process.env): ToolSearchOverride {
  const value = env.AI_TOOL_SEARCH?.trim().toLowerCase();
  return value === 'on' || value === 'off' ? value : 'auto';
}

function isFirstPartyHost(childEnv: Record<string, string>): boolean {
  const baseUrl = childEnv.ANTHROPIC_BASE_URL;
  if (!baseUrl) return true;
  try {
    return FIRST_PARTY_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function policy(enabled: boolean, reason: ToolSearchReason): ToolSearchPolicy {
  return {
    enabled,
    reason,
    tools: enabled ? [SDK_TOOL_SEARCH_BUILTIN] : [],
    env: { ENABLE_TOOL_SEARCH: enabled ? 'true' : 'false' },
  };
}

export function resolveToolSearchPolicy(input: {
  /** True only for a surface that registers the full registry (web chat). */
  surfaceSearch: boolean;
  /** The env the SDK child will actually run with (`buildClaudeSdkChildEnv`). */
  childEnv: Record<string, string>;
  /** SDK `maxTurns` this query() will run with. */
  remainingTurns: number;
  override?: ToolSearchOverride;
}): ToolSearchPolicy {
  const override = input.override ?? toolSearchOverride();
  if (!input.surfaceSearch) return policy(false, 'surface_static');
  if (override === 'off') return policy(false, 'operator_off');
  if (input.remainingTurns < TOOL_SEARCH_MIN_REMAINING_TURNS) return policy(false, 'low_turn_budget');
  if (isFirstPartyHost(input.childEnv)) return policy(true, 'first_party_host');
  return override === 'on' ? policy(true, 'operator_forced') : policy(false, 'non_first_party_host');
}

/**
 * An SDK built-in tool call (only `ToolSearch` can be enabled). It never
 * reaches Breeze's MCP pre/post hooks, so it must stay out of the tool-use
 * correlation queue, the transcript's tool rows and the live tool cards.
 */
export function isSdkBuiltinToolUse(name: string): boolean {
  return name === SDK_TOOL_SEARCH_BUILTIN;
}
