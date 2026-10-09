/**
 * Unknown AV / firewall state renders as Unknown, not Inactive/Disabled (#8252).
 *
 * Since #8043 the API returns `realTimeProtection` / `firewallEnabled` as null
 * when the agent's collector failed. These views used to coerce null to
 * "off" and paint the device red.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AntivirusPage from './AntivirusPage';
import FirewallPage from './FirewallPage';
import DeviceSecurityStatus from './DeviceSecurityStatus';
import SecurityDashboard from './SecurityDashboard';
import { fetchWithAuth } from '@/stores/auth';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
  }) as unknown as Response;

function routeFetch(routes: Record<string, unknown>) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    const path = String(url).split('?')[0]!;
    const hit = Object.entries(routes).find(([prefix]) => path === prefix);
    return json(hit ? hit[1] : { data: [] });
  });
}

const page = { page: 1, limit: 50, total: 1, totalPages: 1 };

describe('unknown AV / firewall state (#8252)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AntivirusPage shows Unknown, not Inactive, for a null real-time-protection reading', async () => {
    routeFetch({
      '/security/status': {
        data: [
          {
            deviceId: 'dev-1',
            deviceName: 'UNKNOWN-AV-PC',
            os: 'windows',
            status: 'at_risk',
            riskLevel: 'low',
            realTimeProtection: null,
            provider: { name: 'Microsoft Defender', vendor: 'Microsoft' },
          },
        ],
        pagination: page,
      },
      '/security/dashboard': { data: null },
    });

    render(<AntivirusPage />);
    const row = (await screen.findByText('UNKNOWN-AV-PC')).closest('tr')!;
    expect(row.textContent).toContain('Unknown');
    expect(row.textContent).not.toContain('Inactive');
  });

  it('FirewallPage shows Unknown, not Disabled, for a null firewall reading', async () => {
    routeFetch({
      '/security/firewall': {
        data: [
          {
            deviceId: 'dev-1',
            deviceName: 'UNKNOWN-FW-PC',
            os: 'windows',
            firewallEnabled: null,
            profiles: [],
            rulesCount: null,
          },
        ],
        pagination: page,
        summary: { total: 1, enabled: 0, disabled: 0, unknown: 1, coveragePercent: 0 },
      },
    });

    render(<FirewallPage />);
    const row = (await screen.findByText('UNKNOWN-FW-PC')).closest('tr')!;
    expect(row.textContent).toContain('Unknown');
    expect(row.textContent).not.toContain('Disabled');
  });

  it('DeviceSecurityStatus shows Unknown for null real-time protection and firewall', async () => {
    routeFetch({
      '/security/status/dev-1': {
        data: {
          deviceId: 'dev-1',
          deviceName: 'UNKNOWN-DEV',
          provider: null,
          providerVersion: null,
          definitionsVersion: null,
          definitionsUpdatedAt: null,
          lastScanAt: null,
          lastScanType: null,
          realTimeProtection: null,
          firewallEnabled: null,
          encryptionStatus: 'encrypted',
          status: 'at_risk',
          threatsDetected: 0,
        },
      },
    });

    // Compact view: the firewall tile.
    const { unmount } = render(<DeviceSecurityStatus deviceId="dev-1" />);
    await screen.findByText('UNKNOWN-DEV');
    expect(screen.getAllByText('Unknown')).toHaveLength(1);
    expect(screen.queryByText('Disabled')).toBeNull();
    unmount();

    // Full view: the real-time protection and firewall protection rows.
    render(<DeviceSecurityStatus deviceId="dev-1" showAvActions />);
    await screen.findByText(/UNKNOWN-DEV/);
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    expect(screen.queryByText('Disabled')).toBeNull();
  });

  it('SecurityDashboard lists unknown devices in their own row and in the tracked total', async () => {
    routeFetch({
      '/security/dashboard': {
        data: {
          totalDevices: 4,
          securityScore: 80,
          antivirus: { protected: 2, unprotected: 1, unknown: 1 },
          firewall: { enabled: 1, disabled: 1, unknown: 2 },
        },
      },
    });

    render(<SecurityDashboard />);
    await screen.findByText(/4 devices tracked/i);
    expect(screen.getByTestId('security-av-unknown').textContent).toContain('1 (25%)');
    expect(screen.getByTestId('security-firewall-unknown').textContent).toContain('2 (50%)');
  });
});
