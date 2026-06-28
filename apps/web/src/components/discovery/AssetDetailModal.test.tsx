import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AssetDetailModal, { type AssetDetail } from './AssetDetailModal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown = {}, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
    clone: vi.fn().mockImplementation(function (this: Response) {
      return this;
    }),
  } as unknown as Response);

const asset: AssetDetail = {
  id: 'asset-1',
  ip: '10.0.0.5',
  mac: '—',
  hostname: 'printer-01',
  type: 'unknown',
  approvalStatus: 'pending',
  isOnline: true,
  manufacturer: '—',
  linkedDeviceId: null,
};

const devices = [
  { id: 'dev-1', name: 'WS-FRONTDESK' },
  { id: 'dev-2', name: 'WS-BACKOFFICE' },
];

beforeEach(() => {
  fetchMock.mockReset();
  // Default: any call (e.g. AssetMonitoringSection mount fetch) resolves empty.
  fetchMock.mockResolvedValue(makeResponse());
});

describe('AssetDetailModal — link to managed device', () => {
  it('renders descriptive header and helper copy that explains the link action', () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    expect(screen.getByText('Link to managed device')).toBeInTheDocument();
    expect(
      screen.getByText(/Associate this discovered asset with an existing agent-managed device/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/does not install an agent or create a new device/i)).toBeInTheDocument();
    expect(screen.getByText(/marked as approved/i)).toBeInTheDocument();
    expect(screen.getByText('Select a managed device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link asset' })).toBeInTheDocument();
  });

  it('shows a success confirmation naming the device after a successful link', async () => {
    const onLinked = vi.fn();
    render(
      <AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} onLinked={onLinked} />
    );

    fireEvent.change(screen.getByTestId('asset-modal-link-select'), { target: { value: 'dev-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link asset' }));

    await waitFor(() => {
      expect(
        screen.getByText('Asset linked to WS-FRONTDESK. It is now marked approved.')
      ).toBeInTheDocument();
    });
    expect(onLinked).toHaveBeenCalledWith('asset-1', 'dev-1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/discovery/assets/asset-1/link',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('falls back to a device-name-less confirmation when the linked device is not in the list', async () => {
    // asset.linkedDeviceId references a device absent from `devices` — the
    // select pre-selects it, but the name lookup misses, exercising the
    // fallback branch of the success message.
    const orphanAsset: AssetDetail = { ...asset, linkedDeviceId: 'dev-not-in-list' };
    render(<AssetDetailModal open asset={orphanAsset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Link asset' }));

    await waitFor(() => {
      expect(
        screen.getByText('Asset linked. It is now marked approved.')
      ).toBeInTheDocument();
    });
  });

  it('surfaces an error and shows no success message when the link request fails', async () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId('asset-modal-link-select'), { target: { value: 'dev-2' } });
    // Override only the link call to fail; mount fetch already resolved.
    fetchMock.mockResolvedValueOnce(makeResponse({}, false));
    fireEvent.click(screen.getByRole('button', { name: 'Link asset' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to link asset')).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/It is now marked approved\./i)
    ).not.toBeInTheDocument();
  });

  it('requires a device selection before linking', async () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Link asset' }));

    await waitFor(() => {
      expect(screen.getByText('Select a device to link.')).toBeInTheDocument();
    });
  });
});

describe('AssetDetailModal — unlink (manual links only)', () => {
  const manualLinked: AssetDetail = { ...asset, linkedDeviceId: 'dev-1', linkSource: 'manual' };
  const autoLinked: AssetDetail = { ...asset, linkedDeviceId: 'dev-1', linkSource: 'auto' };

  it('shows Unlink only for a manually linked asset', () => {
    const { rerender } = render(
      <AssetDetailModal open asset={manualLinked} devices={devices} onClose={() => {}} />
    );
    expect(screen.getByTestId('asset-modal-unlink')).toBeInTheDocument();

    rerender(<AssetDetailModal open asset={autoLinked} devices={devices} onClose={() => {}} />);
    expect(screen.queryByTestId('asset-modal-unlink')).not.toBeInTheDocument();

    rerender(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);
    expect(screen.queryByTestId('asset-modal-unlink')).not.toBeInTheDocument();
  });

  it('DELETEs the link and calls onUnlinked when confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onUnlinked = vi.fn();
    render(
      <AssetDetailModal open asset={manualLinked} devices={devices} onClose={() => {}} onUnlinked={onUnlinked} />
    );

    fireEvent.click(screen.getByTestId('asset-modal-unlink'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/discovery/assets/asset-1/link',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
    expect(onUnlinked).toHaveBeenCalledWith('asset-1');
    await screen.findByText('Device unlinked.');
    confirmSpy.mockRestore();
  });

  it('does not DELETE when the confirm dialog is dismissed', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AssetDetailModal open asset={manualLinked} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('asset-modal-unlink'));

    expect(
      fetchMock.mock.calls.some(c => c[0] === '/discovery/assets/asset-1/link' && (c[1] as RequestInit)?.method === 'DELETE')
    ).toBe(false);
    confirmSpy.mockRestore();
  });
});

