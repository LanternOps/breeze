import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('./featureConfigResolver', () => ({ resolveSoftwarePolicyCoverage: vi.fn() }));

import { checkDefaultListPlacement, getSoftwarePolicyCoverage } from './softwarePolicyCoverage';
import { resolveSoftwarePolicyCoverage } from './featureConfigResolver';

describe('additive software coverage', () => {
  it.each(['allowlist', 'blocklist'] as const)('permits the org default %s without displacing a partner policy or the other default', async (mode) => {
    // No winner/assignment query is valid: placement is independent of all other software links.
    await expect(checkDefaultListPlacement({
      orgId: 'org-1', mode, policyName: `Default ${mode}`, configPolicyName: `Default ${mode} Config`,
    })).resolves.toEqual({ ok: true, overrides: [] });
  });

  it('preserves applying counts and caller site-ceiling restriction without override warnings', async () => {
    vi.mocked(resolveSoftwarePolicyCoverage).mockResolvedValueOnce({
      candidateDeviceIds: ['dev-1', 'dev-2'], appliesToDeviceIds: ['dev-1', 'dev-2'], overriddenBy: [],
    });
    await expect(getSoftwarePolicyCoverage('required', { restrictToDeviceIds: ['dev-1', 'dev-2'] })).resolves.toEqual({
      assignedDeviceCount: 2, appliesToDeviceCount: 2, overriddenBy: [],
    });
    expect(resolveSoftwarePolicyCoverage).toHaveBeenCalledWith('required', { restrictToDeviceIds: ['dev-1', 'dev-2'] });
  });
});
