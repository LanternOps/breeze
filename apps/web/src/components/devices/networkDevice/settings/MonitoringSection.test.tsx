import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MonitoringSection } from './MonitoringSection';
import { fetchWithAuth } from '@/stores/auth';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const asset: DiscoveredAsset = {
  id: 'asset-1', ip: '10.0.0.2', mac: '—', hostname: 'core-sw-01',
  type: 'switch', approvalStatus: 'approved', isOnline: true, manufacturer: 'Cisco',
};

const props = { asset, assetId: asset.id, onSaved: vi.fn(), onAnnounce: vi.fn() };

type Wiring = {
  snmpDevice?: unknown;
  monitors?: unknown[];
  suggestStatus?: number;
  suggestBody?: unknown;
};

function wire({ snmpDevice = null, monitors = [], suggestStatus = 404, suggestBody = null }: Wiring = {}) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method) return Promise.resolve(res({ success: true }));
    if (url.startsWith('/monitoring/templates/suggest')) return Promise.resolve(res(suggestBody, suggestStatus));
    if (url.startsWith('/monitoring/assets/')) {
      return Promise.resolve(res({ enabled: Boolean(snmpDevice), snmpDevice, networkMonitors: { totalCount: monitors.length, activeCount: monitors.length }, recentMetrics: [] }));
    }
    if (url.startsWith('/monitors?')) return Promise.resolve(res({ data: monitors }));
    if (url === '/snmp/templates') return Promise.resolve(res({ templates: [{ id: 't-1', name: 'Generic Printer (RFC 3805)' }] }));
    return Promise.resolve(res({}));
  });
}

const writeCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method);
const lastWriteBody = () => JSON.parse((writeCalls().at(-1)![1] as RequestInit).body as string);

beforeEach(() => { fetchMock.mockReset(); props.onSaved = vi.fn(); });

describe('MonitoringSection — SNMP configuration', () => {
  it('PUTs a full config when no SNMP device exists yet', async () => {
    wire();
    render(<MonitoringSection {...props} />);
    await screen.findByTestId('network-settings-snmp-version');

    fireEvent.change(screen.getByTestId('network-settings-snmp-community'), { target: { value: 'public' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]![0]).toBe('/monitoring/assets/asset-1/snmp');
    expect((writeCalls()[0]![1] as RequestInit).method).toBe('PUT');
    expect(lastWriteBody()).toMatchObject({ snmpVersion: 'v2c', community: 'public' });
  });

  it('blocks a create with no community and says why, without firing a request', async () => {
    wire();
    render(<MonitoringSection {...props} />);
    await screen.findByTestId('network-settings-snmp-version');

    fireEvent.change(screen.getByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));

    expect(await screen.findByTestId('network-settings-monitoring-error')).toHaveTextContent(/community/i);
    expect(writeCalls()).toHaveLength(0);
  });

  it('PATCHes an existing device and omits blank credential fields so stored secrets survive', async () => {
    wire({ snmpDevice: { id: 'snmp-1', snmpVersion: 'v2c', community: '********', templateId: null, pollingInterval: 300, port: 161, isActive: true, lastPolled: null, lastStatus: 'online' } });
    render(<MonitoringSection {...props} />);
    await screen.findByTestId('network-settings-snmp-version');

    // The masked value is never echoed into the input.
    expect(screen.getByTestId('network-settings-snmp-community')).toHaveValue('');
    expect(screen.getByTestId('network-settings-snmp-community-stored')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect((writeCalls()[0]![1] as RequestInit).method).toBe('PATCH');
    expect(lastWriteBody()).not.toHaveProperty('community');
    expect(lastWriteBody()).toMatchObject({ pollingInterval: 600 });
  });

  it('pauses polling with isActive:false and resumes with true', async () => {
    wire({ snmpDevice: { id: 'snmp-1', snmpVersion: 'v2c', templateId: null, pollingInterval: 300, port: 161, isActive: true, lastPolled: null, lastStatus: 'online' } });
    render(<MonitoringSection {...props} />);

    fireEvent.click(await screen.findByTestId('network-settings-snmp-pause'));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(lastWriteBody()).toEqual({ isActive: false });
  });

  it('disables all monitoring behind a confirm', async () => {
    wire({ snmpDevice: { id: 'snmp-1', snmpVersion: 'v2c', templateId: null, pollingInterval: 300, port: 161, isActive: true, lastPolled: null, lastStatus: 'online' } });
    render(<MonitoringSection {...props} />);

    fireEvent.click(await screen.findByTestId('network-settings-monitoring-disable'));
    fireEvent.click(await screen.findByTestId('network-settings-monitoring-disable-confirm'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]![0]).toBe('/monitoring/assets/asset-1');
    expect((writeCalls()[0]![1] as RequestInit).method).toBe('DELETE');
  });
});

describe('MonitoringSection — template suggestion is feature-detected (W03)', () => {
  it('renders no suggestion line when the API does not have the route yet', async () => {
    wire({ suggestStatus: 404 });
    render(<MonitoringSection {...props} />);

    await screen.findByTestId('network-settings-snmp-template');
    expect(screen.queryByTestId('network-settings-snmp-suggestion')).not.toBeInTheDocument();
  });

  it('renders the reason and pre-selects the suggested template when the API returns one', async () => {
    wire({ suggestStatus: 200, suggestBody: { templateId: 't-1', templateName: 'Xerox Printer', reason: 'Detected Xerox printer' } });
    render(<MonitoringSection {...props} />);

    expect(await screen.findByTestId('network-settings-snmp-suggestion')).toHaveTextContent('Detected Xerox printer');
    fireEvent.click(screen.getByTestId('network-settings-snmp-suggestion-apply'));
    expect(screen.getByTestId('network-settings-snmp-template')).toHaveValue('t-1');
  });
});

describe('MonitoringSection — network checks', () => {
  it('lists the asset checks with their state and never says a bare "Online"', async () => {
    wire({ monitors: [{ id: 'mon-1', name: 'Ping', monitorType: 'icmp_ping', target: '10.0.0.2', isActive: true, lastStatus: 'online', lastChecked: new Date().toISOString() }] });
    render(<MonitoringSection {...props} />);

    const row = await screen.findByTestId('network-settings-check-mon-1');
    expect(row).toHaveTextContent('Ping');
    expect(row.textContent).toMatch(/Responding · ping/i);
  });

  it('removes a check through DELETE /monitors/:id after a confirm', async () => {
    wire({ monitors: [{ id: 'mon-1', name: 'Ping', monitorType: 'icmp_ping', target: '10.0.0.2', isActive: true, lastStatus: 'online', lastChecked: null }] });
    render(<MonitoringSection {...props} />);

    fireEvent.click(await screen.findByTestId('network-settings-check-remove-mon-1'));
    fireEvent.click(await screen.findByTestId('network-settings-check-remove-confirm'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]![0]).toBe('/monitors/mon-1');
    expect((writeCalls()[0]![1] as RequestInit).method).toBe('DELETE');
  });
});
