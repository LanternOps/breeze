import { describe, expect, it, vi } from 'vitest';

import {
  advanceSessionGeneration,
  commitIfCurrent,
  currentSessionGeneration,
} from './sessionGeneration';

describe('native session generation fencing', () => {
  it('advances monotonically so logout invalidates captured issuer work', () => {
    const before = currentSessionGeneration();

    expect(advanceSessionGeneration()).toBe(before + 1);
    expect(currentSessionGeneration()).toBe(before + 1);
  });

  it('commits a write captured in the current generation', async () => {
    const write = vi.fn(async () => 'stored');

    await expect(commitIfCurrent(currentSessionGeneration(), write)).resolves.toBe('stored');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued write after logout advances the generation', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const generation = currentSessionGeneration();
    const firstCommit = commitIfCurrent(generation, () => first);
    const staleWrite = vi.fn(async () => 'stale');
    const queuedCommit = commitIfCurrent(generation, staleWrite);

    advanceSessionGeneration();
    releaseFirst();

    await expect(firstCommit).resolves.toBeUndefined();
    await expect(queuedCommit).resolves.toBeUndefined();
    expect(staleWrite).not.toHaveBeenCalled();
  });
});