describe('AssetDetailModal — proxy bridge agent (decoupled from link)', () => {
  const proxyAsset: AssetDetail = {
    ...asset,
    id: 'asset-1',
    ip: '10.1.2.209',
    linkedDeviceId: null,
    // proxyEnabled drives the enabled branch directly.
    ...( { proxyEnabled: true } as Record<string, unknown> ),
  };

  it('lists only ONLINE devices in the bridge picker and connects through the chosen one', async () => {
    const mixed = [
      { id: 'dev-online', name: 'WS-101', online: true },
      { id: 'dev-offline', name: 'WS-102', online: false },
    ];
    render(<AssetDetailModal open asset={proxyAsset} devices={mixed} onClose={() => {}} />);

    // Bridge picker is present; it lists ONLY the online device (offline hidden).
    // Scope to the bridge select — the identity Link dropdown lists all devices.
    expect(screen.getByText('Proxy through agent')).toBeInTheDocument();
    const bridge = screen.getByTestId('proxy-bridge-select');
    expect(within(bridge).getByRole('option', { name: 'WS-101' })).toBeInTheDocument();
    expect(within(bridge).queryByRole('option', { name: 'WS-102' })).not.toBeInTheDocument();

    // Connect uses the selected (online) bridge device, NOT the (null) linked device.
    fetchMock.mockResolvedValueOnce(makeResponse({ id: 'tunnel-xyz' }));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    fireEvent.click(screen.getByRole('button', { name: /Connect/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tunnels',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"deviceId":"dev-online"'),
        }),
      );
    });
    openSpy.mockRestore();
  });

  it('shows a no-online-agent message when no device can bridge', () => {
    const offlineOnly = [{ id: 'dev-offline', name: 'WS-102', online: false }];
    render(<AssetDetailModal open asset={proxyAsset} devices={offlineOnly} onClose={() => {}} />);

    expect(screen.getByText(/No online agent available to proxy to this device/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/i })).not.toBeInTheDocument();
  });

  it('clarifies that linking is identity-only and does not control proxy', () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);
    expect(screen.getByText(/control proxy access/i)).toBeInTheDocument();
  });
});

