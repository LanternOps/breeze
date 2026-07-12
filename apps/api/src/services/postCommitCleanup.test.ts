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
  });
});
