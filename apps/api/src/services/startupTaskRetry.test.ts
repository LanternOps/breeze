import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runStartupTaskWithRetry } from './startupTaskRetry';

describe('index.ts startup wiring (#7693)', () => {
  const text = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it.each([
    'ensureBuiltInMonitorsForAllPartners',
    'sealUnsealedSettingsSecrets',
    'baselineCredentialHistory',
  ])('%s is retried, detached and started after serve()', (fn) => {
    const serveAt = text.indexOf('server = serve(');
    const callAt = text.search(new RegExp(`void runStartupTaskWithRetry\\([^\\n]*\\(\\) => ${fn}\\(\\)`));
    expect(callAt).toBeGreaterThan(serveAt);
    expect(text).not.toMatch(new RegExp(`void ${fn}\\(`));
    expect(text).not.toMatch(new RegExp(`await ${fn}\\(`));
  });
});

const noSleep = () => Promise.resolve();

describe('runStartupTaskWithRetry', () => {
  it('retries a thrown failure and returns the first success', async () => {
    const task = vi.fn<() => Promise<{ failed: number }>>()
      .mockRejectedValueOnce(new Error('DbAccessContextPrologueTimeoutError'))
      .mockResolvedValueOnce({ failed: 0 });
    const onFailure = vi.fn();
    const result = await runStartupTaskWithRetry('t', task, {
      delaysMs: [1, 2], sleep: noSleep, onFailure, hasFailures: (r) => r.failed > 0,
    });
    expect(result).toEqual({ failed: 0 });
    expect(task).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('retries a partial failure (failed > 0) and uses the backoff delays in order', async () => {
    const task = vi.fn<() => Promise<{ failed: number }>>()
      .mockResolvedValueOnce({ failed: 2 })
      .mockResolvedValueOnce({ failed: 1 })
      .mockResolvedValueOnce({ failed: 0 });
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    await runStartupTaskWithRetry('t', task, { delaysMs: [10, 20], sleep, hasFailures: (r) => r.failed > 0 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('gives up after the schedule: returns last partial result, rethrows last error', async () => {
    const partial = vi.fn<() => Promise<{ failed: number }>>().mockResolvedValue({ failed: 1 });
    await expect(
      runStartupTaskWithRetry('t', partial, { delaysMs: [1], sleep: noSleep, hasFailures: (r) => r.failed > 0 }),
    ).resolves.toEqual({ failed: 1 });
    expect(partial).toHaveBeenCalledTimes(2);

    const boom = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(runStartupTaskWithRetry('t', boom, { delaysMs: [1], sleep: noSleep })).rejects.toThrow('boom');
    expect(boom).toHaveBeenCalledTimes(2);
  });
});
