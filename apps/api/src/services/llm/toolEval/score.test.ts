import { describe, expect, it } from 'vitest';
import { scoreFirstCall, summarize } from './score';
import { renderMarkdownReport } from './report';

const c = { id: 'x', prompt: 'p', expect: [{ tool: 'manage_alerts', action: 'list' }, { tool: 'query_monitors' }] };

describe('scoreFirstCall', () => {
  it('hits on the first non-ToolSearch tool_use matching any expectation (name + action)', () => {
    expect(scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__manage_alerts', input: { action: 'list' } }] }).hit).toBe(true);
    expect(scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__query_monitors', input: {} }] }).hit).toBe(true);
  });
  it('misses on the wrong action or wrong tool, and only the FIRST call counts', () => {
    expect(scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__manage_alerts', input: { action: 'resolve' } }] }).hit).toBe(false);
    expect(scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__query_devices', input: {} }, { name: 'mcp__breeze__manage_alerts', input: { action: 'list' } }] }))
      .toMatchObject({ hit: false, observedTool: 'query_devices' });
  });
  it('records an answer with no tool call as a miss', () => {
    expect(scoreFirstCall(c, { toolUses: [] })).toMatchObject({ hit: false, answeredWithoutTool: true, observedTool: null });
  });
  it('summarizes', () => {
    const s = summarize([{ id: 'a', hit: true, observedTool: 'x', observedAction: null, answeredWithoutTool: false }, { id: 'b', hit: false, observedTool: null, observedAction: null, answeredWithoutTool: true }]);
    expect(s).toMatchObject({ total: 2, hits: 1, accuracy: 0.5 });
    expect(s.misses.map((m) => m.id)).toEqual(['b']);
  });
});

it('skips ToolSearch and normalizes script-builder names', () => {
  expect(scoreFirstCall(c, { toolUses: [
    { name: 'ToolSearch', input: {} },
    { name: 'mcp__script_builder__query_monitors', input: { action: 42 } },
  ] })).toMatchObject({ hit: true, observedTool: 'query_monitors', observedAction: null });
  expect(scoreFirstCall(c, { toolUses: [{ name: 'ToolSearch', input: {} }] }))
    .toMatchObject({ hit: false, answeredWithoutTool: true });
});

it('summarizes an empty run without NaN', () => {
  expect(summarize([])).toEqual({ total: 0, hits: 0, accuracy: 0, misses: [] });
});

it('renders accuracy, missed prompts, expectations, observed actions and tokens', () => {
  const score = scoreFirstCall({ ...c, id: 'g04' }, {
    toolUses: [{ name: 'mcp__breeze__manage_alerts', input: { action: 'resolve' } }],
  });
  const markdown = renderMarkdownReport({
    generatedAt: '2026-09-19T00:00:00Z', model: 'test-model', toolSearch: 'off',
    surface: 'chat', systemPromptBytes: 123, meanFirstCallInputTokens: 456,
    cases: [{ ...score, expected: c.expect, inputTokens: 456, cacheReadInputTokens: 10,
      cacheCreationInputTokens: 20, ttftMs: null, toolSearchUsed: false }],
    summary: summarize([score]),
  });
  expect(markdown).toContain('accuracy 0/1 = 0.0%');
  expect(markdown).toContain('id | prompt | expected | observed');
  expect(markdown).toContain('How many critical alerts are open across all customers?');
  expect(markdown).toContain('manage_alerts.list');
  expect(markdown).toContain('manage_alerts.resolve');
  expect(markdown).toContain('456');
});
