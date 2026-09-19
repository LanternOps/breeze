import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { closeDb } from '../../../db';
import { runSurfaceCapture } from '../toolCapture/runSurface';
import { runCli } from './tool-eval';

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../db', () => ({ closeDb: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'prompt' }));
vi.mock('../../aiModel', () => ({ resolveDefaultModel: () => 'default-model' }));
vi.mock('../../streamingSessionManager', () => ({
  buildClaudeSdkChildEnv: () => ({ ANTHROPIC_API_KEY: 'test-key', ENABLE_TOOL_SEARCH: 'inherited' }),
}));
vi.mock('../llmConfigResolver', () => ({ resolveLlmConfig: async () => ({ source: 'env' }) }));
vi.mock('../toolCapture/runSurface', () => ({ runSurfaceCapture: vi.fn() }));
vi.mock('../toolCapture/surfaces', () => ({
  CAPTURE_SURFACES: {
    chat: { id: 'chat', allowedTools: ['mcp__breeze__query_devices'] },
    'helper-standard': { id: 'helper-standard', allowedTools: ['mcp__breeze__query_devices'] },
  },
}));

const capture = () => ({
  surface: 'chat' as const, registeredToolCount: 1, allowedToolCount: 1,
  observation: {
    toolUses: [{ name: 'mcp__breeze__query_devices', input: {} }],
    apiCalls: [
      { inputTokens: 100, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 5 },
      { inputTokens: 999, cacheCreationInputTokens: 999, cacheReadInputTokens: 999, outputTokens: 5 },
    ],
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
    env: { ANTHROPIC_API_KEY: 'test-key', ENABLE_TOOL_SEARCH: 'false' },
  }));
  const report = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
  expect(report).toMatchObject({ summary: { total: 1, hits: 1 }, meanFirstCallInputTokens: 100,
    cases: [{ inputTokens: 100, cacheReadInputTokens: 30, cacheCreationInputTokens: 20,
      ttftMs: 12, toolSearchUsed: true }] });
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

it('recovers on retry and leaves default tool search unset', async () => {
  vi.mocked(runSurfaceCapture).mockRejectedValueOnce(new Error('temporary'));
  expect(await runCli(['--cases', 'g01'])).toBe(0);
  expect(runSurfaceCapture).toHaveBeenCalledTimes(2);
  expect(vi.mocked(runSurfaceCapture).mock.calls[1]![0].env).not.toHaveProperty('ENABLE_TOOL_SEARCH');
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
    surface: expect.objectContaining({ id: 'helper-standard' }), env: { ENABLE_TOOL_SEARCH: 'true' },
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
