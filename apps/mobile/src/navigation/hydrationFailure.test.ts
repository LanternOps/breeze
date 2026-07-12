import { describe, expect, it, vi } from 'vitest';
import { advanceSessionGeneration, captureSessionGeneration } from '../services/sessionGeneration';
import { handleHydrationFailure } from './hydrationFailure';

describe('handleHydrationFailure', () => {
  it('does not wipe or log out account B for a rejected account A startup', async () => {
    const accountA = captureSessionGeneration();
    const clear = vi.fn().mockResolvedValue(undefined);
    const logout = vi.fn();

    advanceSessionGeneration();

    await expect(handleHydrationFailure(accountA, clear, logout)).resolves.toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('does not log out a newer session that arrives while the old wipe is pending', async () => {
    const accountA = captureSessionGeneration();
    let releaseClear!: () => void;
    const clear = vi.fn(() => new Promise<void>((resolve) => { releaseClear = resolve; }));
    const logout = vi.fn();
    const handling = handleHydrationFailure(accountA, clear, logout);
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());

    advanceSessionGeneration();
    releaseClear();

    await expect(handling).resolves.toBe(false);
    expect(logout).not.toHaveBeenCalled();
  });
});
