/** Device header links the org and site names to their records (ui-flow W03). */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    fetchWithAuth: vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'NOT FOUND',
      json: vi.fn().mockResolvedValue({}),
    }),
  };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => null,
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  pendingReboot: false,
  displayName: 'Edge 01',
} as Device;

describe('DeviceDetails header links (ui-flow W03)', () => {
  it('links the org name before the site name', () => {
    render(<DeviceDetails device={device} />);
    const org = screen.getByTestId('org-record-link');
    const site = screen.getByTestId('site-record-link');
    expect(org).toHaveAttribute('href', '/organizations/org-1');
    expect(org).toHaveTextContent('Org One');
    expect(site).toHaveAttribute('href', '/settings/sites/site-1');
    expect(site).toHaveTextContent('HQ');
    expect(org.compareDocumentPosition(site) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('prints an unassigned site as text', () => {
    render(<DeviceDetails device={{ ...device, siteId: '', siteName: 'Unknown Site' }} />);
    expect(screen.queryByTestId('site-record-link')).toBeNull();
    expect(screen.getByText('Unknown Site')).toBeInTheDocument();
  });
});
