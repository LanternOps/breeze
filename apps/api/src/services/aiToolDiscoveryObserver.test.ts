import { describe, expect, it } from 'vitest';
import { AI_TOOL_DISCOVERY } from '../db/schema/ai';
import { isMcpInputValidationErrorText } from './aiSessionAutoFlag';
import { newRoundTripTally, noteAssistantRoundTrip, type RoundTripTally } from './aiToolSearchPolicy';
import {
  boundQuery,
  createToolDiscoveryObserver,
  DISCOVERY_QUERY_MAX_BYTES,
  TOOL_DISCOVERY_VALUES,
  type ToolDiscoveryObserver,
} from './aiToolDiscoveryObserver';
import {
  CAPTURED_SHAPE_TURNS,
  observedToolSearchFields,
  assistantText,
  assistantToolCall,
  assistantToolSearch,
  resultMessage,
  userReplayedSearchResult,
  userToolResult,
  userToolSearchResult,
} from './aiToolDiscoveryObserver.fixtures';

const ALWAYS_LOADED = new Set(['query_devices', 'manage_alerts']);

function observer(seedLoaded?: Iterable<string>): ToolDiscoveryObserver {
  return createToolDiscoveryObserver({ isAlwaysLoaded: (name) => ALWAYS_LOADED.has(name), seedLoaded });
}

/** Feed messages to the observer AND to a round-trip tally the way the stream does. */
function feed(o: ToolDiscoveryObserver, tally: RoundTripTally, messages: unknown[]): void {
  for (const message of messages) {
    o.onMessage(message);
    const m = message as { type?: string; message?: { id?: unknown; content?: Array<{ type: string; name?: unknown }> } };
    if (m.type === 'assistant' && m.message) noteAssistantRoundTrip(tally, m.message);
  }
}

describe('createToolDiscoveryObserver — search events', () => {
  it('a ToolSearch tool_use + tool_result pair yields exactly one event', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ messageId: 'msg_1', toolUseId: 'toolu_s1', query: 'restart a service', maxResults: 5 }),
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: ['manage_services', 'manage_processes'] }),
      resultMessage,
    ]);
    const { events } = o.endTurn({ aborted: false, tally });
    expect(events).toEqual([{
      toolUseId: 'toolu_s1',
      roundTripId: 'msg_1',
      query: 'restart a service',
      maxResults: 5,
      selectMode: false,
      resultToolNames: ['manage_services', 'manage_processes'],
      calledToolNames: [],
      totalDeferred: null,
      empty: false,
    }]);
  });

  it('reads total_deferred_tools when present', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ toolUseId: 'toolu_s1', query: 'disk space' }),
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: ['analyze_disk_usage'], totalDeferred: 312 }),
    ]);
    const [event] = o.endTurn({ aborted: false, tally }).events;
    expect(event!.totalDeferred).toBe(312);
    expect(event!.maxResults).toBeNull();
    expect(event!.roundTripId).toBeNull();
  });

  it('an empty result sets empty true and resultToolNames []', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ messageId: 'msg_1', toolUseId: 'toolu_s1', query: 'print spooler', maxResults: 5 }),
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: [] }),
    ]);
    const [event] = o.endTurn({ aborted: false, tally }).events;
    expect(event).toMatchObject({ empty: true, resultToolNames: [] });
  });

  it('select:manage_alerts sets selectMode true', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ toolUseId: 'toolu_s1', query: 'select:manage_alerts' }),
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: ['manage_alerts'] }),
    ]);
    expect(o.endTurn({ aborted: false, tally }).events[0]!.selectMode).toBe(true);
  });

  it('a later call to manage_services lands in calledToolNames and firstCallAfterSearches is 1', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ messageId: 'msg_1', toolUseId: 'toolu_s1', query: 'restart a service', maxResults: 5 }),
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: ['manage_services', 'manage_processes'] }),
      assistantToolCall({ messageId: 'msg_2', toolUseId: 'toolu_c1', name: 'manage_services', input: { action: 'restart' } }),
      userToolResult({ toolUseId: 'toolu_c1' }),
    ]);
    const { events, turn } = o.endTurn({ aborted: false, tally });
    expect(events[0]!.calledToolNames).toEqual(['manage_services']);
    expect(turn.firstCallAfterSearches).toBe(1);
  });

  it('a call to a name no search returned leaves calledToolNames [] (negative control)', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ toolUseId: 'toolu_s1', query: 'restart a service' }),
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: ['manage_services'] }),
      assistantToolCall({ toolUseId: 'toolu_c1', name: 'query_devices' }),
    ]);
    expect(o.endTurn({ aborted: false, tally }).events[0]!.calledToolNames).toEqual([]);
  });

  it('a tool_search_tool_result with an unknown tool_use_id seeds loadedNames and emits no event (Review Focus 2)', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [userReplayedSearchResult({ toolUseId: 'toolu_from_earlier_process', toolNames: ['manage_services'] })]);
    expect([...o.loadedNames()]).toEqual(['manage_services']);
    expect(o.discoveryOf('manage_services')).toBe('loaded_earlier');
    const { events, turn } = o.endTurn({ aborted: false, tally });
    expect(events).toEqual([]);
    expect(turn.searches).toBe(0);
  });

  it('an unmatched ToolSearch at endTurn emits empty true and the turn carries aborted true (Review Focus 1)', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [assistantToolSearch({ messageId: 'msg_1', toolUseId: 'toolu_s1', query: 'restart a service', maxResults: 5 })]);
    const { events, turn } = o.endTurn({ aborted: true, tally });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ toolUseId: 'toolu_s1', empty: true, resultToolNames: [] });
    expect(turn.aborted).toBe(true);
    expect(turn.searches).toBe(1);
  });

  it('a duplicate delivery of the same ToolSearch tool_use opens one event', () => {
    const o = observer();
    const tally = newRoundTripTally();
    const search = assistantToolSearch({ messageId: 'msg_1', toolUseId: 'toolu_s1', query: 'q' });
    o.onMessage(search);
    o.onMessage(search);
    expect(o.endTurn({ aborted: false, tally }).events).toHaveLength(1);
  });
});

