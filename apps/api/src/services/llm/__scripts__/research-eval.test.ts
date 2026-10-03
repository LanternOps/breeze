import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { closeDb } from '../../../db';
import { runResearchEvalCase } from '../researchEval/runCase';
import { isLoopbackDatabaseUrl, runCli } from './research-eval';

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../db', () => ({ closeDb: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../researchEval/runCase', () => ({ runResearchEvalCase: vi.fn() }));

const completed = (depth: 'quick' | 'deep') => ({
  caseId: 'w-svc-1', depth, status: 'completed', errorCode: null, costCents: 3, turns: 3, model: 'test-model',
  outcome: { summary: 's', items: [{ kind: 'builtin_action', action: 'restart_service', params: { serviceName: 'Spooler' } }], rejected: [], noSafeFix: false },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  vi.stubEnv('RESEARCH_EVAL_ALLOW_WRITES', '1');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/breeze_test');
  vi.stubEnv('RESEARCH_EVAL_ALLOW_REMOTE_DB', '');
  vi.mocked(runResearchEvalCase).mockImplementation((async (_c: unknown, depth: 'quick' | 'deep') => completed(depth)) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('rejects invalid usage with exit 2 before running anything', async () => {
  expect(await runCli(['--depth', 'shallow'])).toBe(2);
  expect(await runCli(['--cases', 'nope'])).toBe(2);
  expect(await runCli(['--concurrency', '0'])).toBe(2);
  expect(runResearchEvalCase).not.toHaveBeenCalled();
});

it('fails fast with a clear message when no API key is configured', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('AI_TOOL_EVAL_KEY', '');
  expect(await runCli([])).toBe(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ANTHROPIC_API_KEY'));
  expect(runResearchEvalCase).not.toHaveBeenCalled();
});

it('refuses to write fixtures without RESEARCH_EVAL_ALLOW_WRITES=1, before touching the DB', async () => {
  vi.stubEnv('RESEARCH_EVAL_ALLOW_WRITES', '');
  expect(await runCli(['--cases', 'w-svc-1'])).toBe(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('refusing to write eval fixtures'));
  expect(runResearchEvalCase).not.toHaveBeenCalled();
});

it('refuses in production', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  expect(await runCli([])).toBe(2);
  expect(runResearchEvalCase).not.toHaveBeenCalled();
});

it('runs the selected case at the selected depth and writes a JSON report and a markdown summary', async () => {
  expect(await runCli(['--cases', 'w-svc-1', '--depth', 'quick', '--out', 'r.json', '--summary-md', 'r.md'])).toBe(0);
  expect(runResearchEvalCase).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runResearchEvalCase).mock.calls[0]![1]).toBe('quick');
  const report = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
  expect(report).toMatchObject({
    models: ['test-model'],
    scores: [{ caseId: 'w-svc-1', depth: 'quick', costCents: 3, validity: 1, expectationHit: true, forbiddenHit: false }],
    summaries: [{ depth: 'quick', runs: 1, costP90: 3, recommendedCapCents: 4 }],
  });
  expect(writeFile).toHaveBeenNthCalledWith(2, 'r.md', expect.stringContaining('## quick'));
  expect(closeDb).toHaveBeenCalledOnce();
});

it('records a thrown case as a harness error and still exits 0', async () => {
  vi.mocked(runResearchEvalCase).mockRejectedValue(new Error('boom'));
  expect(await runCli(['--cases', 'w-svc-1', '--depth', 'deep'])).toBe(0);
  const report = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]![1]));
  expect(report.scores[0]).toMatchObject({ failed: true });
  expect(report.cases[0]).toMatchObject({ status: 'harness_error', denial: 'boom' });
});

it('refuses a non-loopback DATABASE_URL unless explicitly overridden', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://u:p@db.internal-host:5432/breeze');
  expect(await runCli(['--cases', 'w-svc-1'])).toBe(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not a loopback host'));
  expect(runResearchEvalCase).not.toHaveBeenCalled();
  vi.stubEnv('RESEARCH_EVAL_ALLOW_REMOTE_DB', '1');
  expect(await runCli(['--cases', 'w-svc-1', '--depth', 'quick'])).toBe(0);
  expect(runResearchEvalCase).toHaveBeenCalledTimes(1);
});

it('classifies loopback hosts', () => {
  for (const u of ['postgresql://a@localhost:1/x', 'postgresql://a@127.0.0.1:1/x', 'postgresql://a@[::1]:1/x']) expect(isLoopbackDatabaseUrl(u), u).toBe(true);
  for (const u of ['postgresql://a@10.0.0.5:1/x', 'postgresql://a@localhost.evil-host:1/x', 'nonsense', undefined]) expect(isLoopbackDatabaseUrl(u), String(u)).toBe(false);
});

it('an unexpected non-usage exception exits 1', async () => {
  vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));
  expect(await runCli(['--cases', 'w-svc-1', '--depth', 'quick'])).toBe(1);
});
