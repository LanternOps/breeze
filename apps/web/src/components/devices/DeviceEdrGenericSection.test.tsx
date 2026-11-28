import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HttpError } from '@/lib/httpError';

const fetchEdrEndpoints = vi.fn();
const fetchEdrDetections = vi.fn();
const fetchEdrActions = vi.fn().mockResolvedValue([]);
const requestEdrEndpointAction = vi.fn();
vi.mock('@/lib/edrProviders', () => ({
  fetchEdrEndpoints: (...a: unknown[]) => fetchEdrEndpoints(...a),
  fetchEdrDetections: (...a: unknown[]) => fetchEdrDetections(...a),
  fetchEdrActions: (...a: unknown[]) => fetchEdrActions(...a),
  requestEdrEndpointAction: (...a: unknown[]) => requestEdrEndpointAction(...a),
  edrProviderLabel: (k: string) => (k === 'bitdefender' ? 'Bitdefender GravityZone' : null),
}));

import DeviceEdrGenericSection from './DeviceEdrGenericSection';

const coverage = { orgsWithEdr: 1, partial: false, notes: [] as string[] };

function endpoint(id: string, over: Record<string, unknown> = {}) {
  return {
    id, orgId: 'org-1', connectionId: 'conn-1', tenantId: 't1', tenantName: 'Acme Co',
    provider: 'bitdefender', vendorEndpointId: `v-${id}`, hostname: 'h', fqdn: null,
    osPlatform: 'windows', osName: 'Windows 11', agentVersion: '7.9.1', health: 'healthy',
    online: true, isolationState: 'not_isolated', lastSeenAt: '2026-10-01T10:00:00Z',
    breezeDeviceId: 'dev-1', deviceMatchSource: 'auto_hostname', ...over,
  };
}

function detection(id: string, over: Record<string, unknown> = {}) {
  return {
    id, orgId: 'org-1', provider: 'bitdefender', providerLabel: 'Bitdefender GravityZone',
    vendorDetectionId: `vd-${id}`, vendorKind: 'detection', severity: 'high', status: 'open',
    title: 'A title', category: null, threatName: 'Trojan.Gen', filePath: null, processName: null,
    mitreTechniques: [], detectedAt: '2026-10-02T10:00:00Z', resolvedAt: null,
    endpointId: null, breezeDeviceId: 'dev-1', deviceName: 'h', detached: false,
    promotedIncidentId: null, ...over,
  };
}

function page(rows: unknown[], cov = coverage) {
  return { rows, total: rows.length, limit: 50, offset: 0, coverage: cov };
}

beforeEach(() => {
  fetchEdrEndpoints.mockReset();
  fetchEdrDetections.mockReset();
});

