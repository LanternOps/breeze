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

// Device whose real org policy enforces warranty (a feature type beyond the
// original 8). Regression for the bug where the inheritance chain listed
// 'warranty' but no warranty card rendered (the hardcoded card list dropped it).
const warrantyResponse = {
  deviceId: 'dev-3',
  features: {
    warranty: { featureType: 'warranty', featurePolicyId: null, inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 }, sourceLevel: 'organization', sourceTargetId: 'org-1', sourcePolicyId: 'pol-warr', sourcePolicyName: 'Windows Workstations', sourcePriority: 0 },
    backup: { featureType: 'backup', featurePolicyId: null, inlineSettings: null, sourceLevel: 'default', sourceTargetId: 'breeze-defaults', sourcePolicyId: 'breeze-defaults', sourcePolicyName: 'Breeze Defaults', sourcePriority: 0 },
  },
  inheritanceChain: [
    { level: 'organization', targetId: 'org-1', policyId: 'pol-warr', policyName: 'Windows Workstations', priority: 0, featureTypes: ['warranty'] },
    { level: 'default', targetId: 'breeze-defaults', policyId: 'breeze-defaults', policyName: 'Breeze Defaults', priority: 0, featureTypes: ['backup'] },
  ],
};

// Device where every resolved feature is enforced by a real policy and NOTHING
// falls through to the baseline — the "Not enforced" strip must not render, and
// the header must pluralize the enforced-feature count.
const allEnforcedResponse = {
  deviceId: 'dev-4',
  features: {
    patch: { featureType: 'patch', featurePolicyId: null, inlineSettings: null, sourceLevel: 'site', sourceTargetId: 'site-1', sourcePolicyId: 'pol-a', sourcePolicyName: 'Site Patch', sourcePriority: 0 },
    warranty: { featureType: 'warranty', featurePolicyId: null, inlineSettings: { enabled: true }, sourceLevel: 'site', sourceTargetId: 'site-1', sourcePolicyId: 'pol-a', sourcePolicyName: 'Site Patch', sourcePriority: 0 },
  },
  inheritanceChain: [
    { level: 'site', targetId: 'site-1', policyId: 'pol-a', policyName: 'Site Patch', priority: 0, featureTypes: ['patch', 'warranty'] },
  ],
};

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) => {
    const body = url.includes('dev-4')
      ? allEnforcedResponse
      : url.includes('dev-3')
        ? warrantyResponse
        : url.includes('dev-2')
          ? mixedResponse
          : baselineOnlyResponse;
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
    // ...and is explicitly marked "Not enforced" so it never reads as configured.
    expect(screen.getByText('Not enforced')).toBeInTheDocument();
  });

  it('excludes the synthetic default node from the assigned-policy count', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-2" />);
    // Chain has 2 entries (org + default); the count must report only the 1 real policy.
    await waitFor(() =>
      expect(screen.getByText(/1 assigned/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/2 assigned/i)).not.toBeInTheDocument();
  });

  it('renders an enforced card for a warranty policy and collapses baseline features into the Not-enforced strip', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-3" />);
    // Warranty is enforced by a real org policy → it must render as a full card
    // (the original bug dropped it because it was outside the hardcoded card list).
    // The card renders the label as an <h4> heading; the inheritance chain renders
    // the same word only as a <span> chip. Targeting the heading role pins the
    // CARD specifically, so this can't pass on the chain alone (the original bug).
    await screen.findByRole('heading', { level: 4, name: 'Warranty' });
    // Inline settings are summarized on the card so the enabled state is visible.
    expect(screen.getByText(/enabled: yes/i)).toBeInTheDocument();
    // The header counts only the enforced feature, not the baseline fall-through.
    expect(screen.getByText(/1 enforced feature/i)).toBeInTheDocument();
    // Baseline fall-through (backup) is collapsed into the compact strip, not a card.
    expect(screen.getByText('Not enforced')).toBeInTheDocument();
    expect(screen.getAllByText('Backup').length).toBeGreaterThan(0);
  });

  it('omits the Not-enforced strip and pluralizes the count when every feature is enforced', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-4" />);
    // Both enforced features render as cards...
    await screen.findByRole('heading', { level: 4, name: 'Patch Management' });
    expect(screen.getByRole('heading', { level: 4, name: 'Warranty' })).toBeInTheDocument();
    // ...the header pluralizes (regression guard for the `!== 1 ? 's'` branch)...
    expect(screen.getByText(/2 enforced features/i)).toBeInTheDocument();
    // ...and with nothing falling through to default, the strip must NOT render —
    // otherwise the UI would falsely claim defaults apply when none do.
    expect(screen.queryByText('Not enforced')).not.toBeInTheDocument();
  });

  it('omits the synthetic default node from the inheritance-chain table (no dead link)', async () => {
    const { container } = render(<DeviceEffectiveConfigTab deviceId="dev-2" />);
    // The real org policy links into the chain table...
    await waitFor(() =>
      expect(container.querySelector('a[href="/configuration-policies/pol-org"]')).toBeTruthy(),
    );
    // ...but the synthetic baseline node must NOT render a (broken) policy link.
    expect(
      container.querySelector('a[href="/configuration-policies/breeze-defaults"]'),
    ).toBeNull();
  });
});
