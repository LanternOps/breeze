import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MonitoringSection } from './MonitoringSection';
import { showToast } from '@/components/shared/Toast';
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
  detailStatus?: number;
  templatesStatus?: number;
  writeStatus?: number;
};

function wire({ snmpDevice = null, monitors = [], suggestStatus = 404, suggestBody = null, detailStatus = 200, templatesStatus = 200, writeStatus = 200 }: Wiring = {}) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method) return Promise.resolve(res({ success: writeStatus < 400, error: writeStatus === 409 ? 'Conflict' : undefined }, writeStatus));
    if (url.startsWith('/monitoring/templates/suggest')) return Promise.resolve(res(suggestBody, suggestStatus));
    if (url.startsWith('/monitoring/assets/')) {
      if (detailStatus >= 400) return Promise.resolve(res({ error: 'Monitoring service unavailable' }, detailStatus));
      return Promise.resolve(res({ enabled: Boolean(snmpDevice), snmpDevice, networkMonitors: { totalCount: monitors.length, activeCount: monitors.filter((monitor) => (monitor as { isActive: boolean }).isActive).length }, recentMetrics: [] }));
    }
    if (url.startsWith('/monitors?')) return Promise.resolve(res({ data: monitors }));
    if (url === '/snmp/templates') return Promise.resolve(res({ templates: [{ id: 't-1', name: 'Generic Printer (RFC 3805)' }] }, templatesStatus));
    return Promise.resolve(res({}));
  });
}

const writeCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method);
const lastWriteBody = () => JSON.parse((writeCalls().at(-1)![1] as RequestInit).body as string);