describe('createToolDiscoveryObserver — discoveryOf', () => {
  it('always_loaded, searched_this_turn, loaded_earlier and unknown', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ toolUseId: 'toolu_s1', query: 'restart a service' }),
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: ['manage_services'] }),
    ]);
    o.endTurn({ aborted: false, tally });
    const tally2 = newRoundTripTally();
    feed(o, tally2, [
      assistantToolSearch({ toolUseId: 'toolu_s2', query: 'kill a process' }),
      userToolSearchResult({ toolUseId: 'toolu_s2', toolNames: ['manage_processes'] }),
    ]);
    expect(o.discoveryOf('query_devices')).toBe('always_loaded');
    expect(o.discoveryOf('manage_processes')).toBe('searched_this_turn');
    expect(o.discoveryOf('manage_services')).toBe('loaded_earlier');
    expect(o.discoveryOf('run_script')).toBe('unknown');
    // An always-loaded tool a search also returned is still always_loaded.
    expect(o.discoveryOf('mcp__breeze__query_devices')).toBe('always_loaded');
  });

  it('seedLoaded names are loaded_earlier', () => {
    const o = observer(['set_device_context']);
    expect(o.discoveryOf('set_device_context')).toBe('loaded_earlier');
  });

  it('endTurn resets per-turn state: a second turn with no search reports searches 0 and earlier names are loaded_earlier', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ toolUseId: 'toolu_s1', query: 'restart a service' }),
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: ['manage_services'] }),
      assistantToolCall({ toolUseId: 'toolu_c1', name: 'manage_services' }),
    ]);
    o.endTurn({ aborted: false, tally });
    const tally2 = newRoundTripTally();
    feed(o, tally2, [assistantToolCall({ messageId: 'msg_9', toolUseId: 'toolu_c2', name: 'manage_services' })]);
    const second = o.endTurn({ aborted: false, tally: tally2 });
    expect(second.events).toEqual([]);
    expect(second.turn).toEqual({ searches: 0, searchOnlyRoundTrips: 0, workRoundTrips: 1, firstCallAfterSearches: 0, aborted: false });
    expect([...second.discoveryByToolUseId]).toEqual([['toolu_c2', 'loaded_earlier']]);
    expect(o.discoveryOf('manage_services')).toBe('loaded_earlier');
  });

  it('discoveryByToolUseId maps each non-ToolSearch tool_use id to its FINAL discovery, even when the search result arrives after the call', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ messageId: 'msg_1', toolUseId: 'toolu_s1', query: 'restart a service' }),
      // The call's assistant block is processed before the result that loaded it.
      assistantToolCall({ messageId: 'msg_2', toolUseId: 'toolu_c1', name: 'manage_services' }),
    ]);
    expect(o.discoveryOf('manage_services')).toBe('unknown');
    feed(o, tally, [
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: ['manage_services'] }),
      assistantToolCall({ messageId: 'msg_3', toolUseId: 'toolu_c2', name: 'query_devices' }),
    ]);
    const { discoveryByToolUseId, events } = o.endTurn({ aborted: false, tally });
    expect([...discoveryByToolUseId]).toEqual([
      ['toolu_c1', 'searched_this_turn'],
      ['toolu_c2', 'always_loaded'],
    ]);
    expect(discoveryByToolUseId.has('toolu_s1')).toBe(false);
    expect(events[0]!.calledToolNames).toEqual(['manage_services']);
  });
});

