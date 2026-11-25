// Pure tool-discovery observer for chat turns (#12421 W01).
//
// Folds the SDK message stream the chat path already consumes and answers
// three questions: which ToolSearch queries the model ran and what each
// returned (`search` events), how the turn's round-trips split between
// searching and working (`turn` summary), and how each called tool reached
// the model (`discovery`). It reads only the messages it is given and keeps
// only tool names, ids and the raw query text; the ledger
// (aiToolDiscoveryLedger.ts) redacts and bounds the query before storing it.
//
// Pairing rules:
// - A search is opened by an assistant `tool_use` named `ToolSearch` (keyed by
//   its `id`) and closed by the user block carrying the same `tool_use_id`;
//   the `tool_reference` names nested in that block are its results; the
//   deferred-tool total is the message's `tool_use_result.total_deferred_tools`
//   (captured shape) or a block's `total_deferred_tools` (API-native form).
// - A result block whose `tool_use_id` matches no search opened by this
//   process (a resumed session replaying an earlier process's history) only
//   seeds the session-sticky loaded set and emits nothing.
// - A search still open at `endTurn` (the turn ended between the search and
//   its result) is emitted with `empty: true` and no results.
// - `discovery` for a call is re-evaluated at `endTurn`, so a search result
//   processed after the call's own block still attributes correctly
//   (`discoveryByToolUseId`, reconciled onto ai_tool_executions by the flush).

import { AI_TOOL_DISCOVERY, type AiToolDiscovery } from '../db/schema/ai';
import type { RoundTripTally } from './aiToolSearchPolicy';
import { walkSdkMessageContent } from './llm/toolCapture/sdkMessageWalk';

export const TOOL_DISCOVERY_VALUES = AI_TOOL_DISCOVERY; // one list; the observer never re-declares the union
export type ToolDiscovery = AiToolDiscovery;

export interface DiscoverySearchEvent {
  toolUseId: string;
  roundTripId: string | null;
  query: string;
  maxResults: number | null;
  selectMode: boolean;
  resultToolNames: string[];
  calledToolNames: string[];
  totalDeferred: number | null;
  empty: boolean;
}

export interface DiscoveryTurnSummary {
  searches: number;
  searchOnlyRoundTrips: number;
  workRoundTrips: number;
  firstCallAfterSearches: number | null;
  aborted: boolean;
}

export interface DiscoveryTurnResult {
  events: DiscoverySearchEvent[];
  turn: DiscoveryTurnSummary;
  discoveryByToolUseId: ReadonlyMap<string, ToolDiscovery>;
}

export interface ToolDiscoveryObserver {
  /** Same envelopes as createStreamObserver; `stream_event` and unknown types are ignored. */
  onMessage(message: unknown): void;
  /** Bare or `mcp__breeze__`-prefixed name; reads only in-memory state. */
  discoveryOf(toolName: string): ToolDiscovery;
  /** Session-sticky; survives endTurn. */
  loadedNames(): ReadonlySet<string>;
  endTurn(input: { aborted: boolean; tally: RoundTripTally }): DiscoveryTurnResult;
}

export const DISCOVERY_QUERY_MAX_BYTES = 1024;
const TRUNCATION_MARKER = '…[truncated]';
const BREEZE_MCP_PREFIX = 'mcp__breeze__';
const TOOL_SEARCH = 'ToolSearch';

/**
 * UTF-8 ≤ DISCOVERY_QUERY_MAX_BYTES, cut on a code-point boundary, with the
 * marker counted inside the bound. Callers redact BEFORE bounding: redaction
 * can lengthen the text, and a cut can split a token the redactor would catch.
 */
export function boundQuery(query: string): string {
  if (Buffer.byteLength(query, 'utf8') <= DISCOVERY_QUERY_MAX_BYTES) return query;
  const budget = DISCOVERY_QUERY_MAX_BYTES - Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  let used = 0;
  let head = '';
  for (const ch of query) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > budget) break;
    used += size;
    head += ch;
  }
  return head + TRUNCATION_MARKER;
}

