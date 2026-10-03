import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { closeDb } from '../../../db';
import { runSurfaceCapture } from '../toolCapture/runSurface';
import { runCli } from './tool-eval';

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../db', () => ({ closeDb: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'prompt' }));
vi.mock('../../aiModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../aiModel')>()),
  resolveDefaultModel: () => 'default-model',
}));
vi.mock('../../streamingSessionManager', () => ({
  buildClaudeSdkChildEnv: () => ({ ANTHROPIC_API_KEY: 'test-key', ENABLE_TOOL_SEARCH: 'inherited' }),
}));
vi.mock('../llmConfigResolver', () => ({ platformLlmConfig: () => ({ source: 'platform', apiKey: 'test-key', model: 'default-model' }) }));
// 1 cent per 1k context-equivalent tokens: input×1, cache write×1.25, cache read×0.1, output×5.
// Priced from the registry row (W03 Task 17), rates in cents per MTok.
vi.mock('../../aiModels/platformModels', () => ({
  getPlatformModelByModelId: async () => ({
    rates: { inputCentsPerM: 1000, outputCentsPerM: 5000, cacheReadCentsPerM: 100, cacheWriteCentsPerM: 1250 },
    optionRates: null,
  }),
}));
vi.mock('../toolCapture/runSurface', () => ({
  runSurfaceCapture: vi.fn(),
  getCaptureSystemPrompt: () => 'complete prompt — index and tail',
  captureToolSearchPolicy: (surface: { toolSearch: boolean }, _env: unknown, override: string, surfaceSearch?: boolean) =>
    ({ enabled: (surfaceSearch ?? surface.toolSearch) && override !== 'off' }),
}));
vi.mock('../toolCapture/surfaces', () => ({
  CAPTURE_SURFACES: {
    chat: { id: 'chat', allowedTools: ['mcp__breeze__query_devices'], toolSearch: true },
    'helper-standard': { id: 'helper-standard', allowedTools: ['mcp__breeze__query_devices'], toolSearch: false },
    'agent-full-remediation': {
      id: 'agent-full-remediation', allowedTools: ['mcp__breeze__query_devices', 'mcp__breeze__analyze_disk_usage'],
      toolSearch: false, agentProfile: 'full',
    },
    'agent-analysis': { id: 'agent-analysis', allowedTools: ['mcp__breeze__export_dataset'], toolSearch: false, agentProfile: 'analysis' },
  },
}));
vi.mock('../toolEval/agentGoldenTasks', () => ({
  AGENT_GOLDEN_TASKS: [
    { id: 'a01', title: 'disk', surface: 'agent-full-remediation', context: { profile: 'full', tag: 'a01' }, expect: [{ tool: 'analyze_disk_usage' }] },
    { id: 'b01', title: 'cpu', surface: 'agent-analysis', context: { profile: 'analysis', tag: 'b01' }, expect: [{ tool: 'export_dataset' }] },
  ],
}));
vi.mock('../../aiModels/promptVariants', async (orig) => ({
  ...(await orig<typeof import('../../aiModels/promptVariants')>()),
  PROMPT_VARIANTS: [
    { id: 'chat/claude-small@1', surface: 'chat', profile: 'claude-small', version: 1, state: 'staged', canaryPercent: 0, guidance: 'Small guidance.', hypothesis: 'h' },
    { id: 'ai_agents/claude-small@1', surface: 'ai_agents', profile: 'claude-small', version: 1, state: 'staged', canaryPercent: 0, guidance: 'Agent guidance.', hypothesis: 'h' },
  ],
}));
vi.mock('../../aiAgents/runnerPrompt', () => ({
  buildAgentRunSystemPrompt: (ctx: { tag: string }) => `system:${ctx.tag}`,
  buildAgentRunTaskPrompt: (ctx: { tag: string }) => `task:${ctx.tag}`,
}));

