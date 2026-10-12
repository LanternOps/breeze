import { beforeEach, describe, expect, it, vi } from 'vitest';

const recompute = vi.fn();
vi.mock('../routes/backup/readinessCalculator', () => ({
  recomputeRecoveryReadinessForDevice: (...args: unknown[]) => recompute(...args),
}));
const afterCommit = vi.fn();
vi.mock('../db', () => ({
  runAfterDbContextCommit: (...args: unknown[]) => afterCommit(...args),
}));

import { refreshReadinessAfterRecovery, runReadinessRefresh } from './bareMetalReadinessRefresh';

describe('readiness refresh after a bare-metal recovery settles', () => {
  beforeEach(() => { recompute.mockReset(); afterCommit.mockReset(); });

  it('is deferred until the caller transaction commits, then recomputes', async () => {
    recompute.mockResolvedValue({});
    refreshReadinessAfterRecovery('org-1', 'dev-1');
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(recompute).not.toHaveBeenCalled();
    const [label, work] = afterCommit.mock.calls[0] as [string, () => Promise<void>];
    expect(label).toBe('bare-metal-readiness-refresh');
    await work();
    expect(recompute).toHaveBeenCalledWith('org-1', 'dev-1');
  });

  it('swallows a recompute failure and logs the org and device', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recompute.mockRejectedValue(new Error('boom'));
    await expect(runReadinessRefresh('org-1', 'dev-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('org-1');
    expect(String(warn.mock.calls[0]?.[0])).toContain('dev-1');
    warn.mockRestore();
  });
});
