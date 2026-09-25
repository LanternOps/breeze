import '@/lib/i18n';

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

beforeEach(() => {
  fetchMock.mockReset();
  // A stray request must resolve so the no-fetch assertions can report it.
  fetchMock.mockResolvedValue(makeResponse());
});

// #3261: identity linking is now hidden-and-automatic — the modal lost its
// device picker (Task 4) after the earlier #3199 plan removed the Proxy
// Access picker from this same modal. All linking/unlinking now happens on
// the network device page (NetworkDeviceDetailPage), the single override
// surface.
describe('AssetDetailModal — read-only link state (#3261)', () => {
  it('renders no link picker, select, or link/unlink buttons for an unlinked asset', () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);

    expect(screen.queryByTestId('asset-modal-link-select')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link asset' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-modal-unlink')).not.toBeInTheDocument();
    expect(screen.queryByText('Link to managed device')).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-modal-same-device-link')).not.toBeInTheDocument();
  });

  it('renders no link picker, select, or link/unlink buttons for a linked asset either', () => {
    const linked: AssetDetail = { ...asset, linkedDeviceId: 'dev-1', linkedDeviceName: 'WS-FRONTDESK', linkSource: 'manual' };
    render(<AssetDetailModal open asset={linked} onClose={() => {}} />);

    expect(screen.queryByTestId('asset-modal-link-select')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link asset' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-modal-unlink')).not.toBeInTheDocument();
  });

  it('renders a read-only "Same device as {name}" line linking to the device when linked', () => {
    const linked: AssetDetail = { ...asset, linkedDeviceId: 'dev-1', linkedDeviceName: 'WS-FRONTDESK', linkSource: 'auto' };
    render(<AssetDetailModal open asset={linked} onClose={() => {}} />);

    const link = screen.getByTestId('asset-modal-same-device-link');
    expect(link).toHaveTextContent('Same device as WS-FRONTDESK');
    expect(link.getAttribute('href')).toBe('/devices/dev-1');
  });

  it('falls back to a generic name when the linked device has none', () => {
    const linked: AssetDetail = { ...asset, linkedDeviceId: 'dev-1', linkedDeviceName: undefined, linkSource: 'auto' };
    render(<AssetDetailModal open asset={linked} onClose={() => {}} />);

    expect(screen.getByTestId('asset-modal-same-device-link')).toHaveTextContent('Same device as');
  });

  it('renders nothing for the link state when unlinked', () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);

    expect(screen.queryByTestId('asset-modal-same-device-link')).not.toBeInTheDocument();
    expect(screen.queryByText(/Same device as/)).not.toBeInTheDocument();
  });

  it('never issues a /discovery/assets/:id/link request on mount or interaction', async () => {
    const linked: AssetDetail = { ...asset, linkedDeviceId: 'dev-1', linkedDeviceName: 'WS-FRONTDESK', linkSource: 'manual' };
    render(<AssetDetailModal open asset={linked} onClose={() => {}} />);

    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    expect(
      fetchMock.mock.calls.some(([url]) => typeof url === 'string' && url.endsWith('/link'))
    ).toBe(false);
  });

  it('keeps the discovery preview BMC association distinct from a same-device link', () => {
    render(<AssetDetailModal open asset={{ ...asset, linkedDeviceId: 'dev-1',
      linkedDeviceName: 'agent-host', linkSource: 'agent_report' }} onClose={() => {}} />);
    const link = screen.getByTestId('asset-modal-same-device-link');
    expect(link).toHaveAttribute('href', '/devices/dev-1');
    expect(link).toHaveTextContent('Management controller for agent-host');
    expect(link).not.toHaveTextContent('Same device as');
    expect(screen.getByTestId('asset-modal-link-provenance')).toHaveTextContent('reported by host agent');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AssetDetailModal — SNMP data card', () => {
  it('renders collected SNMP fields with friendly labels (#1731)', () => {
    const snmpAsset: AssetDetail = {
      ...asset,
      snmpData: { sysName: 'core-sw-01', sysDescr: 'Cisco IOS', sysObjectId: '1.3.6.1.4.1.9.1.1' },
    };
    render(<AssetDetailModal open asset={snmpAsset} onClose={() => {}} />);

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
    render(<AssetDetailModal open asset={snmpAsset} onClose={() => {}} />);

    // Falls back to the raw key when not in SNMP_FIELD_LABELS.
    expect(screen.getByText('sysContact')).toBeInTheDocument();
    expect(screen.getByText('noc@example.com')).toBeInTheDocument();
  });

  it('shows a non-asserting empty-state when no SNMP data was collected', () => {
    // The blank card must not assert a definitive cause: discoveryMethods is a
    // "method that returned data" signal, not "method attempted", so we cannot
    // tell "not probed" from "probed, no response" (#1731 review).
    const blank: AssetDetail = { ...asset, snmpData: {} };
    render(<AssetDetailModal open asset={blank} onClose={() => {}} />);

    expect(screen.getByText(/No SNMP data was collected/i)).toBeInTheDocument();
  });
});

describe('AssetDetailModal — read-only peek (W04)', () => {
  it('renders no editable control at all', () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);

    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-modal-type-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-modal-type-reset')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Asset/i })).not.toBeInTheDocument();
  });

  it('issues no mutating request on mount or on any click', async () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);

    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    await waitFor(() => expect(true).toBe(true));

    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method)).toEqual([]);
  });

  it('hands off to the device page and to its settings modal', () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);

    expect(screen.getByTestId('asset-modal-open-device-page').getAttribute('href'))
      .toBe('/devices/network/asset-1');
    expect(screen.getByTestId('asset-modal-settings').getAttribute('href'))
      .toBe('/devices/network/asset-1#overview/settings/identity');
  });

  it('no longer mounts the monitoring section (no /monitoring or /monitors fetch)', async () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);
    await waitFor(() => expect(true).toBe(true));

    expect(fetchMock.mock.calls.some(([url]) =>
      typeof url === 'string' && (url.startsWith('/monitoring') || url.startsWith('/monitors')))).toBe(false);
  });
});

describe('AssetDetailModal — reachability line never says a bare "Online"', () => {
  it('names the source and the age when the API supplies reachability (W01)', () => {
    render(
      <AssetDetailModal
        open
        asset={{
          ...asset,
          reachability: {
            state: 'responding',
            source: 'snmp',
            observedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            lastKnown: null,
          },
        }}
        onClose={() => {}}
      />,
    );

    const line = screen.getByTestId('asset-modal-reachability');
    expect(line.textContent).toMatch(/Responding · SNMP/);
    expect(line.textContent).not.toBe('Online');
  });

  it('falls back to the scan sighting on a pre-W01 API, still sourced', () => {
    render(
      <AssetDetailModal
        open
        asset={{ ...asset, lastSeen: new Date(Date.now() - 19 * 3600_000).toISOString() }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId('asset-modal-reachability').textContent).toMatch(/Last seen · scan/);
  });

  it('renders an explicit unknown when there is nothing to source', () => {
    render(<AssetDetailModal open asset={{ ...asset, lastSeen: undefined }} onClose={() => {}} />);

    const line = screen.getByTestId('asset-modal-reachability');
    expect(line).toHaveTextContent('—');
    expect(line).toHaveAttribute('aria-label', 'unknown');
  });
});