const capture = () => ({
  surface: 'chat' as const, registeredToolCount: 1, registeredToolNames: [], allowedToolCount: 1, tenantToolNames: [],
  observation: {
    toolUses: [{ name: 'mcp__breeze__query_devices', input: {} }],
    apiCalls: [
      { inputTokens: 100, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 5 },
      { inputTokens: 999, cacheCreationInputTokens: 999, cacheReadInputTokens: 999, outputTokens: 5 },
    ],
    firstToolApiCallIndex: 1,
    ttftMs: 12, toolSearchUses: 0, toolSearchResultBlocks: 0,
    toolReferenceNames: ['query_devices'], stderrToolSearchLines: [], sessionId: null, result: null,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  vi.mocked(runSurfaceCapture).mockReset().mockResolvedValue(capture());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('writes JSON and markdown using only first-call usage, and closes the DB', async () => {
  expect(await runCli(['--', '--cases', 'g01', '--model', 'chosen', '--tool-search', 'off',
    '--out', 'result.json', '--summary-md', 'result.md'])).toBe(0);
  expect(runSurfaceCapture).toHaveBeenCalledWith(expect.objectContaining({
    surface: expect.objectContaining({ id: 'chat' }), model: 'chosen', maxTurns: 1,
    // The policy (runSurface) owns ENABLE_TOOL_SEARCH; the inherited value is dropped.
    env: { ANTHROPIC_API_KEY: 'test-key' }, toolSearchOverride: 'off',
  }));
  const report = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
  expect(report).toMatchObject({ systemPromptBytes: Buffer.byteLength('complete prompt — index and tail', 'utf8'),
    summary: { total: 1, hits: 1 }, meanFirstCallInputTokens: 100, toolSearchEnabled: false,
    // Through the response that made the first real call: (100+20+30) + 3×999.
    meanContextTokensToFirstTool: 3147,
    cases: [{ inputTokens: 100, cacheReadInputTokens: 30, cacheCreationInputTokens: 20,
      ttftMs: 12, toolSearchUsed: true, apiCallsToFirstTool: 2, contextTokensToFirstTool: 3147 }] });
  expect(writeFile).toHaveBeenNthCalledWith(2, 'result.md', expect.stringContaining('accuracy 1/1'));
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('accuracy 1/1'));
  expect(closeDb).toHaveBeenCalledOnce();
});

it('retries once, records permanent SDK errors, and keeps the report non-gating', async () => {
  vi.mocked(runSurfaceCapture).mockRejectedValue(new Error('SDK unavailable'));
  expect(await runCli(['--cases', 'g01'])).toBe(0);
  expect(runSurfaceCapture).toHaveBeenCalledTimes(2);
  const report = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
  expect(report.cases[0]).toMatchObject({ observedTool: null, error: 'SDK unavailable', hit: false });
});

it('recovers on retry and, with default tool search on a searching surface, leaves room for the search turn', async () => {
  vi.mocked(runSurfaceCapture).mockRejectedValueOnce(new Error('temporary'));
  expect(await runCli(['--cases', 'g01'])).toBe(0);
  expect(runSurfaceCapture).toHaveBeenCalledTimes(2);
  const call = vi.mocked(runSurfaceCapture).mock.calls[1]![0];
  expect(call.env).not.toHaveProperty('ENABLE_TOOL_SEARCH');
  expect(call.toolSearchOverride).toBe('auto');
  expect(call.maxTurns).toBe(3);
});

it('bounds concurrency and preserves golden case order', async () => {
  let active = 0;
  let peak = 0;
  vi.mocked(runSurfaceCapture).mockImplementation(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return capture();
  });
  expect(await runCli(['--cases', 'g01,g02,g03,g04', '--concurrency', '2',
    '--surface', 'helper-standard', '--tool-search', 'on'])).toBe(0);
  expect(peak).toBe(2);
  const report = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
  expect(report.cases.map((c: { id: string }) => c.id)).toEqual(['g01', 'g02', 'g03', 'g04']);
  expect(vi.mocked(runSurfaceCapture).mock.calls[0]![0]).toMatchObject({
    surface: expect.objectContaining({ id: 'helper-standard' }), toolSearchOverride: 'on', maxTurns: 1,
  });
});

it.each([
  ['--surface', 'unknown'], ['--cases', 'g99'], ['--cases', 'g01,'],
  ['--concurrency', '0'], ['--concurrency', '1.5'], ['--model'],
  ['--unknown', 'x'], ['--tool-search', 'auto'],
])('rejects invalid arguments %j with exit 2', async (...args) => {
  expect(await runCli(args)).toBe(2);
  expect(runSurfaceCapture).not.toHaveBeenCalled();
  expect(closeDb).toHaveBeenCalledOnce();
});

it('rejects a missing API key without invoking capture', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  expect(await runCli([])).toBe(2);
  expect(runSurfaceCapture).not.toHaveBeenCalled();
});

