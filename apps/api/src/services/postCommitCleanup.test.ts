import { describe, expect, it, vi } from 'vitest';
import { runPostCommitCleanup } from './postCommitCleanup';

describe('runPostCommitCleanup', () => {
  it('attempts every operation and reports failures without short-circuiting', async () => {
    const later = vi.fn(async () => 'ok');
    const result = await runPostCommitCleanup([
      { name: 'permission-cache', run: async () => { throw new Error('cache down'); } },
      { name: 'oauth', run: later },
    ]);

    expect(later).toHaveBeenCalledTimes(1);
    expect(result.failures).toEqual([
      expect.objectContaining({ name: 'permission-cache', error: expect.any(Error) }),
    ]);
    expect(result.cleanupStatus).toBe('partial');
    expect(result.cleanupFailures).toEqual(['permission-cache']);
  });

  it('reports complete when every operation succeeds', async () => {
    const result = await runPostCommitCleanup([
      { name: 'sessions', run: async () => undefined },
    ]);

    expect(result).toMatchObject({
      cleanupStatus: 'complete',
      cleanupFailures: [],
      failures: [],
    });
  });
});