describe('createToolDiscoveryObserver — turn tallies', () => {
  it('two search-only round-trips and one work round-trip', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ messageId: 'msg_1', toolUseId: 'toolu_s1', query: 'restart a service' }),
      userToolSearchResult({ toolUseId: 'toolu_s1', toolNames: [] }),
      assistantToolSearch({ messageId: 'msg_2', toolUseId: 'toolu_s2', query: 'windows service control' }),
      userToolSearchResult({ toolUseId: 'toolu_s2', toolNames: ['manage_services'] }),
      assistantToolCall({ messageId: 'msg_3', toolUseId: 'toolu_c1', name: 'manage_services' }),
      userToolResult({ toolUseId: 'toolu_c1' }),
      assistantText({ messageId: 'msg_4', text: 'Done.' }),
      resultMessage,
    ]);
    const { turn } = o.endTurn({ aborted: false, tally });
    expect(turn).toEqual({ searches: 2, searchOnlyRoundTrips: 2, workRoundTrips: 1, firstCallAfterSearches: 2, aborted: false });
  });

  it('a turn with no call has firstCallAfterSearches null', () => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, [assistantText({ messageId: 'msg_1', text: 'Hello' })]);
    expect(o.endTurn({ aborted: false, tally }).turn.firstCallAfterSearches).toBeNull();
  });
});

