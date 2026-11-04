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

/**
 * #10400: extra SDK `maxTurns` a searching query gets on top of the session's
 * remaining work turns. The session budget (`ai_sessions.turn_count`) counts
 * work only — see `RoundTripTally` — but the SDK's own ceiling counts every
 * model round-trip, search included. Without headroom a query created late in
 * a session would stop mid-turn on its searches with work budget still left.
 * The ceiling stays finite, so a runaway loop (searches included) still trips.
 *
 * The headroom is for searches only. The SDK cannot tell them apart, so a
 * searching query's real work is held to the session's limit in the stream
 * (`ActiveSession.workTurnLimit`), not by this ceiling.
 */
export const TOOL_SEARCH_TURN_HEADROOM = 10;

/** SDK `maxTurns` for a query: the remaining work turns, plus search headroom when it can search. */
export function sdkMaxTurns(remainingWorkTurns: number, searchEnabled: boolean): number {
  return remainingWorkTurns + (searchEnabled ? TOOL_SEARCH_TURN_HEADROOM : 0);
}

/**
 * #10400: per-turn record of which model round-trips did work. The SDK's
 * `num_turns` counts every round-trip, and each ToolSearch load is one, so
 * eight chat messages with nine searches spent a 50-turn session. A
 * round-trip is retrieval-only when every tool call it made is an SDK
 * built-in (ToolSearch); one that calls a real tool, or answers, is work.
 *
 * The CLI emits one assistant message per content block, sharing the API
 * response id, so round-trips are keyed by `message.id`. A message without an
 * id is taken as its own round-trip.
 */
export interface RoundTripTally {
  /** Round-trips that made at least one SDK built-in call. */
  readonly builtinCalls: Set<string>;
  /** Round-trips that made at least one non-built-in tool call. */
  readonly workCalls: Set<string>;
  anonymous: number;
}

export function newRoundTripTally(): RoundTripTally {
  return { builtinCalls: new Set(), workCalls: new Set(), anonymous: 0 };
}

export function noteAssistantRoundTrip(
  tally: RoundTripTally,
  message: { id?: unknown; content?: ReadonlyArray<{ type: string; name?: unknown }> },
): void {
  const key = typeof message.id === 'string' && message.id.length > 0
    ? message.id
    : `anonymous:${tally.anonymous++}`;
  for (const block of message.content ?? []) {
    if (block.type !== 'tool_use') continue;
    if (typeof block.name === 'string' && isSdkBuiltinToolUse(block.name)) tally.builtinCalls.add(key);
    else tally.workCalls.add(key);
  }
}

/**
 * The SDK's `num_turns` less this turn's retrieval-only round-trips. A turn
 * that reached the model is charged at least one turn, so a turn that only
 * searched (a search loop that hit the SDK ceiling) still advances the
 * session toward its limit and can never be retried for free.
 */
export function workTurns(numTurns: number, tally: RoundTripTally): number {
  if (numTurns <= 0) return 0;
  let retrievalOnly = 0;
  for (const key of tally.builtinCalls) if (!tally.workCalls.has(key)) retrievalOnly++;
  return Math.max(1, numTurns - retrievalOnly);
}