function bareName(name: string): string {
  return name.startsWith(BREEZE_MCP_PREFIX) ? name.slice(BREEZE_MCP_PREFIX.length) : name;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface OpenSearch {
  toolUseId: string;
  roundTripId: string | null;
  query: string;
  maxResults: number | null;
  selectMode: boolean;
  closed: boolean;
  resultToolNames: string[];
  totalDeferred: number | null;
}

/** What one user message's walk found under one `tool_use_id` (or none). */
interface ResultContainer {
  names: string[];
  totalDeferred: number | null;
}

export function createToolDiscoveryObserver(opts: {
  isAlwaysLoaded: (bareName: string) => boolean;
  seedLoaded?: Iterable<string>;
}): ToolDiscoveryObserver {
  const loaded = new Set<string>();
  for (const name of opts.seedLoaded ?? []) loaded.add(bareName(name));

  // Per-turn state, reset by endTurn.
  let searches = new Map<string, OpenSearch>();
  let resultNamesThisTurn = new Set<string>();
  let calls = new Map<string, string>(); // tool_use id → bare name, in stream order
  let firstCallAfterSearches: number | null = null;
  let anonymousSearches = 0;

  function discoveryOf(toolName: string): ToolDiscovery {
    const name = bareName(toolName);
    if (opts.isAlwaysLoaded(name)) return 'always_loaded';
    if (resultNamesThisTurn.has(name)) return 'searched_this_turn';
    if (loaded.has(name)) return 'loaded_earlier';
    return 'unknown';
  }

  function onAssistant(body: Record<string, unknown> | undefined): void {
    const roundTripId = typeof body?.id === 'string' && body.id.length > 0 ? body.id : null;
    walkSdkMessageContent(body?.content, true, {
      onBlock(block, { depth }) {
        if (depth !== 0 || block.type !== 'tool_use' || typeof block.name !== 'string') return;
        const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : null;
        if (block.name === TOOL_SEARCH) {
          const key = id ?? `anonymous:${anonymousSearches++}`;
          if (searches.has(key)) return; // duplicate delivery of the same block
          const input = asRecord(block.input) ?? {};
          const query = typeof input.query === 'string' ? input.query : '';
          searches.set(key, {
            toolUseId: key,
            roundTripId,
            query,
            maxResults: asFiniteNumber(input.max_results),
            selectMode: query.startsWith('select:'),
            closed: false,
            resultToolNames: [],
            totalDeferred: null,
          });
          return;
        }
        if (id === null || calls.has(id)) return;
        if (firstCallAfterSearches === null) firstCallAfterSearches = searches.size;
        calls.set(id, bareName(block.name));
      },
    });
  }

  function onUser(body: Record<string, unknown> | undefined, messageTotalDeferred: number | null): void {
    // The nearest ancestor-or-self block carrying a `tool_use_id`, per depth
    // (pre-order walk, so a sibling at the same depth overwrites its slot).
    const owner: Array<string | null> = [];
    const containers = new Map<string | null, ResultContainer>();
    const containerFor = (key: string | null): ResultContainer => {
      let c = containers.get(key);
      if (!c) { c = { names: [], totalDeferred: null }; containers.set(key, c); }
      return c;
    };
    walkSdkMessageContent(body?.content, false, {
      onBlock(block, { depth }) {
        const inherited = depth > 0 ? owner[depth - 1] ?? null : null;
        const own = typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0 ? block.tool_use_id : null;
        owner.length = depth;
        owner[depth] = own ?? inherited;
        const key = owner[depth] ?? null;
        if (own !== null) containerFor(own);
        const totalDeferred = asFiniteNumber(block.total_deferred_tools);
        if (totalDeferred !== null) containerFor(key).totalDeferred = totalDeferred;
        if (block.type === 'tool_reference' && typeof block.tool_name === 'string') {
          containerFor(key).names.push(bareName(block.tool_name));
        }
      },
    });
    // The captured stream (SDK 0.3.323) carries the deferred-tool total on the
    // MESSAGE (`tool_use_result.total_deferred_tools`), not on a block. It
    // belongs to the one result the message carries; with several results in
    // one message it cannot be attributed, so it is dropped (a block-level
    // total, the API-native form, still wins).
    if (messageTotalDeferred !== null) {
      const keyed = [...containers.entries()].filter(([key]) => key !== null);
      if (keyed.length === 1 && keyed[0]![1].totalDeferred === null) keyed[0]![1].totalDeferred = messageTotalDeferred;
    }
    for (const [key, container] of containers) {
      const search = key === null ? undefined : searches.get(key);
      if (search && !search.closed) {
        search.closed = true;
        search.resultToolNames = [...new Set(container.names)];
        search.totalDeferred = container.totalDeferred;
        for (const name of search.resultToolNames) resultNamesThisTurn.add(name);
        continue;
      }
      // A replayed or unpaired result: names are loaded, no event.
      for (const name of container.names) loaded.add(name);
    }
  }

  return {
    onMessage(message) {
      const envelope = asRecord(message);
      if (!envelope) return;
      if (envelope.type === 'assistant') onAssistant(asRecord(envelope.message));
      else if (envelope.type === 'user') onUser(asRecord(envelope.message), asFiniteNumber(asRecord(envelope.tool_use_result)?.total_deferred_tools));
    },

    discoveryOf,

    loadedNames() {
      return loaded;
    },

    endTurn({ aborted, tally }) {
      const calledNames = [...new Set(calls.values())];
      const events: DiscoverySearchEvent[] = [...searches.values()].map((s) => {
        const results = new Set(s.resultToolNames);
        return {
          toolUseId: s.toolUseId,
          roundTripId: s.roundTripId,
          query: s.query,
          maxResults: s.maxResults,
          selectMode: s.selectMode,
          resultToolNames: s.closed ? s.resultToolNames : [],
          calledToolNames: calledNames.filter((name) => results.has(name)),
          totalDeferred: s.closed ? s.totalDeferred : null,
          empty: !s.closed || s.resultToolNames.length === 0,
        };
      });
      const discoveryByToolUseId = new Map<string, ToolDiscovery>();
      for (const [id, name] of calls) discoveryByToolUseId.set(id, discoveryOf(name));

      let searchOnlyRoundTrips = 0;
      for (const key of tally.builtinCalls) if (!tally.workCalls.has(key)) searchOnlyRoundTrips++;
      const turn: DiscoveryTurnSummary = {
        searches: searches.size,
        searchOnlyRoundTrips,
        workRoundTrips: tally.workCalls.size,
        firstCallAfterSearches,
        aborted,
      };

      for (const name of resultNamesThisTurn) loaded.add(name);
      searches = new Map();
      resultNamesThisTurn = new Set();
      calls = new Map();
      firstCallAfterSearches = null;
      return { events, turn, discoveryByToolUseId };
    },
  };
}

/**
 * The two ai_tool_executions columns every chat-hook insert stamps (#12421
 * W01): `discovery` from the session's observer at insert time (provisional;
 * the turn flush reconciles it by `toolUseId`), `unknown` for a session that
 * does not observe; and the SDK's tool-use id, `null` when it sent none.
 */
export function executionDiscoveryStamp(
  session: { discovery?: ToolDiscoveryObserver | null },
  toolName: string,
  toolUseId: string | undefined,
): { discovery: ToolDiscovery; toolUseId: string | null } {
  return {
    discovery: session.discovery?.discoveryOf(toolName) ?? 'unknown',
    toolUseId: toolUseId ?? null,
  };
}
