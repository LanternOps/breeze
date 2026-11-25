// Synthesised SDK stream fixtures for the tool-discovery observer (#12421 W01).
//
// Built by hand from the shapes streamObserver.test.ts already uses: an
// assistant `tool_use` named `ToolSearch` with `input: { query, max_results }`,
// and a user `tool_result` (same `tool_use_id`) whose content holds a
// `tool_search_tool_result` with `tool_reference { tool_name }` blocks (the
// API-native wrapper form; the W01 tests use it).
//
// W02 (#12421) adds the CAPTURED-SHAPE builders at the bottom, written by hand
// from a live capture of the chat surface (SDK 0.3.323, CLI 2.1.323, deny
// mode, synthetic prompts): there the result is a plain `tool_result` whose
// `content` is `tool_reference` blocks directly (no wrapper), and the total
// of deferred tools rides on the MESSAGE (`tool_use_result.total_deferred_tools`),
// not on a block. Every name, query and id here is a placeholder; nothing
// comes from production or from the capture's content.

const MCP = 'mcp__breeze__';

export function assistantToolSearch(opts: { messageId?: string; toolUseId: string; query: string; maxResults?: number }): unknown {
  const input: Record<string, unknown> = { query: opts.query };
  if (opts.maxResults !== undefined) input.max_results = opts.maxResults;
  return {
    type: 'assistant',
    message: {
      ...(opts.messageId ? { id: opts.messageId } : {}),
      content: [{ type: 'tool_use', id: opts.toolUseId, name: 'ToolSearch', input }],
    },
  };
}

export function userToolSearchResult(opts: { toolUseId: string; toolNames: string[]; totalDeferred?: number }): unknown {
  return {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: opts.toolUseId,
        content: [{
          type: 'tool_search_tool_result',
          ...(opts.totalDeferred !== undefined ? { total_deferred_tools: opts.totalDeferred } : {}),
          content: opts.toolNames.map((name) => ({ type: 'tool_reference', tool_name: `${MCP}${name}` })),
        }],
      }],
    },
  };
}

/** A replayed search result from an earlier process: its tool_use_id pairs with no ToolSearch seen here. */
export function userReplayedSearchResult(opts: { toolUseId: string; toolNames: string[] }): unknown {
  return {
    type: 'user',
    message: {
      content: [{
        type: 'tool_search_tool_result',
        tool_use_id: opts.toolUseId,
        content: opts.toolNames.map((name) => ({ type: 'tool_reference', tool_name: `${MCP}${name}` })),
      }],
    },
  };
}

export function assistantToolCall(opts: { messageId?: string; toolUseId: string; name: string; input?: Record<string, unknown> }): unknown {
  return {
    type: 'assistant',
    message: {
      ...(opts.messageId ? { id: opts.messageId } : {}),
      content: [{ type: 'tool_use', id: opts.toolUseId, name: `${MCP}${opts.name}`, input: opts.input ?? {} }],
    },
  };
}

export function userToolResult(opts: { toolUseId: string; text?: string }): unknown {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: opts.toolUseId, content: [{ type: 'text', text: opts.text ?? 'ok' }] }] },
  };
}

export function assistantText(opts: { messageId?: string; text: string }): unknown {
  return {
    type: 'assistant',
    message: { ...(opts.messageId ? { id: opts.messageId } : {}), content: [{ type: 'text', text: opts.text }] },
  };
}

export const resultMessage = { type: 'result', subtype: 'success', num_turns: 3 };

// ---------------------------------------------------------------------------
// Captured shape (W02). Which of these shapes were captured and which were
// synthesised is recorded in the plan's "Spike 0b finding".
// ---------------------------------------------------------------------------

/** The captured assistant ToolSearch call: input keys are exactly `query` and `max_results`; the block also carries `caller: { type: 'direct' }`. */
export function capturedAssistantToolSearch(opts: { messageId?: string; toolUseId: string; query: string; maxResults?: number }): unknown {
  return {
    type: 'assistant',
    message: {
      ...(opts.messageId ? { id: opts.messageId } : {}),
      role: 'assistant',
      content: [{
        type: 'tool_use', id: opts.toolUseId, name: 'ToolSearch', caller: { type: 'direct' },
        input: { query: opts.query, max_results: opts.maxResults ?? 5 },
      }],
    },
  };
}

/**
 * The captured search result. A hit: `tool_result.content` is `tool_reference`
 * blocks directly. An empty search: `content` is the string
 * `No matching deferred tools found`. The message-level `tool_use_result`
 * carries `{ matches, query, total_deferred_tools }`; `totalDeferred: null`
 * omits it (the "field absent" control).
 */
export function capturedUserSearchResult(opts: { toolUseId: string; toolNames: string[]; query: string; totalDeferred: number | null }): unknown {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: opts.toolUseId,
        content: opts.toolNames.length === 0
          ? 'No matching deferred tools found'
          : opts.toolNames.map((name) => ({ type: 'tool_reference', tool_name: `${MCP}${name}` })),
      }],
    },
    parent_tool_use_id: null,
    ...(opts.totalDeferred === null ? {} : {
      tool_use_result: {
        matches: opts.toolNames.map((name) => `${MCP}${name}`), query: opts.query, total_deferred_tools: opts.totalDeferred,
      },
    }),
  };
}

