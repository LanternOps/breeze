import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';

// #7625 (second symptom): the Patch Management card printed the policy-level
// "Auto approve: no", which the approval evaluator never consults (with a ring
// the ring decides; without one only manual approvals apply). Users read it as
// the effective setting. The card must say where approval actually comes from.

const PATCH_SETTINGS = {
  sources: ['os'],
  autoApprove: false,
  autoApproveSeverities: [],
  autoApproveDeferralDays: 0,
  scheduleFrequency: 'weekly',
};

function responseWith(featurePolicyId: string | null) {
  return {
    deviceId: 'dev-patch',
    features: {
      patch: {
        featureType: 'patch',
        featurePolicyId,
        inlineSettings: PATCH_SETTINGS,
        sourceLevel: 'organization',
        sourceTargetId: 'org-1',
        sourcePolicyId: 'pol-patch',
        sourcePolicyName: 'Workstations',
        sourcePriority: 0,
      },
    },
    inheritanceChain: [
      { level: 'organization', targetId: 'org-1', policyId: 'pol-patch', policyName: 'Workstations', priority: 0, featureTypes: ['patch'] },
    ],
  };
}

let current: unknown = responseWith(null);
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => current })),
}));

describe('DeviceEffectiveConfigTab — patch approval source (#7625)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hides the unused policy-level auto-approve and says the linked ring decides', async () => {
    current = responseWith('ring-1111-2222');
    render(<DeviceEffectiveConfigTab deviceId="dev-patch" />);

    expect(await screen.findByText('set by the linked update ring')).toBeInTheDocument();
    expect(screen.queryByText(/auto approve/i)).not.toBeInTheDocument();
    expect(screen.getByText('weekly')).toBeInTheDocument();
  });

  it('says manual approvals only when no ring is linked', async () => {
    current = responseWith(null);
    render(<DeviceEffectiveConfigTab deviceId="dev-patch" />);

    expect(await screen.findByText('manual approvals only (no update ring linked)')).toBeInTheDocument();
    expect(screen.queryByText(/auto approve/i)).not.toBeInTheDocument();
  });
});
