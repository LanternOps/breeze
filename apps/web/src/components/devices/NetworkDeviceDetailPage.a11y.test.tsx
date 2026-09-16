import '@/lib/i18n';

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import NetworkDeviceDetailPage from './NetworkDeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ASSET_ID = '11111111-1111-1111-1111-111111111111';

const baseAsset = {
  id: ASSET_ID,
  orgId: 'org-1',
  siteId: 'site-1',
  siteName: 'HQ',
  siteTimezone: 'UTC',
  assetType: 'switch',
  approvalStatus: 'approved',
  isOnline: true,
  hostname: 'core-switch-01',
  label: 'Main Switch',
  ipAddress: '10.0.0.2',
  macAddress: 'aa:bb:cc:dd:ee:ff',
  manufacturer: 'Cisco',
  model: null,
  openPorts: [{ port: 22, service: 'ssh' }],
  osFingerprint: null,
  snmpData: {},
  responseTimeMs: 2.4,
  linkedDeviceId: null,
  snmpMonitoringEnabled: false,
  networkMonitoringEnabled: false,
  discoveryMethods: ['arp'],
  profileName: 'HQ LAN',
  tags: [],
  firstSeenAt: '2026-05-01T10:00:00.000Z',
  lastSeenAt: '2026-09-16T10:00:00.000Z',
  reachability: {
    state: 'responding',
    source: 'snmp',
    observedAt: new Date(Date.now() - 120_000).toISOString(),
    lastKnown: null,
    detail: { snmp: { state: 'ok', observedAt: new Date(Date.now() - 120_000).toISOString(), consecutiveFailures: 0 } },
  },
};

// OverflowTabs measures button widths via offsetWidth, which jsdom reports as 0
// against a clientWidth of 0 — that collapses to "fits 1 tab", so with two tabs
// "Monitoring" is ALWAYS inside the "More" dropdown here. That is exactly the
// case the aria-labelledby fix below exists for.
function openMonitoringTab() {
  fireEvent.click(screen.getByText('More'));
  fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));
}

async function renderLoaded(assetOverrides: Record<string, unknown> = {}) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === `/discovery/assets/${ASSET_ID}`) {
      return Promise.resolve(makeJsonResponse({ data: { ...baseAsset, ...assetOverrides } }));
    }
    return Promise.resolve(makeJsonResponse({ data: [] }));
  });
  render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
  await screen.findByTestId('network-device-detail');
}

describe('NetworkDeviceDetailPage accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('labels the overview tabpanel by its own tab button, not a duplicate aria-label', async () => {
    await renderLoaded();
    const panel = screen.getByTestId('network-detail-overview');
    const labelledBy = panel.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).not.toBeNull();
    // The panel should use its tab as the single source of its accessible name.
    expect(panel).not.toHaveAttribute('aria-label');
  });

  it('keeps aria-labelledby resolvable for a tab that overflowed into "More"', async () => {
    await renderLoaded();
    openMonitoringTab();
    const panel = await screen.findByTestId('network-detail-monitoring');
    const labelledBy = panel.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).not.toBeNull();
  });

  it('moves focus to the ports section when the Open ports stat is used', async () => {
    await renderLoaded();
    await userEvent.click(screen.getByTestId('network-detail-stat-ports'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('network-detail-ports')));
  });

  it('moves focus to the Monitoring panel when the Last poll stat is used', async () => {
    await renderLoaded();
    await userEvent.click(screen.getByTestId('network-detail-stat-last-poll'));
    const panel = await screen.findByTestId('network-detail-monitoring');
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  it('gives every em-dash placeholder an accessible unknown label', async () => {
    await renderLoaded({ model: null, osFingerprint: null, macAddress: null });
    for (const dash of screen.getAllByText('—')) {
      expect(dash.closest('[aria-label]')).not.toBeNull();
    }
  });

  it('labels missing timestamps and empty SNMP values as unknown', async () => {
    await renderLoaded({ firstSeenAt: null, snmpData: { sysName: '' } });
    for (const dash of screen.getAllByText('—')) {
      expect(dash.closest('[aria-label]')).not.toBeNull();
    }
    openMonitoringTab();
    expect(screen.getByRole('tabpanel', { name: 'Monitoring' })).toBeTruthy();
  });

  it('keeps the live region a single polite announcer', async () => {
    await renderLoaded();
    const live = screen.getByTestId('network-detail-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('aria-atomic', 'true');
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });
});
