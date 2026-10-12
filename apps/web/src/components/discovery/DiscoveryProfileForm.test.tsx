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

  it('rejects a subnet the agent would skip (> 65,536 hosts) inline and does not submit', () => {
    const onSubmit = vi.fn();
    const { container } = render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={onSubmit} />);
    const textarea = screen.getByDisplayValue('192.0.2.0/24');

    fireEvent.change(textarea, { target: { value: '192.0.2.0/24\n0.0.0.0/0' } });
    fireEvent.submit(container.querySelector('form')!);

    expect(screen.getByText(/"0\.0\.0\.0\/0": subnet is too large.*65,536/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    // A /16 is exactly at the limit and is accepted.
    fireEvent.change(textarea, { target: { value: '10.1.0.0/16' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
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

describe('DiscoveryProfileForm scan agent (#7969)', () => {
  const sites = [{ id: 'site-1', name: 'HQ' }, { id: 'site-2', name: 'Branch' }];
  const agentSelect = () => screen.getByTestId('discovery-profile-scan-agent-select') as HTMLSelectElement;

  it('is hidden when no agent loader is supplied', () => {
    render(<DiscoveryProfileForm initialValues={baseProfile} sites={sites} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId('discovery-profile-scan-agent-select')).not.toBeInTheDocument();
  });

  it('lists the selected site\'s agents after Automatic and submits the chosen pin', async () => {
    const loadSiteAgents = vi.fn().mockResolvedValue([
      { id: 'dev-1', name: 'scanner-01', online: true },
      { id: 'dev-2', name: 'laptop-07', online: false },
    ]);
    const onSubmit = vi.fn();
    const { container } = render(
      <DiscoveryProfileForm initialValues={baseProfile} sites={sites} onSubmit={onSubmit} loadSiteAgents={loadSiteAgents} />
    );

    await waitFor(() => expect(agentSelect().options).toHaveLength(3));
    expect(loadSiteAgents).toHaveBeenCalledWith('site-1');
    expect(agentSelect().value).toBe('');
    expect(agentSelect().options[2]!.textContent).toMatch(/laptop-07.*offline/i);

    fireEvent.change(agentSelect(), { target: { value: 'dev-1' } });
    fireEvent.submit(container.querySelector('form')!);

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ pinnedDeviceId: 'dev-1' }));
  });

  it('clears the pin and reloads agents when the site changes', async () => {
    const loadSiteAgents = vi.fn(async (siteId: string) => siteId === 'site-1'
      ? [{ id: 'dev-1', name: 'scanner-01', online: true }]
      : [{ id: 'dev-9', name: 'branch-pc', online: true }]);
    const onSubmit = vi.fn();
    const { container } = render(
      <DiscoveryProfileForm
        initialValues={{ ...baseProfile, pinnedDeviceId: 'dev-1' }}
        sites={sites}
        onSubmit={onSubmit}
        loadSiteAgents={loadSiteAgents}
      />
    );
    await waitFor(() => expect(agentSelect().value).toBe('dev-1'));

    fireEvent.change(screen.getByTestId('discovery-profile-site-select'), { target: { value: 'site-2' } });

    await waitFor(() => expect(loadSiteAgents).toHaveBeenCalledWith('site-2'));
    await waitFor(() => expect(Array.from(agentSelect().options).map((o) => o.value)).toEqual(['', 'dev-9']));
    expect(agentSelect().value).toBe('');
    fireEvent.submit(container.querySelector('form')!);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ siteId: 'site-2', pinnedDeviceId: '' }));
  });

  it('keeps a stored pin that is not in the loaded list visible instead of silently showing Automatic', async () => {
    const loadSiteAgents = vi.fn().mockResolvedValue([{ id: 'dev-1', name: 'scanner-01', online: true }]);
    render(
      <DiscoveryProfileForm
        initialValues={{ ...baseProfile, pinnedDeviceId: 'dev-gone' }}
        sites={sites}
        onSubmit={vi.fn()}
        loadSiteAgents={loadSiteAgents}
      />
    );

    await waitFor(() => expect(agentSelect().options).toHaveLength(3));
    expect(agentSelect().value).toBe('dev-gone');
  });

  it('shows a load error and still allows Automatic', async () => {
    const loadSiteAgents = vi.fn().mockRejectedValue(new Error('boom'));
    render(<DiscoveryProfileForm initialValues={baseProfile} sites={sites} onSubmit={vi.fn()} loadSiteAgents={loadSiteAgents} />);

    expect(await screen.findByTestId('discovery-profile-scan-agent-error')).toBeInTheDocument();
    expect(agentSelect().value).toBe('');
  });
});

import '@/lib/i18n';
