// Synthesised SDK stream fixtures for the tool-discovery observer (#12421 W01).
//
// Built by hand from the shapes streamObserver.test.ts already uses: an
// assistant `tool_use` named `ToolSearch` with `input: { query, max_results }`,
// and a user `tool_result` (same `tool_use_id`) whose content holds a
// `tool_search_tool_result` with `tool_reference { tool_name }` blocks. W02
// replaces these with fixtures synthesised from a captured stream. Every
// name, query and id here is a placeholder; nothing comes from production.

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
