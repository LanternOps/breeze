// apps/web/src/components/devices/networkDevice/settings/NetworkAssetSettingsModal.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkAssetSettingsModal } from './NetworkAssetSettingsModal';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn().mockResolvedValue({
  ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }),
}) }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const asset: DiscoveredAsset = {
  id: 'asset-1',
  ip: '10.0.0.2',
  mac: 'aa:bb:cc:dd:ee:ff',
  hostname: 'core-sw-01',
  label: 'Main Switch',
  type: 'switch',
  approvalStatus: 'approved',
  isOnline: true,
  manufacturer: 'Cisco',
  typeSource: 'auto',
  tags: ['core'],
  notes: 'Closet A',
};

const baseProps = {
  open: true,
  section: 'identity' as const,
  assetId: asset.id,
  asset,
  extras: { siteId: 'site-1' },
  onSectionChange: vi.fn(),
  onClose: vi.fn(),
  onSaved: vi.fn(),
  onAnnounce: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe('NetworkAssetSettingsModal', () => {
  it('renders nothing when closed', () => {
    render(<NetworkAssetSettingsModal {...baseProps} open={false} section={null} />);
    expect(screen.queryByTestId('network-asset-settings-modal')).not.toBeInTheDocument();
  });

  it('renders nothing when open but no section is selected', () => {
    render(<NetworkAssetSettingsModal {...baseProps} section={null} />);
    expect(screen.queryByTestId('network-asset-settings-modal')).not.toBeInTheDocument();
  });

  it('renders the four-section rail and marks the active one', () => {
    render(<NetworkAssetSettingsModal {...baseProps} section="monitoring" />);

    for (const section of ['identity', 'monitoring', 'link', 'danger']) {
      expect(screen.getByTestId(`network-settings-nav-${section}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('network-settings-nav-monitoring')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('network-settings-nav-identity')).not.toHaveAttribute('aria-current', 'true');
  });

  it('renders only the active section panel', () => {
    render(<NetworkAssetSettingsModal {...baseProps} section="identity" />);

    expect(screen.getByTestId('network-settings-panel-identity')).toBeInTheDocument();
    expect(screen.queryByTestId('network-settings-panel-danger')).not.toBeInTheDocument();
  });

  it('asks the page to change section instead of owning the selection', () => {
    render(<NetworkAssetSettingsModal {...baseProps} section="identity" />);

    fireEvent.click(screen.getByTestId('network-settings-nav-danger'));
    expect(baseProps.onSectionChange).toHaveBeenCalledWith('danger');
  });

  it('shows the asset name in the dialog title so the operator knows what they are editing', () => {
    render(<NetworkAssetSettingsModal {...baseProps} />);
    expect(screen.getByTestId('network-asset-settings-modal').textContent).toContain('Main Switch');
  });
});