describe('AssetDetailModal — proxy scheme + self-signed certificate (#1916)', () => {
  const onlineDevices = [{ id: 'dev-online', name: 'WS-101', online: true }];

  const assetWithHttpsPort: AssetDetail = {
    id: 'asset-https',
    ip: '192.168.1.100',
    mac: '—',
    hostname: 'printer-ilo',
    type: 'unknown',
    approvalStatus: 'pending',
    isOnline: true,
    manufacturer: '—',
    linkedDeviceId: null,
    openPorts: [{ port: 443, service: 'https' }],
    ...({ proxyEnabled: true } as Record<string, unknown>),
  };

  it('posts scheme + skipTlsVerify when self-signed allowed', async () => {
    fetchMock.mockResolvedValue(makeResponse({ id: 'tun-1' }));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AssetDetailModal open asset={assetWithHttpsPort} devices={onlineDevices} onClose={() => {}} />);

    fireEvent.change(screen.getByTestId('proxy-scheme-select'), { target: { value: 'https' } });
    fireEvent.click(screen.getByTestId('proxy-allow-self-signed'));
    fireEvent.click(screen.getByTestId('proxy-connect-btn'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/tunnels', expect.any(Object)));
    const call = fetchMock.mock.calls.find(c => c[0] === '/tunnels');
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toMatchObject({ type: 'proxy', scheme: 'https', skipTlsVerify: true });
    openSpy.mockRestore();
  });

  it('does not send skipTlsVerify:true when scheme is http', async () => {
    fetchMock.mockResolvedValue(makeResponse({ id: 'tun-2' }));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AssetDetailModal open asset={assetWithHttpsPort} devices={onlineDevices} onClose={() => {}} />);

    // Select http explicitly
    fireEvent.change(screen.getByTestId('proxy-scheme-select'), { target: { value: 'http' } });
    fireEvent.click(screen.getByTestId('proxy-connect-btn'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/tunnels', expect.any(Object)));
    const call = fetchMock.mock.calls.find(c => c[0] === '/tunnels');
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.scheme).toBe('http');
    expect(body.skipTlsVerify).toBe(false);
    openSpy.mockRestore();
  });

  it('shows self-signed checkbox only when scheme is https', async () => {
    render(<AssetDetailModal open asset={assetWithHttpsPort} devices={onlineDevices} onClose={() => {}} />);

    // Port 443 → default scheme is https → checkbox IS visible initially.
    const schemeSelect = screen.getByTestId('proxy-scheme-select');

    // Already on https; confirm checkbox visible, then switch to https explicitly
    // (no-op) to keep the assertion ordering consistent with the toggle test.
    fireEvent.change(schemeSelect, { target: { value: 'https' } });
    expect(screen.getByTestId('proxy-allow-self-signed')).toBeInTheDocument();

    // Switch to http → checkbox hidden
    fireEvent.change(schemeSelect, { target: { value: 'http' } });
    expect(screen.queryByTestId('proxy-allow-self-signed')).not.toBeInTheDocument();
  });

  it('defaults scheme to https when the selected port is 443', () => {
    render(<AssetDetailModal open asset={assetWithHttpsPort} devices={onlineDevices} onClose={() => {}} />);
    const schemeSelect = screen.getByTestId('proxy-scheme-select') as HTMLSelectElement;
    expect(schemeSelect.value).toBe('https');
  });
});

describe('AssetDetailModal — editable device type (#1424)', () => {
  const workstationAsset: AssetDetail = {
    ...asset,
    type: 'workstation',
    typeSource: 'auto',
  };

  const patchCallsFor = (id: string) =>
    fetchMock.mock.calls.filter(
      c => c[0] === `/discovery/assets/${id}` && (c[1] as RequestInit)?.method === 'PATCH'
    );

  it('saving with a changed type includes assetType in the PATCH body', async () => {
    const onUpdated = vi.fn();
    render(
      <AssetDetailModal open asset={workstationAsset} devices={devices} onClose={() => {}} onUpdated={onUpdated} />
    );

    fireEvent.change(screen.getByTestId('asset-modal-type-select'), { target: { value: 'switch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(patchCallsFor('asset-1').length).toBeGreaterThan(0);
    });
    const body = JSON.parse((patchCallsFor('asset-1')[0]![1] as RequestInit).body as string);
    expect(body.assetType).toBe('switch');
    expect(onUpdated).toHaveBeenCalledWith('asset-1');
  });

  it('saving WITHOUT changing the type omits assetType from the PATCH body', async () => {
    render(<AssetDetailModal open asset={workstationAsset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(patchCallsFor('asset-1').length).toBeGreaterThan(0);
    });
    const body = JSON.parse((patchCallsFor('asset-1')[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('assetType');
  });

  it('reset-to-auto control appears only when typeSource is manual', () => {
    const manualAsset: AssetDetail = {
      ...asset,
      type: 'switch',
      typeSource: 'manual',
      detectedType: 'workstation',
    };
    const { rerender } = render(
      <AssetDetailModal open asset={manualAsset} devices={devices} onClose={() => {}} />
    );
    expect(screen.getByTestId('asset-modal-type-reset')).toBeInTheDocument();

    const autoAsset: AssetDetail = { ...asset, type: 'switch', typeSource: 'auto' };
    rerender(<AssetDetailModal open asset={autoAsset} devices={devices} onClose={() => {}} />);
    expect(screen.queryByTestId('asset-modal-type-reset')).not.toBeInTheDocument();
  });

  it('reset control PATCHes resetTypeToAuto:true', async () => {
    const manualAsset: AssetDetail = {
      ...asset,
      type: 'switch',
      typeSource: 'manual',
      detectedType: 'workstation',
    };
    const onUpdated = vi.fn();
    render(
      <AssetDetailModal open asset={manualAsset} devices={devices} onClose={() => {}} onUpdated={onUpdated} />
    );

    fireEvent.click(screen.getByTestId('asset-modal-type-reset'));

    await waitFor(() => {
      expect(patchCallsFor('asset-1').length).toBeGreaterThan(0);
    });
    const body = JSON.parse((patchCallsFor('asset-1')[0]![1] as RequestInit).body as string);
    expect(body.resetTypeToAuto).toBe(true);
    expect(onUpdated).toHaveBeenCalledWith('asset-1');
  });
});

describe('AssetDetailModal — SNMP data card', () => {
  it('renders collected SNMP fields with friendly labels (#1731)', () => {
    const snmpAsset: AssetDetail = {
      ...asset,
      snmpData: { sysName: 'core-sw-01', sysDescr: 'Cisco IOS', sysObjectId: '1.3.6.1.4.1.9.1.1' },
    };
    render(<AssetDetailModal open asset={snmpAsset} devices={devices} onClose={() => {}} />);

    expect(screen.getByText('System Name')).toBeInTheDocument();
    expect(screen.getByText('core-sw-01')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Cisco IOS')).toBeInTheDocument();
    expect(screen.getByText('Object ID')).toBeInTheDocument();
    expect(screen.queryByText(/No SNMP data was collected/i)).not.toBeInTheDocument();
  });

  it('renders an unmapped SNMP OID key verbatim', () => {
    const snmpAsset: AssetDetail = {
      ...asset,
      snmpData: { sysContact: 'noc@example.com' },
    };
    render(<AssetDetailModal open asset={snmpAsset} devices={devices} onClose={() => {}} />);

    // Falls back to the raw key when not in SNMP_FIELD_LABELS.
    expect(screen.getByText('sysContact')).toBeInTheDocument();
    expect(screen.getByText('noc@example.com')).toBeInTheDocument();
  });

  it('shows a non-asserting empty-state when no SNMP data was collected', () => {
    // The blank card must not assert a definitive cause: discoveryMethods is a
    // "method that returned data" signal, not "method attempted", so we cannot
    // tell "not probed" from "probed, no response" (#1731 review).
    const blank: AssetDetail = { ...asset, snmpData: {} };
    render(<AssetDetailModal open asset={blank} devices={devices} onClose={() => {}} />);

    expect(screen.getByText(/No SNMP data was collected/i)).toBeInTheDocument();
  });
});