describe('--suite agent (#7428)', () => {
  const agentCapture = (tool: string) => ({
    ...capture(),
    observation: {
      ...capture().observation,
      toolUses: [{ name: `mcp__breeze__${tool}`, input: {} }],
      apiCalls: [
        { inputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 100 },
        { inputTokens: 10, cacheCreationInputTokens: 2000, cacheReadInputTokens: 1000, outputTokens: 20 },
        { inputTokens: 9, cacheCreationInputTokens: 9, cacheReadInputTokens: 9, outputTokens: 9 },
      ],
      firstToolApiCallIndex: 1,
    },
  });

  it('runs each task on its own agent surface with the production prompts of its run context', async () => {
    vi.mocked(runSurfaceCapture).mockImplementation(async (opts) =>
      agentCapture(opts.surface.id === 'agent-analysis' ? 'export_dataset' : 'query_devices'));
    expect(await runCli(['--suite', 'agent', '--tool-search', 'off'])).toBe(0);
    const calls = vi.mocked(runSurfaceCapture).mock.calls.map(([opts]) => opts);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      surface: expect.objectContaining({ id: 'agent-full-remediation' }),
      systemPrompt: 'system:a01', prompt: 'task:a01', maxTurns: 1,
    });
    expect(calls[0]).not.toHaveProperty('surfaceSearch');
    expect(calls[1]).toMatchObject({ surface: expect.objectContaining({ id: 'agent-analysis' }), systemPrompt: 'system:b01', prompt: 'task:b01' });
    const report = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
    expect(report).toMatchObject({ suite: 'agent', surfaceSearch: 'production', summary: { total: 2, hits: 1 } });
    expect(report.cases[0]).toMatchObject({ id: 'a01', surface: 'agent-full-remediation', hit: false, observedTool: 'query_devices' });
    expect(report.cases[1]).toMatchObject({ id: 'b01', surface: 'agent-analysis', hit: true });
  });

  it('--surface-search on measures a hypothetical opt-in, leaves room for the search turn, and prices the path to the first real tool', async () => {
    vi.mocked(runSurfaceCapture).mockResolvedValue(agentCapture('analyze_disk_usage'));
    expect(await runCli(['--suite', 'agent', '--cases', 'a01', '--surface-search', 'on'])).toBe(0);
    expect(vi.mocked(runSurfaceCapture).mock.calls[0]![0]).toMatchObject({ surfaceSearch: true, maxTurns: 3, toolSearchOverride: 'auto' });
    const report = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
    // Response 1 (1000 in, 100 out) + response 2 (10 in, 2000 write, 1000 read, 20 out); response 3 is after the first tool.
    expect(report.cases[0]).toMatchObject({
      hit: true, toolSearchEnabled: true, apiCallsToFirstTool: 2,
      contextTokensToFirstTool: 1000 + 10 + 2000 + 1000,
      contextTokensAtFirstTool: 10 + 2000 + 1000,
      costCentsToFirstTool: (1000 + 500) / 1000 + (10 + 100 + 100 + 2500) / 1000,
    });
    expect(report).toMatchObject({ toolSearchEnabled: true, meanApiCallsToFirstTool: 2 });
  });

  it('--surface narrows the agent suite to one agent surface', async () => {
    vi.mocked(runSurfaceCapture).mockResolvedValue(agentCapture('export_dataset'));
    expect(await runCli(['--suite', 'agent', '--surface', 'agent-analysis'])).toBe(0);
    expect(vi.mocked(runSurfaceCapture).mock.calls.map(([o]) => o.surface.id)).toEqual(['agent-analysis']);
  });

  it.each([
    [['--suite', 'agent', '--cases', 'g01']], [['--suite', 'agent', '--surface', 'chat']],
    [['--suite', 'nope']], [['--surface-search', 'maybe']], [['--cases', 'a01']],
  ])('rejects %j with exit 2', async (args) => {
    expect(await runCli(args)).toBe(2);
    expect(runSurfaceCapture).not.toHaveBeenCalled();
  });
});

describe('--prompt-variant (W11)', () => {
  it('appends the variant to the surface prompt and records it in the report', async () => {
    expect(await runCli(['--cases', 'g01', '--model', 'claude-haiku-4-5', '--prompt-variant', 'chat/claude-small@1'])).toBe(0);
    expect(runSurfaceCapture).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: 'complete prompt — index and tail\n\n## Model Guidance\nSmall guidance.',
    }));
    const report = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
    expect(report.promptVariant).toBe('chat/claude-small@1');
    expect(report.systemPromptBytes).toBe(Buffer.byteLength('complete prompt — index and tail\n\n## Model Guidance\nSmall guidance.', 'utf8'));
    expect(vi.mocked(writeFile).mock.calls[1]![1]).toEqual(expect.stringContaining('prompt: chat/claude-small@1'));
  });
  it('agent suite: appends to each task\'s own production prompt', async () => {
    expect(await runCli(['--suite', 'agent', '--model', 'claude-haiku-4-5', '--prompt-variant', 'ai_agents/claude-small@1'])).toBe(0);
    expect(vi.mocked(runSurfaceCapture).mock.calls.map((c) => c[0].systemPrompt))
      .toEqual(['system:a01\n\n## Model Guidance\nAgent guidance.', 'system:b01\n\n## Model Guidance\nAgent guidance.']);
  });
  it('without the flag the report says base and the prompt is untouched', async () => {
    expect(await runCli(['--cases', 'g01'])).toBe(0);
    expect(vi.mocked(runSurfaceCapture).mock.calls[0]![0].systemPrompt).toBeUndefined();
    expect(JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1])).promptVariant).toBeNull();
  });
  it.each([
    ['an unknown id', ['--prompt-variant', 'chat/claude-small@9', '--model', 'claude-haiku-4-5']],
    ['a model of another profile', ['--prompt-variant', 'chat/claude-small@1', '--model', 'claude-sonnet-5-5']],
    ['a variant of another surface', ['--suite', 'agent', '--prompt-variant', 'chat/claude-small@1', '--model', 'claude-haiku-4-5']],
  ])('exits 2 on %s', async (_n, args) => {
    expect(await runCli(args)).toBe(2);
    expect(runSurfaceCapture).not.toHaveBeenCalled();
  });
});
