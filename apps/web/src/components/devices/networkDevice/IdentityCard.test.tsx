import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IdentityCard } from './IdentityCard';
import type { NetworkAssetExtras } from './types';
import type { DiscoveredAsset } from '../../discovery/DiscoveredAssetList';

const baseAsset: DiscoveredAsset = {
  id: 'a1',
  ip: '10.0.0.9',
  mac: 'aa:bb:cc:dd:ee:ff',
  hostname: 'prn-01',
  label: 'Front desk printer',
  type: 'printer',
  approvalStatus: 'approved',
  isOnline: true,
  manufacturer: 'Xerox',
  lastSeen: '2026-09-16T10:00:00.000Z',
  openPorts: [],
  osFingerprint: 'IOS-XE',
  snmpData: { sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1' },
  responseTimeMs: 3.1,
  linkedDeviceId: null,
  linkedDeviceName: undefined,
  typeSource: 'auto',
  detectedType: 'printer',
  discoveryMethods: ['arp', 'snmp'],
  notes: null,
  tags: [],
  profileName: 'HQ LAN',
};

const baseExtras: NetworkAssetExtras = {
  model: 'C325 Color MFP',
  netbiosName: 'PRN01',
  siteId: 'site-1',
  siteName: 'HQ',
  siteTimezone: 'UTC',
  firstSeenAt: '2026-05-01T10:07:32.000Z',
  nicVendor: 'LEXMARK INTERNATIONAL, INC.',
};

function renderIdentity(
  asset: Partial<DiscoveredAsset> = {},
  extras: Partial<NetworkAssetExtras> = {},
) {
  return render(
    <IdentityCard
      asset={{ ...baseAsset, ...asset }}
      extras={{ ...baseExtras, ...extras }}
      timezone={extras.siteTimezone ?? 'UTC'}
      onAnnounce={vi.fn()}
      onEditIdentity={vi.fn()}
    />,
  );
}

describe('IdentityCard', () => {
  it('copies the IP and the MAC', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderIdentity();

    await userEvent.click(screen.getByTestId('network-detail-copy-ip'));
    expect(writeText).toHaveBeenLastCalledWith('10.0.0.9');

    await userEvent.click(screen.getByTestId('network-detail-copy-mac'));
    expect(writeText).toHaveBeenLastCalledWith('aa:bb:cc:dd:ee:ff');
  });

  it('shows the NIC vendor only when it differs from the manufacturer', () => {
    const { unmount } = renderIdentity();
    expect(screen.getByTestId('network-detail-nic-vendor').textContent).toContain('LEXMARK');
    unmount();

    renderIdentity({ manufacturer: 'Lexmark International, Inc.' }, { nicVendor: 'LEXMARK INTERNATIONAL, INC.' });
    expect(screen.queryByTestId('network-detail-nic-vendor')).toBeNull();
  });

  it('links "Same device as" to the managed device when linked', () => {
    renderIdentity({ linkedDeviceId: 'dev-9', linkedDeviceName: 'PRN-01' });
    const link = screen.getByTestId('network-detail-linked-device');
    expect(link).toHaveAttribute('href', '/devices/dev-9');
    expect(link.textContent).toContain('PRN-01');
  });

  it('keeps scan internals behind the disclosure, closed by default', async () => {
    renderIdentity();
    const details = screen.getByTestId('network-detail-scan-details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByTestId('network-detail-identity-primary').textContent).not.toContain('IOS-XE');

    await userEvent.click(screen.getByTestId('network-detail-scan-details-toggle'));
    expect(details).toHaveAttribute('open');
    expect(details.textContent).toContain('IOS-XE');
    expect(details.textContent).toContain('PRN01');
    expect(details.textContent).toContain('HQ LAN');
    expect(details.textContent).toContain('arp, snmp');
  });

  it('renders First seen without seconds and with an absolute title', async () => {
    renderIdentity();
    await userEvent.click(screen.getByTestId('network-detail-scan-details-toggle'));
    const firstSeen = screen.getByTestId('network-detail-first-seen');
    expect(firstSeen.textContent).toContain('10:07');
    expect(firstSeen.textContent).not.toContain(':32');
  });

  it('exposes the raw sysObjectID and the legacy scan verdict as scan details only', async () => {
    renderIdentity();
    expect(screen.getByTestId('network-detail-identity-primary').textContent).not.toContain('1.3.6.1.4.1.253');

    await userEvent.click(screen.getByTestId('network-detail-scan-details-toggle'));
    expect(screen.getByTestId('network-detail-sys-object-id').textContent).toContain('1.3.6.1.4.1.253');
    // The scan's is_online is a legacy verdict, never the page's status.
    expect(screen.getByTestId('network-detail-legacy-verdict').textContent).toContain('Online');
  });

  it('never renders an OID-shaped model in the Model row', () => {
    renderIdentity({}, { model: null });
    const model = screen.getByTestId('network-detail-model');
    expect(model.textContent).not.toContain('1.3.6.1');
    expect(model.querySelector('[aria-label]')).toHaveAttribute('aria-label', 'Unknown');
  });

  it('keeps W04’s Edit in settings hand-off', async () => {
    const onEditIdentity = vi.fn();
    render(
      <IdentityCard
        asset={baseAsset}
        extras={baseExtras}
        timezone="UTC"
        onAnnounce={vi.fn()}
        onEditIdentity={onEditIdentity}
      />,
    );
    await userEvent.click(screen.getByTestId('network-detail-edit-identity'));
    expect(onEditIdentity).toHaveBeenCalledTimes(1);
  });
  it('renders the shifted First seen hour in Asia/Tokyo', () => {
    renderIdentity({}, { siteTimezone: 'Asia/Tokyo' });
    expect(screen.getByTestId('network-detail-first-seen')).toHaveTextContent('07:07 PM');
    expect(screen.getByTestId('network-detail-first-seen').querySelector('dd')).toHaveAttribute('title', expect.stringContaining('07:07 PM'));
  });

});
