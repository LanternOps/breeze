import { describe, it, expect } from 'vitest';

describe('runWingetReleaseTest validation', () => {
  it('throws ValidationError for invalid packageId', async () => {
    const mod = await import('./aiPatchTestRunner');
    await expect(
      mod.runWingetReleaseTest({ packageId: '../etc/passwd', version: '1.0.0' })
    ).rejects.toBeInstanceOf(mod.ValidationError);
  });

  it('throws ValidationError for invalid version', async () => {
    const mod = await import('./aiPatchTestRunner');
    await expect(
      mod.runWingetReleaseTest({ packageId: 'Mozilla.Firefox', version: '$(rm -rf /)' })
    ).rejects.toBeInstanceOf(mod.ValidationError);
  });

  it('returns inconclusive when VM env not configured', async () => {
    const oldTarget = process.env.WIN_TEST_VM_TARGET;
    const oldKey = process.env.WIN_TEST_VM_SSH_KEY;
    delete process.env.WIN_TEST_VM_TARGET;
    delete process.env.WIN_TEST_VM_SSH_KEY;
    try {
      const { runWingetReleaseTest } = await import('./aiPatchTestRunner');
      const result = await runWingetReleaseTest({ packageId: 'Mozilla.Firefox', version: '121.0' });
      expect(result.result).toBe('inconclusive');
      expect(result.notes).toMatch(/WIN_TEST_VM/);
    } finally {
      if (oldTarget !== undefined) process.env.WIN_TEST_VM_TARGET = oldTarget;
      if (oldKey !== undefined) process.env.WIN_TEST_VM_SSH_KEY = oldKey;
    }
  });
});