describe('boundQuery (Review Focus 3)', () => {
  it('cuts a 3,000-char query to ≤ 1024 bytes on a code-point boundary and ends with …[truncated]', () => {
    const long = 'é🙂a'.repeat(1000); // 2 + 4 + 1 bytes per repeat, 3,000 code points
    const bounded = boundQuery(long);
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(DISCOVERY_QUERY_MAX_BYTES);
    expect(bounded.endsWith('…[truncated]')).toBe(true);
    const head = bounded.slice(0, -'…[truncated]'.length);
    expect(long.startsWith(head)).toBe(true);
    // No split surrogate pair: re-encoding round-trips exactly.
    expect(Buffer.from(head, 'utf8').toString('utf8')).toBe(head);
    expect(head).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('a 100-char query is returned unchanged; exactly 1024 bytes is unchanged', () => {
    const short = 'x'.repeat(100);
    expect(boundQuery(short)).toBe(short);
    const exact = 'y'.repeat(DISCOVERY_QUERY_MAX_BYTES);
    expect(boundQuery(exact)).toBe(exact);
    expect(boundQuery(`${exact}z`).endsWith('…[truncated]')).toBe(true);
  });
});

describe('TOOL_DISCOVERY_VALUES', () => {
  it('is AI_TOOL_DISCOVERY (same array identity) and discoveryOf only returns a member', () => {
    expect(TOOL_DISCOVERY_VALUES).toBe(AI_TOOL_DISCOVERY);
    const o = observer(['manage_services']);
    for (const name of ['query_devices', 'manage_services', 'nope', '']) {
      expect(TOOL_DISCOVERY_VALUES).toContain(o.discoveryOf(name));
    }
  });
});

describe('captured-shape fixtures (W02, SDK 0.3.323 stream)', () => {
  const run = (key: keyof typeof CAPTURED_SHAPE_TURNS) => {
    const o = observer();
    const tally = newRoundTripTally();
    feed(o, tally, CAPTURED_SHAPE_TURNS[key]);
    return o.endTurn({ aborted: false, tally });
  };

  it("the hit fixture's ToolSearch tool_use carries exactly the keys ['max_results','query'] and its result nests tool_reference directly under tool_result.content", () => {
    const [call, result] = CAPTURED_SHAPE_TURNS.hit as Array<{ message: { content: Array<Record<string, any>> } }>;
    expect(Object.keys(call!.message.content[0]!.input).sort()).toEqual(['max_results', 'query']);
    expect(result!.message.content[0]!.type).toBe('tool_result');
    expect(result!.message.content[0]!.content[0]).toEqual({ type: 'tool_reference', tool_name: 'mcp__breeze__manage_services' });
  });

  it('observedToolSearchFields(hit) equals the pinned list: totals ride on tool_use_result, no wrapper block, no pending_mcp_servers', () => {
    expect(observedToolSearchFields(CAPTURED_SHAPE_TURNS.hit)).toEqual({
      totalDeferredAt: 'tool_use_result.total_deferred_tools',
      hasToolUseResult: true,
      hasPendingMcpServers: false,
      hasSearchResultWrapperBlock: false,
    });
    expect(observedToolSearchFields(CAPTURED_SHAPE_TURNS.hitNoTotals).totalDeferredAt).toBeNull();
  });

  it('yields totalDeferred 300 for the hit fixture and null when the fixture omits the field (both kept)', () => {
    expect(run('hit').events[0]).toMatchObject({ query: 'restart a windows service', resultToolNames: ['manage_services'], totalDeferred: 300, empty: false, calledToolNames: ['manage_services'] });
    expect(run('hitNoTotals').events[0]).toMatchObject({ resultToolNames: ['manage_services'], totalDeferred: null, empty: false });
  });

  it('an empty search (string content, matches: []) is empty with a total', () => {
    expect(run('empty').events[0]).toMatchObject({ resultToolNames: [], totalDeferred: 300, empty: true });
  });

  it('select: sets selectMode and resolves the named tool', () => {
    expect(run('select').events[0]).toMatchObject({ selectMode: true, resultToolNames: ['manage_services'], empty: false });
  });

  it('the -32602 turn records no search and the call attributes to an unsearched tool (manage_alerts is always loaded)', () => {
    const { events, discoveryByToolUseId } = run('invalidInputDrop');
    expect(events).toEqual([]);
    expect(discoveryByToolUseId.get('toolu_drop')).toBe('always_loaded');
  });

  it('a replayed result from an earlier process emits no event and the later call is loaded_earlier', () => {
    const { events, discoveryByToolUseId } = run('resumed');
    expect(events).toEqual([]);
    expect(discoveryByToolUseId.get('toolu_res_call')).toBe('loaded_earlier');
  });

  it('the captured -32602 text is recognised by the drop classifier (shape pin)', () => {
    const msg = CAPTURED_SHAPE_TURNS.invalidInputDrop[1] as { message: { content: Array<{ content: string }> } };
    expect(isMcpInputValidationErrorText(msg.message.content[0]!.content)).toBe(true);
  });

  it('a message with two results does not take the message-level total (unattributable); a block-level total wins over it', () => {
    const two = (): unknown => ({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'tool_reference', tool_name: 'mcp__breeze__manage_services' }] },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [{ type: 'tool_reference', tool_name: 'mcp__breeze__manage_processes' }] },
      ] },
      tool_use_result: { matches: [], query: 'q', total_deferred_tools: 300 },
    });
    const o = observer(); const tally = newRoundTripTally();
    feed(o, tally, [
      assistantToolSearch({ messageId: 'm1', toolUseId: 'toolu_a', query: 'a' }),
      assistantToolSearch({ messageId: 'm1', toolUseId: 'toolu_b', query: 'b' }),
      two(),
    ]);
    expect(o.endTurn({ aborted: false, tally }).events.map((e) => e.totalDeferred)).toEqual([null, null]);

    const o2 = observer(); const tally2 = newRoundTripTally();
    feed(o2, tally2, [
      assistantToolSearch({ messageId: 'm1', toolUseId: 'toolu_a', query: 'a' }),
      { ...(userToolSearchResult({ toolUseId: 'toolu_a', toolNames: ['manage_services'], totalDeferred: 7 }) as object), tool_use_result: { total_deferred_tools: 300 } },
    ]);
    expect(o2.endTurn({ aborted: false, tally: tally2 }).events[0]!.totalDeferred).toBe(7);
  });
});
