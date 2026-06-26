import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';

// Device with ONLY baseline (synthetic 'default') features — no real assigned policy.
const baselineOnlyResponse = {
  deviceId: 'dev-1',
  features: {
    patch: { featureType: 'patch', featurePolicyId: null, inlineSettings: null, sourceLevel: 'default', sourceTargetId: 'breeze-defaults', sourcePolicyId: 'breeze-defaults', sourcePolicyName: 'Breeze Defaults', sourcePriority: 0 },
    alert_rule: { featureType: 'alert_rule', featurePolicyId: null, inlineSettings: null, sourceLevel: 'default', sourceTargetId: 'breeze-defaults', sourcePolicyId: 'breeze-defaults', sourcePolicyName: 'Breeze Defaults', sourcePriority: 0 },
  },
  inheritanceChain: [
    { level: 'default', targetId: 'breeze-defaults', policyId: 'breeze-defaults', policyName: 'Breeze Defaults', priority: 0, featureTypes: ['patch', 'alert_rule'] },
  ],
};

// Device with one REAL org-level policy plus baseline fall-through for the rest.
// The inheritance chain carries BOTH a real org node and the synthetic default node.
const mixedResponse = {
  deviceId: 'dev-2',
  features: {
    patch: { featureType: 'patch', featurePolicyId: null, inlineSettings: null, sourceLevel: 'organization', sourceTargetId: 'org-1', sourcePolicyId: 'pol-org', sourcePolicyName: 'Org Patch Policy', sourcePriority: 10 },
    alert_rule: { featureType: 'alert_rule', featurePolicyId: null, inlineSettings: null, sourceLevel: 'default', sourceTargetId: 'breeze-defaults', sourcePolicyId: 'breeze-defaults', sourcePolicyName: 'Breeze Defaults', sourcePriority: 0 },
  },
  inheritanceChain: [
    { level: 'organization', targetId: 'org-1', policyId: 'pol-org', policyName: 'Org Patch Policy', priority: 10, featureTypes: ['patch'] },
    { level: 'default', targetId: 'breeze-defaults', policyId: 'breeze-defaults', policyName: 'Breeze Defaults', priority: 0, featureTypes: ['alert_rule'] },
  ],
};

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) => {
    const body = url.includes('dev-2') ? mixedResponse : baselineOnlyResponse;
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  }),
}));

describe('DeviceEffectiveConfigTab baseline labeling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the empty state with a Breeze Defaults link when only the baseline is present', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    await waitFor(() =>
      expect(screen.getByText('No Configuration Policies')).toBeInTheDocument(),
    );
    const link = screen.getByText('View Breeze Defaults');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/configuration-policies/defaults');
  });

  it('labels baseline fall-through features as sourced from Breeze Defaults', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-2" />);
    // Real assigned policy still renders normally...
    await waitFor(() => expect(screen.getAllByText('Org Patch Policy').length).toBeGreaterThan(0));
    // ...and the baseline fall-through feature shows "Breeze Defaults" as its source.
    expect(screen.getAllByText(/Breeze Defaults/).length).toBeGreaterThan(0);
  });

  it('excludes the synthetic default node from the assigned-policy count', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-2" />);
    // Chain has 2 entries (org + default); the count must report only the 1 real policy.
    await waitFor(() =>
      expect(screen.getByText(/1 assigned/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/2 assigned/i)).not.toBeInTheDocument();
  });
});
