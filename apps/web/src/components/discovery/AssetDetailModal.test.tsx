import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// #3199: the old "Enable Proxy Access" / bridge-picker / scheme / self-signed
// UI (formerly here) is deleted in favor of a single link to the network
// device page, which now owns the per-port "Open Web UI" popover.
describe('AssetDetailModal — proxy access consolidated to network device page (#3199)', () => {
  it('renders no proxy enable/connect controls', () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    expect(screen.queryByText('Enable Proxy Access')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proxy-bridge-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proxy-scheme-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proxy-allow-self-signed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proxy-connect-btn')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/i })).not.toBeInTheDocument();
  });

  it('renders a link to the network device page instead', () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    const link = screen.getByTestId('asset-modal-proxy-link');
    expect(link.getAttribute('href')).toBe(`/devices/network/${asset.id}`);
    expect(link.textContent).toContain('Manage proxy access on the network device page');
  });

  it('never issues a /tunnels or /tunnels/allowlist request on mount or interaction', async () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    await waitFor(() => {
      // AssetMonitoringSection's own mount fetch has resolved; give any
      // stray proxy-section effect a chance to have fired too.
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(
      fetchMock.mock.calls.some(([url]) => url === '/tunnels' || url === '/tunnels/allowlist'),
    ).toBe(false);
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

describe('AssetDetailModal — server error surfaced on save/reset (#1424)', () => {
  const manualAsset: AssetDetail = {
    ...asset,
    type: 'switch',
    typeSource: 'manual',
    detectedType: 'workstation',
  };

  const failPatchWith = (body: unknown) => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/discovery/assets/asset-1' && init?.method === 'PATCH') {
        return Promise.resolve(makeResponse(body, false));
      }
      return Promise.resolve(makeResponse());
    });
  };

  it('surfaces the server error message when saving fails', async () => {
    failPatchWith({ error: 'Asset not found' });
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Asset not found')).toBeInTheDocument();
  });

  it('surfaces the server error message when resetting type fails', async () => {
    failPatchWith({ error: 'Asset not found' });
    render(<AssetDetailModal open asset={manualAsset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('asset-modal-type-reset'));

    expect(await screen.findByText('Asset not found')).toBeInTheDocument();
  });

  // Legacy pre-#2201 shape: @hono/zod-validator's default 400 hook emitted the
  // bare ZodError object as `error`. zod v4 hides `issues` from JSON.stringify,
  // so the wire shape is {name:'ZodError', message:'<stringified issues>'} —
  // the exact body behind the "[object Object]" report in #2198. Kept as a
  // regression test for older deployed APIs.
  const zodErrorBody = {
    success: false,
    error: {
      name: 'ZodError',
      message: JSON.stringify([
        { message: 'Invalid input: expected string, received null', path: ['label'] }
      ])
    }
  };

  it('renders readable validation text, not [object Object], when save returns a ZodError body (#2198)', async () => {
    failPatchWith(zodErrorBody);
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/Invalid input: expected string, received null/)
    ).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
  });

  it('renders readable validation text, not [object Object], when reset-type returns a ZodError body (#2198)', async () => {
    failPatchWith(zodErrorBody);
    render(<AssetDetailModal open asset={manualAsset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('asset-modal-type-reset'));

    expect(
      await screen.findByText(/Invalid input: expected string, received null/)
    ).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
  });

  it('falls back to the generic message when the error body has no error field', async () => {
    failPatchWith({});
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Failed to save asset info')).toBeInTheDocument();
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
import '@/lib/i18n';