describe('DeviceEdrGenericSection', () => {
  it('renders nothing when there are no linked endpoints and no open detections', async () => {
    fetchEdrEndpoints.mockResolvedValue([]);
    fetchEdrDetections.mockResolvedValue(page([]));
    const { container } = render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    await waitFor(() => expect(fetchEdrDetections).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
    expect(fetchEdrEndpoints).toHaveBeenCalledWith({ deviceId: 'dev-1', state: 'linked' });
    expect(fetchEdrDetections).toHaveBeenCalledWith({ deviceId: 'dev-1', orgId: 'org-1', status: 'open', limit: 50 });
  });

  it('renders one card per linked endpoint', async () => {
    fetchEdrEndpoints.mockResolvedValue([endpoint('e1'), endpoint('e2', { provider: 'other', connectionId: 'c2' })]);
    fetchEdrDetections.mockResolvedValue(page([]));
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByTestId('device-edr-endpoint-e1')).toBeInTheDocument();
    expect(screen.getByTestId('device-edr-endpoint-e2')).toBeInTheDocument();
    expect(screen.getAllByText('Bitdefender GravityZone').length).toBeGreaterThan(0);
    expect(screen.queryByTestId(/device-edr-duplicate-/)).toBeNull();
  });

  it('shows a missing last-seen time as unknown (#12821)', async () => {
    fetchEdrEndpoints.mockResolvedValue([endpoint('e1', { lastSeenAt: null })]);
    fetchEdrDetections.mockResolvedValue(page([]));
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByTestId('device-edr-last-seen-e1')).toHaveTextContent(/^Unknown$/);
  });

  // #12825: for a provider whose list does not refresh health / online, they are as of the last
  // details read. Past the freshness bound they are shown as not verified, never as healthy.
  it('#12825: health and status past the freshness bound show as not verified, with the time they were read', async () => {
    fetchEdrEndpoints.mockResolvedValue([
      endpoint('stale', { stateStale: true, vendorDetailSyncedAt: '2026-09-20T10:00:00Z' }),
      endpoint('fresh', { stateStale: false, vendorDetailSyncedAt: '2026-10-01T09:00:00Z' }),
    ]);
    fetchEdrDetections.mockResolvedValue(page([]));
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" timezone="UTC" />);
    const staleHealth = await screen.findByTestId('device-edr-health-stale');
    expect(staleHealth).toHaveTextContent('Not recently verified');
    expect(staleHealth).not.toHaveTextContent('Healthy');
    expect(screen.getByTestId('device-edr-status-stale')).toHaveTextContent(/^Unknown$/);
    expect(screen.getByTestId('device-edr-state-as-of-stale')).toHaveTextContent(/^as of .*2026/);
    expect(screen.getByTestId('device-edr-health-fresh')).toHaveTextContent('Healthy');
    expect(screen.getByTestId('device-edr-status-fresh')).toHaveTextContent(/^Online$/);
    expect(screen.getByTestId('device-edr-state-as-of-fresh')).toHaveTextContent(/^as of .*2026/);
  });

  it('#12825: a row from an API without the freshness fields shows health as before, with no time', async () => {
    fetchEdrEndpoints.mockResolvedValue([endpoint('e1')]);
    fetchEdrDetections.mockResolvedValue(page([]));
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByTestId('device-edr-health-e1')).toHaveTextContent(/^Healthy$/);
    expect(screen.queryByTestId('device-edr-state-as-of-e1')).toBeNull();
  });

  it('warns when the same provider is linked through two connections', async () => {
    fetchEdrEndpoints.mockResolvedValue([endpoint('e1'), endpoint('e2', { connectionId: 'conn-2' })]);
    fetchEdrDetections.mockResolvedValue(page([]));
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByTestId('device-edr-duplicate-bitdefender')).toBeInTheDocument();
  });

  it('renders no buttons', async () => {
    fetchEdrEndpoints.mockResolvedValue([endpoint('e1')]);
    fetchEdrDetections.mockResolvedValue(page([detection('d1')]));
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    await screen.findByTestId('device-edr-endpoint-e1');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders open detections, grouped under the matching endpoint', async () => {
    fetchEdrEndpoints.mockResolvedValue([endpoint('e1')]);
    fetchEdrDetections.mockResolvedValue(
      page([detection('d1', { endpointId: 'e1' }), detection('d2', { threatName: null, title: 'Loose title' })]),
    );
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    const d1 = await screen.findByTestId('device-edr-detection-d1');
    expect(screen.getByTestId('device-edr-endpoint-e1')).toContainElement(d1);
    const d2 = screen.getByTestId('device-edr-detection-d2');
    expect(screen.getByTestId('device-edr-endpoint-e1')).not.toContainElement(d2);
    expect(d1).toHaveTextContent('Trojan.Gen');
    expect(d2).toHaveTextContent('Loose title');
  });

  it('renders detections even with no linked endpoints, and shows partial coverage notes', async () => {
    fetchEdrEndpoints.mockResolvedValue([]);
    fetchEdrDetections.mockResolvedValue(
      page([detection('d1')], { orgsWithEdr: 1, partial: true, notes: ['One console has not synced yet.'] }),
    );
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByTestId('device-edr-detection-d1')).toBeInTheDocument();
    expect(screen.getByText('One console has not synced yet.')).toBeInTheDocument();
  });

  it('renders nothing when both requests are denied (403)', async () => {
    fetchEdrEndpoints.mockRejectedValue(new HttpError(403, 'Forbidden'));
    fetchEdrDetections.mockRejectedValue(new HttpError(403, 'Forbidden'));
    const { container } = render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    await waitFor(() => expect(fetchEdrEndpoints).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('#12789: after an action is requested the endpoint list is re-read, so the button reflects the in-flight row', async () => {
    const reason = 'This action is already in progress for this target';
    fetchEdrEndpoints
      .mockResolvedValueOnce([endpoint('e1', { actions: [{ action: 'scan', available: true, reason: null }] })])
      .mockResolvedValueOnce([endpoint('e1', { actions: [{ action: 'scan', available: false, reason }] })]);
    fetchEdrDetections.mockResolvedValue(page([]));
    requestEdrEndpointAction.mockResolvedValue({ data: [{ endpointId: 'e1', actionId: 'a1', status: 'queued' }] });
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('edr-action-scan'));
    await waitFor(() => expect(fetchEdrEndpoints).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('edr-action-scan')).toBeDisabled());
    expect(screen.getByTestId('edr-action-scan')).toHaveAttribute('title', reason);
    // The card stays mounted while it refreshes (no loading flash).
    expect(screen.getByTestId('device-edr-endpoint-e1')).toBeInTheDocument();
  });

  it('shows a non-alarming error line on a non-403 failure', async () => {
    fetchEdrEndpoints.mockRejectedValue(new HttpError(500, 'Server Error'));
    fetchEdrDetections.mockResolvedValue(page([]));
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByTestId('device-edr-generic-error')).toBeInTheDocument();
  });
});
