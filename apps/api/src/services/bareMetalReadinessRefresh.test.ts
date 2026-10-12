import { beforeEach, describe, expect, it, vi } from 'vitest';

const recompute = vi.fn();
vi.mock('../routes/backup/readinessCalculator', () => ({
  recomputeRecoveryReadinessForDevice: (...args: unknown[]) => recompute(...args),
}));

import { refreshReadinessAfterRecovery } from './bareMetalReadinessRefresh';

describe('refreshReadinessAfterRecovery', () => {
  beforeEach(() => { recompute.mockReset(); });

  it('recomputes readiness for the device', async () => {
    recompute.mockResolvedValue({});
    await refreshReadinessAfterRecovery('org-1', 'dev-1');
    expect(recompute).toHaveBeenCalledWith('org-1', 'dev-1');
  });

  it('swallows a recompute failure (never fails the recovery write)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recompute.mockRejectedValue(new Error('boom'));
    await expect(refreshReadinessAfterRecovery('org-1', 'dev-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
