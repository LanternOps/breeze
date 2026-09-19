import { describe, expect, it } from 'vitest';
import { createStreamObserver } from './streamObserver';

const usage = { input_tokens: 1200, cache_creation_input_tokens: 30000, cache_read_input_tokens: 0, output_tokens: 80 };

describe('createStreamObserver', () => {
  it('folds usage per assistant message, first tool_use, and ToolSearch sightings', () => {
    const o = createStreamObserver(1_000);
    o.onMessage({ type: 'stream_event', event: { type: 'message_start' }, ttft_ms: 412, session_id: 's1' });
    o.onMessage({ type: 'assistant', session_id: 's1', message: { usage, content: [
      { type: 'tool_use', id: 't0', name: 'ToolSearch', input: { query: 'offline devices' } },
    ] } });
    o.onMessage({ type: 'user', message: { content: [
      { type: 'tool_search_tool_result', content: [{ type: 'tool_reference', tool_name: 'mcp__breeze__query_devices' }] },
    ] } });
    o.onMessage({ type: 'assistant', session_id: 's1', message: { usage: { ...usage, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0 }, content: [
      { type: 'text', text: 'Checking…' },
      { type: 'tool_use', id: 't1', name: 'mcp__breeze__query_devices', input: { status: 'offline' } },
    ] } });
    o.onStderr('[ToolSearch:optimistic] mode=tst result=enabled\nother line\n');
    o.onMessage({ type: 'result', subtype: 'success', session_id: 's1', num_turns: 2, duration_ms: 2100, total_cost_usd: 0.012 });

    const obs = o.finish();
    expect(obs.ttftMs).toBe(412);
    expect(obs.apiCalls).toHaveLength(2);
    expect(obs.apiCalls[1]!.cacheReadInputTokens).toBe(30000);
    expect(obs.toolUses).toEqual([{ name: 'mcp__breeze__query_devices', input: { status: 'offline' } }]);
    expect(obs.toolSearchUses).toBe(1);
    expect(obs.toolSearchResultBlocks).toBe(1);
    expect(obs.toolReferenceNames).toEqual(['mcp__breeze__query_devices']);
    expect(obs.stderrToolSearchLines).toEqual(['[ToolSearch:optimistic] mode=tst result=enabled']);
    expect(obs.sessionId).toBe('s1');
    expect(obs.result).toEqual({ subtype: 'success', numTurns: 2, durationMs: 2100, totalCostUsd: 0.012 });
  });

  it('derives ttft from the first content_block_delta when the SDK gives no ttft_ms', () => {
    const o = createStreamObserver(1_000);
    const realNow = Date.now; Date.now = () => 1_350;
    try { o.onMessage({ type: 'stream_event', event: { type: 'content_block_delta' } }); } finally { Date.now = realNow; }
    expect(o.finish().ttftMs).toBe(350);
  });

  it('is null-safe on a session that produced nothing', () => {
    expect(createStreamObserver().finish()).toMatchObject({ ttftMs: null, apiCalls: [], toolUses: [], result: null, sessionId: null });
  });

  it('handles a stderr line split across chunks and flushes the trailing remainder on finish()', () => {
    const o = createStreamObserver();
    o.onStderr('[Tool');
    o.onStderr('Search] a\r\n[ToolSearch] b');
    expect(o.finish().stderrToolSearchLines).toEqual(['[ToolSearch] a', '[ToolSearch] b']);
  });
});
