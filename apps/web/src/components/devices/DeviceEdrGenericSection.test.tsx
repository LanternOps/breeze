import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HttpError } from '@/lib/httpError';

const fetchEdrEndpoints = vi.fn();
const fetchEdrDetections = vi.fn();
const fetchEdrActions = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/edrProviders', () => ({
  fetchEdrEndpoints: (...a: unknown[]) => fetchEdrEndpoints(...a),
  fetchEdrDetections: (...a: unknown[]) => fetchEdrDetections(...a),
  fetchEdrActions: (...a: unknown[]) => fetchEdrActions(...a),
  requestEdrEndpointAction: vi.fn(),
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

  it('shows a non-alarming error line on a non-403 failure', async () => {
    fetchEdrEndpoints.mockRejectedValue(new HttpError(500, 'Server Error'));
    fetchEdrDetections.mockResolvedValue(page([]));
    render(<DeviceEdrGenericSection deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByTestId('device-edr-generic-error')).toBeInTheDocument();
  });
});