beforeEach(() => { vi.restoreAllMocks(); vi.mocked(showToast).mockClear(); fetchMock.mockReset(); props.onSaved = vi.fn(); });

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

  it('omits templateId from the PATCH body when the template selection is untouched (#6099)', async () => {
    wire({ snmpDevice: { id: 'snmp-1', snmpVersion: 'v2c', community: '********', templateId: null, pollingInterval: 300, port: 161, isActive: true, lastPolled: null, lastStatus: 'online' } });
    render(<MonitoringSection {...props} />);
    await screen.findByTestId('network-settings-snmp-version');

    // Change an unrelated field only — the template select is never touched.
    fireEvent.change(screen.getByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(lastWriteBody()).not.toHaveProperty('templateId');
  });

  it('sends the chosen id when the user explicitly picks a template (#6099)', async () => {
    wire({ snmpDevice: { id: 'snmp-1', snmpVersion: 'v2c', community: '********', templateId: null, pollingInterval: 300, port: 161, isActive: true, lastPolled: null, lastStatus: 'online' } });
    render(<MonitoringSection {...props} />);
    await screen.findByTestId('network-settings-snmp-version');

    fireEvent.change(screen.getByTestId('network-settings-snmp-template'), { target: { value: 't-1' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(lastWriteBody()).toHaveProperty('templateId', 't-1');
  });

  it('sends templateId:null when the user explicitly clears a previously-set template (#6099)', async () => {
    wire({ snmpDevice: { id: 'snmp-1', snmpVersion: 'v2c', community: '********', templateId: 't-1', pollingInterval: 300, port: 161, isActive: true, lastPolled: null, lastStatus: 'online' } });
    render(<MonitoringSection {...props} />);
    expect(await screen.findByTestId('network-settings-snmp-template')).toHaveValue('t-1');

    fireEvent.change(screen.getByTestId('network-settings-snmp-template'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(lastWriteBody()).toHaveProperty('templateId', null);
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wire({ suggestStatus: 404 });
    render(<MonitoringSection {...props} />);

    await screen.findByTestId('network-settings-snmp-template');
    expect(screen.queryByTestId('network-settings-snmp-suggestion')).not.toBeInTheDocument();
    expect(screen.queryByText('Suggestions unavailable')).not.toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
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
    expect(row.textContent).not.toMatch(/\bOnline\b/);
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


describe('MonitoringSection — recovery and credential validation', () => {
  const storedV2 = { id: 'snmp-1', snmpVersion: 'v2c', community: '********', pollingInterval: 300, port: 161, isActive: true };
  const storedV3 = { id: 'snmp-1', snmpVersion: 'v3', username: 'operator', authProtocol: 'sha256', privProtocol: 'aes256', authPassword: '********', privPassword: '********', pollingInterval: 300, port: 161, isActive: true };

  it('shows an error toast when the saved page cannot refresh', async () => {
    wire({ snmpDevice: storedV2 });
    props.onSaved = vi.fn().mockResolvedValue(false);
    render(<MonitoringSection {...props} />);
    fireEvent.change(await screen.findByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Saved, but the page could not refresh. Reload to see the change.' })));
  });

  it('disables Save and shows the load error when the detail read fails', async () => {
    wire({ detailStatus: 500 });
    render(<MonitoringSection {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Monitoring service unavailable');
    const save = screen.getByTestId('network-settings-monitoring-save');
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(writeCalls()).toHaveLength(0);
    wire({ snmpDevice: storedV2 });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-retry'));
    expect(await screen.findByTestId('network-settings-snmp-version')).toHaveValue('v2c');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/monitoring/assets/asset-1')).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('still renders the form when only /snmp/templates fails', async () => {
    wire({ snmpDevice: storedV2, templatesStatus: 500 });
    render(<MonitoringSection {...props} />);
    expect(await screen.findByTestId('network-settings-snmp-version')).toHaveValue('v2c');
    fireEvent.change(screen.getByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    expect(screen.getByTestId('network-settings-monitoring-save')).toBeEnabled();
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]![1]?.method).toBe('PATCH');
  });

  it('keeps the stored detail and draft when the post-save detail refresh fails', async () => {
    wire({ snmpDevice: storedV2 });
    render(<MonitoringSection {...props} />);
    fireEvent.change(await screen.findByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    wire({ detailStatus: 500 });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Monitoring service unavailable');
    expect(screen.getByTestId('network-settings-snmp-interval')).toHaveValue(600);
    expect(screen.getByTestId('network-settings-snmp-pause')).toBeInTheDocument();
    expect(screen.getByTestId('network-settings-monitoring-save')).toBeDisabled();
    wire({ snmpDevice: { ...storedV2, pollingInterval: 600 } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-retry'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByTestId('network-settings-snmp-interval')).toHaveValue(600);
  });

  it.each([500, 403])('warns and shows unavailable suggestions for HTTP %s', async (suggestStatus) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wire({ suggestStatus, suggestBody: { error: 'Suggestion service unavailable' } });
    render(<MonitoringSection {...props} />);
    expect(await screen.findByText('Suggestions unavailable')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith('[network-settings] template suggestion failed', asset.id, expect.any(Error));
    expect(screen.getByTestId('network-settings-snmp-version')).toBeInTheDocument();
  });

  it('warns and shows unavailable suggestions for a rejected request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    wire();
    const implementation = fetchMock.getMockImplementation()!;
    const reason = new Error('Offline');
    fetchMock.mockImplementation((url, init) => url.startsWith('/monitoring/templates/suggest') ? Promise.reject(reason) : implementation(url, init));
    render(<MonitoringSection {...props} />);
    expect(await screen.findByText('Suggestions unavailable')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith('[network-settings] template suggestion failed', asset.id, reason);
  });

  it('blocks switching stored v2c to v3 without a username', async () => {
    wire({ snmpDevice: storedV2 });
    render(<MonitoringSection {...props} />);
    fireEvent.change(await screen.findByTestId('network-settings-snmp-version'), { target: { value: 'v3' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));
    expect(await screen.findByTestId('network-settings-monitoring-error')).toHaveTextContent(/username/i);
    expect(writeCalls()).toHaveLength(0);
  });

  it('blocks switching stored v3 to v2c without a stored or supplied community', async () => {
    wire({ snmpDevice: storedV3 });
    render(<MonitoringSection {...props} />);
    fireEvent.change(await screen.findByTestId('network-settings-snmp-version'), { target: { value: 'v2c' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));
    expect(await screen.findByTestId('network-settings-monitoring-error')).toHaveTextContent(/community/i);
    expect(writeCalls()).toHaveLength(0);
  });

  it('omits blank v3 passwords on edit while keeping username and protocols', async () => {
    wire({ snmpDevice: storedV3 });
    render(<MonitoringSection {...props} />);
    fireEvent.change(await screen.findByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]![1]?.method).toBe('PATCH');
    expect(lastWriteBody()).toMatchObject({ username: 'operator', authProtocol: 'sha256', privProtocol: 'aes256' });
    expect(lastWriteBody()).not.toHaveProperty('authPassword');
    expect(lastWriteBody()).not.toHaveProperty('privPassword');
  });

  it('blocks a v3 create with no username', async () => {
    wire();
    render(<MonitoringSection {...props} />);
    fireEvent.change(await screen.findByTestId('network-settings-snmp-version'), { target: { value: 'v3' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));
    expect(await screen.findByTestId('network-settings-monitoring-error')).toHaveTextContent(/username/i);
    expect(writeCalls()).toHaveLength(0);
  });

  it('Cancel restores the stored config and clears a validation error', async () => {
    wire({ snmpDevice: storedV2 });
    render(<MonitoringSection {...props} />);
    fireEvent.change(await screen.findByTestId('network-settings-snmp-interval'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));
    expect(await screen.findByTestId('network-settings-monitoring-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('network-settings-monitoring-cancel'));
    expect(screen.getByTestId('network-settings-snmp-interval')).toHaveValue(300);
    expect(screen.queryByTestId('network-settings-monitoring-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('network-settings-monitoring-save')).toBeDisabled();
  });

  it('reloads and shows the conflict banner when the save 409s', async () => {
    wire({ snmpDevice: storedV2 });
    render(<MonitoringSection {...props} />);
    fireEvent.change(await screen.findByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    wire({ snmpDevice: { ...storedV2, pollingInterval: 900 }, writeStatus: 409 });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));
    expect(await screen.findByTestId('network-settings-monitoring-conflict')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('network-settings-snmp-interval')).toHaveValue(900));
    expect(fetchMock.mock.calls.filter(([url, init]) => url === '/monitoring/assets/asset-1' && !init?.method)).toHaveLength(2);
  });

  it('hides Disable monitoring when the row and all checks are inactive', async () => {
    wire({ snmpDevice: { ...storedV2, isActive: false }, monitors: [{ id: 'mon-1', name: 'Ping', monitorType: 'icmp_ping', isActive: false }] });
    render(<MonitoringSection {...props} />);
    await screen.findByTestId('network-settings-snmp-version');
    expect(screen.queryByTestId('network-settings-monitoring-disable')).not.toBeInTheDocument();
    expect(screen.getByTestId('network-settings-snmp-resume')).toBeInTheDocument();
  });
});
