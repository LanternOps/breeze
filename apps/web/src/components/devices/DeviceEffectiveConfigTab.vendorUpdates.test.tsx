import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';

// #11281: the Vendor updates card was a generic key/value dump that showed the
// schema "Version: 1" and left out the schedule and the vendor list.

const response = {
  deviceId: 'dev-1',
  features: {
    oem_updates: {
      featureType: 'oem_updates',
      featurePolicyId: null,
      inlineSettings: {
        version: 1,
        enabled: true,
        schedule: { weekOfMonth: 'second', dayOfWeek: 'tue', windowStart: '02:00', windowHours: 4 },
        catchUpNights: 3,
        reboot: 'overnight',
        vendors: {
          dell: { enabled: true, categories: { bios: true }, blockedUpdateIds: [] },
          lenovo: { enabled: false, categories: {}, blockedUpdateIds: [] },
        },
      },
      sourceLevel: 'organization',
      sourceTargetId: 'org-1',
      sourcePolicyId: 'pol-1',
      sourcePolicyName: 'Org Vendor Policy',
      sourcePriority: 0,
    },
  },
  inheritanceChain: [
    { level: 'organization', targetId: 'org-1', policyId: 'pol-1', policyName: 'Org Vendor Policy', priority: 0, featureTypes: ['oem_updates'] },
  ],
};

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => response })),
}));

describe('DeviceEffectiveConfigTab — Vendor updates card (#11281)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the schedule and enabled vendors, not the schema version', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    const name = (await screen.findAllByText('Org Vendor Policy'))[0];
    const card = name.closest('div.rounded-lg') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).not.toMatch(/version/i);
    expect(card.textContent).toMatch(/second tue, 02:00, 4 h window/i);
    expect(card.textContent).toMatch(/Dell/);
    expect(card.textContent).not.toMatch(/Lenovo/);
  });
});
