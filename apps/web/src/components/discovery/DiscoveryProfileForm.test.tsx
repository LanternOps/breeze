import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DiscoveryProfileForm, { type DiscoveryProfileFormValues } from './DiscoveryProfileForm';

const baseProfile: DiscoveryProfileFormValues = {
  name: 'HQ scan',
  siteId: 'site-1',
  subnets: ['192.0.2.0/24'],
  methods: ['ping'],
  schedule: {
    cadence: 'daily',
    intervalHours: 1,
    intervalMinutes: 60,
    time: '02:00',
    dayOfWeek: 'Monday',
    dayOfMonth: '1',
    timezone: 'UTC'
  },
  snmp: {
    version: 'v2c',
    community: 'public',
    port: 161,
    timeout: 2000,
    retries: 1,
    username: '',
    authProtocol: 'sha',
    authPassphrase: '',
    privacyProtocol: 'aes',
    privacyPassphrase: ''
  },
  alertSettings: {
    enabled: false,
    alertOnNew: true,
    alertOnDisappeared: true,
    alertOnChanged: true,
    changeRetentionDays: 90
  }
};

describe('DiscoveryProfileForm', () => {
  it('shows SNMP settings only when SNMP probe is selected', () => {
    render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={vi.fn()} />);

    expect(screen.queryByTestId('discovery-snmp-settings')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('SNMP Probe'));
    expect(screen.getByTestId('discovery-snmp-settings')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('SNMP Probe'));
    expect(screen.queryByTestId('discovery-snmp-settings')).not.toBeInTheDocument();
  });

  describe('site move (edit mode)', () => {
    const sites = [{ id: 'site-1', name: 'HQ' }, { id: 'site-2', name: 'Branch' }];
    const siteSelect = () => screen.getByTestId('discovery-profile-site-select');

    it('offers to move discovered assets only while the site differs from the original', async () => {
      const loadMovableAssetCount = vi.fn().mockResolvedValue(12);
      const onSubmit = vi.fn();
      render(
        <DiscoveryProfileForm
          initialValues={baseProfile}
          sites={sites}
          onSubmit={onSubmit}
          loadMovableAssetCount={loadMovableAssetCount}
        />
      );

      expect(screen.queryByTestId('discovery-profile-site-move-notice')).not.toBeInTheDocument();
      expect(loadMovableAssetCount).not.toHaveBeenCalled();

      fireEvent.change(siteSelect(), { target: { value: 'site-2' } });

      expect(screen.getByTestId('discovery-profile-site-move-notice')).toBeInTheDocument();
      const checkbox = screen.getByTestId('discovery-profile-move-assets');
      expect(checkbox).not.toBeChecked();
      expect(await screen.findByText('Also move the 12 network devices this profile discovered to the new site')).toBeInTheDocument();
      expect(loadMovableAssetCount).toHaveBeenCalledTimes(1);

      // Unchecked by default: the site change alone never moves assets.
      fireEvent.click(screen.getByText('Save Profile'));
      expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ siteId: 'site-2', moveDiscoveredAssets: false }));

      fireEvent.click(checkbox);
      fireEvent.click(screen.getByText('Save Profile'));
      expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ siteId: 'site-2', moveDiscoveredAssets: true }));

      // Reverting to the original site withdraws the offer and the flag.
      fireEvent.change(siteSelect(), { target: { value: 'site-1' } });
      expect(screen.queryByTestId('discovery-profile-site-move-notice')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Save Profile'));
      expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ siteId: 'site-1', moveDiscoveredAssets: false }));
      expect(loadMovableAssetCount).toHaveBeenCalledTimes(1);
    });

    it('shows the checkbox without a count while the count is loading or unavailable', async () => {
      const loadMovableAssetCount = vi.fn().mockRejectedValue(new Error('offline'));
      render(
        <DiscoveryProfileForm
          initialValues={baseProfile}
          sites={sites}
          onSubmit={vi.fn()}
          loadMovableAssetCount={loadMovableAssetCount}
        />
      );

      fireEvent.change(siteSelect(), { target: { value: 'site-2' } });

      expect(screen.getByText('Also move the network devices this profile discovered to the new site')).toBeInTheDocument();
      await waitFor(() => expect(loadMovableAssetCount).toHaveBeenCalledTimes(1));
      expect(screen.getByText('Also move the network devices this profile discovered to the new site')).toBeInTheDocument();
      expect(screen.getByTestId('discovery-profile-move-assets')).toBeInTheDocument();
    });

    it('never offers the move on a new profile', () => {
      render(<DiscoveryProfileForm sites={sites} onSubmit={vi.fn()} />);

      fireEvent.change(siteSelect(), { target: { value: 'site-2' } });

      expect(screen.queryByTestId('discovery-profile-site-move-notice')).not.toBeInTheDocument();
    });
  });
});
import '@/lib/i18n';
