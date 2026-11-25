import { describe, expect, it } from 'vitest';
import { scoreFirstCall, scoreSchemaValidity, summarize } from './score';
import { renderMarkdownReport } from './report';
import { toolInputSchemas } from '../../aiToolSchemas';

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
    const s = summarize([{ id: 'a', hit: true, observedTool: 'x', observedAction: null, answeredWithoutTool: false, unavailableTool: false }, { id: 'b', hit: false, observedTool: null, observedAction: null, answeredWithoutTool: true, unavailableTool: false }]);
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
  expect(summarize([])).toEqual({ total: 0, hits: 0, accuracy: 0, misses: [], schemaValidRate: null, schemaCheckedCalls: 0, schemaValidCalls: 0 });
});

describe('scoreFirstCall with allowedTools', () => {
  const allowed = new Set(['mcp__breeze__manage_alerts', 'mcp__breeze__query_monitors']);

  it('marks a hit against a tool the surface never exposed as unavailableTool, not a hit', () => {
    const notAllowed = { ...c, expect: [{ tool: 'manage_alerts', action: 'list' }] };
    const score = scoreFirstCall(notAllowed, { toolUses: [{ name: 'mcp__breeze__manage_tickets', input: {} }] }, allowed);
    expect(score).toMatchObject({ hit: false, observedTool: 'manage_tickets', unavailableTool: true });
  });

  it('keeps a real hit when the tool IS allowed', () => {
    const score = scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__manage_alerts', input: { action: 'list' } }] }, allowed);
    expect(score).toMatchObject({ hit: true, unavailableTool: false });
  });

  it('leaves existing calls without the param unchanged (unavailableTool false)', () => {
    const score = scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__manage_alerts', input: { action: 'list' } }] });
    expect(score).toMatchObject({ hit: true, unavailableTool: false });
  });
});

it('renders accuracy, missed prompts, expectations, observed actions and tokens', () => {
  const score = scoreFirstCall({ ...c, id: 'g04' }, {
    toolUses: [{ name: 'mcp__breeze__manage_alerts', input: { action: 'resolve' } }],
  });
  const markdown = renderMarkdownReport({
    generatedAt: '2026-09-19T00:00:00Z', model: 'test-model', suite: 'chat', toolSearch: 'off', surfaceSearch: 'production',
    surface: 'chat', meanContextTokensAtFirstTool: 0, meanApiCallsToFirstTool: 1, meanCostCentsToFirstTool: 0, systemPromptBytes: 123, promptVariant: null, meanFirstCallInputTokens: 456,
    toolSearchEnabled: false, meanContextTokensToFirstTool: 789,
    cases: [{ ...score, expected: c.expect, inputTokens: 456, cacheReadInputTokens: 10,
      cacheCreationInputTokens: 20, ttftMs: null, toolSearchUsed: false,
      apiCallsToFirstTool: 1, contextTokensToFirstTool: 486, contextTokensAtFirstTool: 486, costCentsToFirstTool: 0,
      surface: 'chat', toolSearchEnabled: false }],
    summary: summarize([score]),
  });
  expect(markdown).toContain('accuracy 0/1 = 0.0%');
  expect(markdown).toContain('id | prompt | expected | observed');
  expect(markdown).toContain('How many critical alerts are open across all customers?');
  expect(markdown).toContain('manage_alerts.list');
  expect(markdown).toContain('manage_alerts.resolve');
  expect(markdown).toContain('456');
  expect(markdown).toContain('through the first real tool call: 789');
  expect(markdown).toContain('(disabled by policy)');
});

it('renders the observed cell as "<tool> (not exposed)" when unavailableTool is set', () => {
  const allowed = new Set(['mcp__breeze__manage_alerts']);
  const score = scoreFirstCall({ ...c, id: 'g05' }, { toolUses: [{ name: 'mcp__breeze__manage_tickets', input: {} }] }, allowed);
  const markdown = renderMarkdownReport({
    generatedAt: '2026-09-19T00:00:00Z', model: 'test-model', suite: 'chat', toolSearch: 'off', surfaceSearch: 'production',
    surface: 'chat', meanContextTokensAtFirstTool: 0, meanApiCallsToFirstTool: 1, meanCostCentsToFirstTool: 0, systemPromptBytes: 123, promptVariant: null, meanFirstCallInputTokens: 456,
    toolSearchEnabled: false, meanContextTokensToFirstTool: 789,
    cases: [{ ...score, expected: c.expect, inputTokens: 456, cacheReadInputTokens: 10,
      cacheCreationInputTokens: 20, ttftMs: null, toolSearchUsed: false,
      apiCallsToFirstTool: 1, contextTokensToFirstTool: 486, contextTokensAtFirstTool: 486, costCentsToFirstTool: 0,
      surface: 'chat', toolSearchEnabled: false }],
    summary: summarize([score]),
  });
  expect(markdown).toContain('manage_tickets (not exposed)');
});

