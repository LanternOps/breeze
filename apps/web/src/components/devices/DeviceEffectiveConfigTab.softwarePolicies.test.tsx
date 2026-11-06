import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';

const { response } = vi.hoisted(() => {
  const allowlist = {
    featureType: 'software_policy', featurePolicyId: 'software-allow',
    featurePolicyName: 'Required applications', inlineSettings: null,
    sourceLevel: 'partner', sourceTargetId: 'partner-1', sourcePolicyId: 'config-allow',
    sourcePolicyName: 'Install Standard Software', sourcePriority: 0,
  };
  return { response: {
    deviceId: 'device-1', features: { software_policy: allowlist }, inheritanceChain: [],
    softwarePolicies: [allowlist, {
      ...allowlist, featurePolicyId: 'software-block', featurePolicyName: 'Prohibited applications',
      sourceLevel: 'organization', sourceTargetId: 'org-1', sourcePolicyId: 'config-block',
      sourcePolicyName: 'Default Blocklist',
    }],
  } };
});
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => response })),
}));

describe('DeviceEffectiveConfigTab additive software policies', () => {
  it('names every applying software policy and its configuration source', async () => {
    render(<DeviceEffectiveConfigTab deviceId="device-1" />);
    expect(await screen.findByRole('heading', { name: 'Required applications' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Prohibited applications' })).toBeInTheDocument();
    expect(screen.getByText('Install Standard Software')).toBeInTheDocument();
    expect(screen.getByText('Default Blocklist')).toBeInTheDocument();
  });
});
