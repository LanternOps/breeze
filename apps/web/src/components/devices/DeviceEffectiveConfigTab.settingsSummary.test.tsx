import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';

// #7214 (paper cut #27): the settings-summary line for a backup destination
// config id printed a raw UUID with one segment title-cased by the CSS
// `capitalize` utility applied to the whole "label: value" string (e.g.
// "Destination Config Id: 0277b48e-Bfc6-4e21-94de-6aacc6f667a7"). Only the
// label should ever be title-cased — the value (here a UUID) must render
// byte-for-byte as returned by the API.

const uuidResponse = {
  deviceId: 'dev-uuid',
  features: {
    backup: {
      featureType: 'backup',
      featurePolicyId: null,
      inlineSettings: { destinationConfigId: '0277b48e-bfc6-4e21-94de-6aacc6f667a7' },
      sourceLevel: 'organization',
      sourceTargetId: 'org-1',
      sourcePolicyId: 'pol-backup',
      sourcePolicyName: 'Org Backup Policy',
      sourcePriority: 0,
    },
  },
  inheritanceChain: [
    { level: 'organization', targetId: 'org-1', policyId: 'pol-backup', policyName: 'Org Backup Policy', priority: 0, featureTypes: ['backup'] },
  ],
};

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => uuidResponse,
  })),
}));

describe('DeviceEffectiveConfigTab settings summary — UUID values (#7214)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a UUID settings value verbatim, not title-cased', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-uuid" />);
    const valueEl = await screen.findByText(/0277b48e-bfc6-4e21-94de-6aacc6f667a7/);
    // `text-transform: capitalize` visually title-cases every hyphen-delimited
    // segment of a UUID even though jsdom's textContent stays untouched, so a
    // plain text match alone can't catch this bug — the CSS class itself must
    // not be applied to the value (or any ancestor up to the line item).
    let node: HTMLElement | null = valueEl;
    while (node) {
      expect(node.className).not.toMatch(/\bcapitalize\b/);
      node = node.parentElement;
    }
  });
});