describe('scoreSchemaValidity', () => {
  const valid = { name: 'mcp__breeze__query_devices', input: {} };
  const malformed = { name: 'mcp__breeze__manage_services', input: { deviceId: '00000000-0000-4000-8000-000000000001' } };

  it('two valid calls: schemaValid true, nothing invalid', () => {
    const r = scoreSchemaValidity({ toolUses: [valid, valid] });
    expect(r).toMatchObject({ schemaValid: true, schemaCheckedCalls: 2, schemaValidCalls: 2, schemaInvalidCalls: [] });
  });

  it('a later malformed call fails with that one entry; the control without it is valid', () => {
    const bad = scoreSchemaValidity({ toolUses: [valid, malformed] });
    expect(bad.schemaValid).toBe(false);
    expect(bad.schemaInvalidCalls).toHaveLength(1);
    expect(bad.schemaInvalidCalls[0]!.name).toBe('manage_services');
    expect(bad.schemaCheckedCalls).toBe(2);
    expect(bad.schemaValidCalls).toBe(1);
    expect(scoreSchemaValidity({ toolUses: [valid] }).schemaValid).toBe(true);
  });

  it('ignores ToolSearch uses', () => {
    const r = scoreSchemaValidity({ toolUses: [{ name: 'ToolSearch', input: { query: 'x' } }, valid] });
    expect(r.schemaCheckedCalls).toBe(1);
  });

  it('two valid plus one invalid: checked 3, valid 2', () => {
    const r = scoreSchemaValidity({ toolUses: [valid, malformed, valid] });
    expect(r).toMatchObject({ schemaCheckedCalls: 3, schemaValidCalls: 2 });
  });

  it('a call with no tool calls is vacuously valid with zero checked', () => {
    expect(scoreSchemaValidity({ toolUses: [] })).toMatchObject({ schemaValid: true, schemaCheckedCalls: 0 });
  });

  it('a tool with no registered input schema (tenant/BYO) is not counted, not invalid', () => {
    const r = scoreSchemaValidity({ toolUses: [{ name: 'mcp__breeze__hudu__get_asset', input: { id: 1 } }, valid] });
    expect(r).toMatchObject({ schemaValid: true, schemaCheckedCalls: 1, schemaValidCalls: 1, schemaInvalidCalls: [] });
  });

  it('every registry tool has an input schema (drift pin for the skip above)', async () => {
    const { aiTools } = await import('../../aiTools');
    const missing = [...aiTools.keys()].filter((n) => !Object.hasOwn(toolInputSchemas, n));
    expect(missing).toEqual([]);
  });

  it('uses the injected validator and strips the surface prefix', () => {
    const seen: string[] = [];
    scoreSchemaValidity({ toolUses: [{ name: 'mcp__script_builder__foo', input: {} }] },
      (n) => { seen.push(n); return { success: true }; });
    expect(seen).toEqual(['foo']);
  });
});

describe('summarize schemaValidRate', () => {
  const base = { observedTool: null, observedAction: null, answeredWithoutTool: false, unavailableTool: false };
  it('is Σvalid/Σchecked over cases (2/3 and 1/1 → 3/4)', () => {
    const s = summarize([
      { id: 'a', hit: true, ...base, schemaValid: false, schemaCheckedCalls: 3, schemaValidCalls: 2, schemaInvalidCalls: [] },
      { id: 'b', hit: true, ...base, schemaValid: true, schemaCheckedCalls: 1, schemaValidCalls: 1, schemaInvalidCalls: [] },
    ]);
    expect(s.schemaValidRate).toBe(0.75);
  });
  it('is null when no case checked a call', () => {
    expect(summarize([{ id: 'a', hit: true, ...base }]).schemaValidRate).toBeNull();
    expect(summarize([]).schemaValidRate).toBeNull();
  });
});

describe('renderMarkdownReport schema validity', () => {
  it('renders the schema-valid rate', () => {
    const summary = summarize([{ id: 'a', hit: true, observedTool: 'x', observedAction: null, answeredWithoutTool: false, unavailableTool: false,
      schemaValid: true, schemaCheckedCalls: 4, schemaValidCalls: 3, schemaInvalidCalls: [] }]);
    const md = renderMarkdownReport({ generatedAt: 't', model: 'm', suite: 'chat', toolSearch: 'on', surfaceSearch: 'production',
      toolSearchEnabled: true, surface: 'chat', systemPromptBytes: 1, promptVariant: null, cases: [], summary,
      meanFirstCallInputTokens: 0, meanContextTokensToFirstTool: 0, meanContextTokensAtFirstTool: 0, meanApiCallsToFirstTool: 0, meanCostCentsToFirstTool: 0 });
    expect(md).toContain('Schema-valid calls: 3/4 = 75.0%');
  });
});

describe('renderMarkdownReport errored cases', () => {
  it('says how many cases errored next to the schema rate', () => {
    const cases = [{ id: 'a', hit: false, observedTool: null, observedAction: null, answeredWithoutTool: true, unavailableTool: false, error: 'SDK down' }] as never;
    const md = renderMarkdownReport({ generatedAt: 't', model: 'm', suite: 'chat', toolSearch: 'on', surfaceSearch: 'production',
      toolSearchEnabled: true, surface: 'chat', systemPromptBytes: 1, promptVariant: null, cases, summary: summarize([]),
      meanFirstCallInputTokens: 0, meanContextTokensToFirstTool: 0, meanContextTokensAtFirstTool: 0, meanApiCallsToFirstTool: 0, meanCostCentsToFirstTool: 0 });
    expect(md).toContain('Schema-valid calls: n/a');
    expect(md).toContain('1 of 1 case(s) errored');
  });
});
