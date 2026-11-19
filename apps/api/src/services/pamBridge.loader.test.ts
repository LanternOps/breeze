import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolvePolicies, select, where } = vi.hoisted(() => ({
  resolvePolicies: vi.fn(), select: vi.fn(), where: vi.fn(),
}));
vi.mock('./featureConfigResolver', () => ({ resolveSoftwarePoliciesForDevice: resolvePolicies }));
vi.mock('../db', () => ({
  db: { select }, hasDbAccessContext: vi.fn(() => true), withDbAccessContext: vi.fn(),
}));
import { loadActivePoliciesForDevice, matchPoliciesAgainst } from './pamBridge';

describe('PAM additive software-policy loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    select.mockReturnValue({ from: () => ({ where }) });
  });

  it('does not query policy rows when none apply', async () => {
    resolvePolicies.mockResolvedValue([]);
    expect(await loadActivePoliciesForDevice('device-1')).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('evaluates both applying policies and blocks an executable allowed by the other', async () => {
    resolvePolicies.mockResolvedValue(['allow', 'block']);
    const rules = { software: [], allowUnknown: true, executable: [{ name: 'application', publisher: 'Vendor' }] };
    where.mockResolvedValue([
      { id: 'allow', mode: 'allowlist', priority: 1, rules, isActive: true },
      { id: 'block', mode: 'blocklist', priority: 99, rules, isActive: true },
    ]);
    const policies = await loadActivePoliciesForDevice('device-1');
    expect(resolvePolicies).toHaveBeenCalledWith('device-1');
    expect(policies.map((p) => p.id)).toEqual(['allow', 'block']);
    expect(matchPoliciesAgainst({ orgId: 'org-1', deviceId: 'device-1', targetExecutablePath: '/app', targetPublisher: 'Vendor' }, policies))
      .toMatchObject({ match: 'blocklist', policyId: 'block' });
  });
});