/** The captured -32602 refusal: an error `tool_result` whose content is a string; `tool_use_result` is a string too. */
export function capturedUserInputValidationError(opts: { toolUseId: string; toolName: string }): unknown {
  const text = `MCP error -32602: Input validation error: Invalid arguments for tool ${opts.toolName}: [ { "code": "invalid_value", "path": [ "action" ] } ]`;
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: opts.toolUseId, is_error: true, content: text }] },
    parent_tool_use_id: null,
    tool_use_result: text,
  };
}

/** Where, in a captured-shape message list, the ToolSearch totals live. Pinned by the test so a new SDK shape fails loudly. */
export function observedToolSearchFields(messages: unknown[]): {
  totalDeferredAt: 'tool_use_result.total_deferred_tools' | 'block.total_deferred_tools' | null;
  hasToolUseResult: boolean;
  hasPendingMcpServers: boolean;
  hasSearchResultWrapperBlock: boolean;
} {
  const out = { totalDeferredAt: null as 'tool_use_result.total_deferred_tools' | 'block.total_deferred_tools' | null,
    hasToolUseResult: false, hasPendingMcpServers: false, hasSearchResultWrapperBlock: false };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;
    if (rec.type === 'tool_search_tool_result') out.hasSearchResultWrapperBlock = true;
    if ('pending_mcp_servers' in rec) out.hasPendingMcpServers = true;
    if (typeof rec.total_deferred_tools === 'number') out.totalDeferredAt ??= 'block.total_deferred_tools';
    for (const v of Object.values(rec)) visit(v);
  };
  for (const message of messages) {
    const m = message as Record<string, unknown>;
    const result = m.tool_use_result;
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
      out.hasToolUseResult = true;
      if (typeof (result as Record<string, unknown>).total_deferred_tools === 'number') out.totalDeferredAt = 'tool_use_result.total_deferred_tools';
    }
    visit(m.message);
  }
  return out;
}

/** The five captured-shape turns. `resumed` is SYNTHESISED, not captured (the capture's resumed turn replayed nothing into the stream). */
export const CAPTURED_SHAPE_TURNS: Record<'hit' | 'hitNoTotals' | 'empty' | 'select' | 'invalidInputDrop' | 'resumed', unknown[]> = {
  hit: [
    capturedAssistantToolSearch({ messageId: 'msg_h1', toolUseId: 'toolu_hit', query: 'restart a windows service' }),
    capturedUserSearchResult({ toolUseId: 'toolu_hit', toolNames: ['manage_services'], query: 'restart a windows service', totalDeferred: 300 }),
    assistantToolCall({ messageId: 'msg_h2', toolUseId: 'toolu_hit_call', name: 'manage_services', input: { action: 'restart' } }),
    userToolResult({ toolUseId: 'toolu_hit_call' }),
    resultMessage,
  ],
  hitNoTotals: [
    capturedAssistantToolSearch({ messageId: 'msg_n1', toolUseId: 'toolu_nt', query: 'restart a windows service' }),
    capturedUserSearchResult({ toolUseId: 'toolu_nt', toolNames: ['manage_services'], query: 'restart a windows service', totalDeferred: null }),
    resultMessage,
  ],
  empty: [
    capturedAssistantToolSearch({ messageId: 'msg_e1', toolUseId: 'toolu_empty', query: 'zz placeholder nonsense' }),
    capturedUserSearchResult({ toolUseId: 'toolu_empty', toolNames: [], query: 'zz placeholder nonsense', totalDeferred: 300 }),
    resultMessage,
  ],
  select: [
    capturedAssistantToolSearch({ messageId: 'msg_s1', toolUseId: 'toolu_sel', query: 'select:manage_services', maxResults: 5 }),
    capturedUserSearchResult({ toolUseId: 'toolu_sel', toolNames: ['manage_services'], query: 'select:manage_services', totalDeferred: 300 }),
    resultMessage,
  ],
  invalidInputDrop: [
    assistantToolCall({ messageId: 'msg_d1', toolUseId: 'toolu_drop', name: 'manage_alerts', input: {} }),
    capturedUserInputValidationError({ toolUseId: 'toolu_drop', toolName: 'manage_alerts' }),
    resultMessage,
  ],
  resumed: [
    // Synthesised: an earlier process's search result, replayed with an unknown tool_use_id.
    userReplayedSearchResult({ toolUseId: 'toolu_old', toolNames: ['manage_services'] }),
    assistantToolCall({ messageId: 'msg_r1', toolUseId: 'toolu_res_call', name: 'manage_services', input: { action: 'list' } }),
    userToolResult({ toolUseId: 'toolu_res_call' }),
    resultMessage,
  ],
};
