import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AssetCircuitCard from './AssetCircuitCard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const canMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: canMock }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const ID = '22222222-2222-2222-2222-222222222222';
const IF1 = '33333333-3333-3333-3333-333333333333';
const IF2 = '44444444-4444-4444-4444-444444444444';

function res(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function circuit(over: Record<string, unknown> = {}) {
  return {
    id: 'c1', orgId: 'o1', providerName: 'Acme Telecom', cid: 'CID-001',
    bandwidthBps: 500_000_000, serviceType: 'DIA', administrativeStatus: 'active',
    terminationState: 'assigned',
    termination: {
      interfaceId: IF1, interfaceName: 'wan1',
      asset: { kind: 'device', id: ID, label: 'EDGE-01' },
      primarySite: { id: 's1', name: 'HQ' }, placement: null,
    },
    additionalServedSites: [{ id: 's2', name: 'Branch A' }],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function payload(over: Record<string, unknown> = {}) {
  return {
    subject: { kind: 'device', id: ID, orgId: 'o1', siteId: 's1' },
    topology: { bound: true },
    capabilities: { interfacesVisible: true, wanRoleWritable: true },
    interfaces: [
      { id: IF1, name: 'wan1', kind: 'ethernet', role: 'wan', retired: false, circuitId: 'c1' },
      { id: IF2, name: 'lan1', kind: 'ethernet', role: null, retired: false, circuitId: null },
    ],
    interfacesTruncated: false,
    circuits: [circuit()],
    ...over,
  };
}

function route(get: () => Response, patch?: (body: unknown) => Response) {
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === 'PATCH') return patch!(JSON.parse(String(init.body)));
    return get();
  });
}

const patchCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');

describe('AssetCircuitCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canMock.mockReturnValue(true);
  });

  it('shows a loading skeleton first', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(screen.getByTestId('asset-circuit-card-loading')).toBeInTheDocument();
  });

  it('uses the right URL per subject', async () => {
    route(() => res(payload()));
    const { unmount } = render(<AssetCircuitCard subject="device" id={ID} />);
    await screen.findByTestId('asset-circuit-provider');
    expect(fetchMock).toHaveBeenCalledWith(`/devices/${ID}/circuits`);
    unmount();
    render(<AssetCircuitCard subject="discovered" id={ID} />);
    await screen.findByTestId('asset-circuit-provider');
    expect(fetchMock).toHaveBeenCalledWith(`/discovery/assets/${ID}/circuits`);
  });

  it('shows error with Retry that refetches', async () => {
    fetchMock.mockResolvedValueOnce(res({}, 500));
    fetchMock.mockResolvedValue(res(payload()));
    render(<AssetCircuitCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('asset-circuit-provider')).toHaveTextContent('Acme Telecom');
  });

  it('treats a malformed response as an error with Retry', async () => {
    route(() => res({ circuits: 'nope' }));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load WAN and circuit/)).toBeInTheDocument();
  });

  it('shows the empty state without circuits or WAN', async () => {
    route(() => res(payload({ circuits: [], interfaces: [{ id: IF2, name: 'lan1', kind: 'ethernet', role: null, retired: false, circuitId: null }] })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(await screen.findByTestId('asset-circuit-empty')).toBeInTheDocument();
  });

  it('renders a fully assigned circuit with derived termination site', async () => {
    route(() => res(payload()));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(await screen.findByTestId('asset-circuit-provider')).toHaveTextContent('Acme Telecom');
    expect(screen.getByTestId('asset-circuit-cid')).toHaveTextContent('CID-001');
    expect(screen.getByTestId('asset-circuit-bandwidth')).toHaveTextContent('500 Mbps');
    expect(screen.getByTestId('asset-circuit-service-type')).toHaveTextContent('DIA');
    expect(screen.getByTestId('asset-circuit-status')).toHaveTextContent('Active');
    expect(screen.getByTestId('asset-circuit-sites')).toHaveTextContent('Branch A');
    expect(screen.getByTestId('asset-circuit-termination')).toHaveTextContent(
      'Termination site: HQ (from EDGE-01 / wan1)',
    );
    expect(screen.getByText('Sites served by this circuit')).toBeInTheDocument();
  });

  it('formats Gbps', async () => {
    route(() => res(payload({ circuits: [circuit({ bandwidthBps: 10_000_000_000 })] })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(await screen.findByTestId('asset-circuit-bandwidth')).toHaveTextContent('10 Gbps');
  });

  it('shows a neutral state and hides the stale site for needs_reassociation', async () => {
    route(() => res(payload({
      circuits: [circuit({ terminationState: 'needs_reassociation' })],
    })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    const term = await screen.findByTestId('asset-circuit-termination');
    expect(term).toHaveTextContent('Termination needs reassociation');
    expect(term).not.toHaveTextContent('HQ');
    expect(screen.queryByText(/Termination site:/)).toBeNull();
  });

  it('does not show a termination site for unassigned circuits', async () => {
    route(() => res(payload({ circuits: [circuit({ terminationState: 'unassigned', termination: null })] })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(await screen.findByTestId('asset-circuit-termination')).toHaveTextContent('Termination not assigned');
  });

  it('renders nullable fields as a labelled dash and never claims no sites are served', async () => {
    route(() => res(payload({
      circuits: [circuit({ bandwidthBps: null, serviceType: null, additionalServedSites: [] })],
    })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    for (const tid of ['asset-circuit-bandwidth', 'asset-circuit-service-type', 'asset-circuit-sites']) {
      const el = await screen.findByTestId(tid);
      expect(el).toHaveTextContent('—');
      expect(el).toHaveAttribute('aria-label', 'Unknown');
    }
    expect(screen.queryByText(/no sites/i)).toBeNull();
  });

  it('never uses the forbidden "Impacted sites" wording', async () => {
    route(() => res(payload()));
    const { container } = render(<AssetCircuitCard subject="device" id={ID} />);
    await screen.findByTestId('asset-circuit-provider');
    expect(container.textContent).not.toContain('Impacted sites');
  });

  it('hides the interface list when interfaces are not visible', async () => {
    route(() => res(payload({
      capabilities: { interfacesVisible: false, wanRoleWritable: false },
      interfaces: [],
    })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    await screen.findByTestId('asset-circuit-provider');
    expect(screen.queryByTestId('asset-circuit-interfaces')).toBeNull();
    expect(screen.queryByText('No interfaces recorded.')).toBeNull();
  });

  it('does not show the empty state when interfaces are hidden but a circuit exists', async () => {
    route(() => res(payload({
      capabilities: { interfacesVisible: false, wanRoleWritable: false }, interfaces: [],
    })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(await screen.findByTestId('asset-circuit-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('asset-circuit-empty')).toBeNull();
    expect(screen.queryByTestId('asset-circuit-interfaces')).toBeNull();
  });

  it('shows the neutral empty state when interfaces are hidden and no circuit is visible', async () => {
    route(() => res(payload({
      capabilities: { interfacesVisible: false, wanRoleWritable: false }, interfaces: [], circuits: [],
    })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(await screen.findByTestId('asset-circuit-empty')).toHaveTextContent('recorded or visible to you');
    expect(screen.queryByTestId('asset-circuit-interfaces')).toBeNull();
  });

  it('renders an unnamed interface instead of failing the whole card', async () => {
    route(() => res(payload({
      interfaces: [
        { id: IF1, name: 'wan1', kind: 'ethernet', role: 'wan', retired: false, circuitId: 'c1' },
        { id: IF2, name: null, kind: null, role: 'other', retired: false, circuitId: null },
      ],
    })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(await screen.findByTestId(`asset-circuit-iface-${IF2}`)).toBeInTheDocument();
    expect(screen.getByTestId('asset-circuit-c1')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/i)).toBeNull();
  });

  it('warns when the interface list is truncated', async () => {
    route(() => res(payload({ interfacesTruncated: true })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    expect(await screen.findByTestId('asset-circuit-truncated')).toBeInTheDocument();
  });

  it('marks an interface as WAN and refetches', async () => {
    route(() => res(payload()), () => res({ id: IF2, siteId: 's1', role: 'wan' }));
    render(<AssetCircuitCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId(`asset-circuit-toggle-${IF2}`));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(patchCalls()[0][0]).toBe(`/topology/interfaces/${IF2}/role`);
    expect(JSON.parse(String(patchCalls()[0][1]?.body))).toEqual({ role: 'wan' });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    const gets = fetchMock.mock.calls.filter(([, init]) => !init?.method);
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it('asks for confirmation before clearing WAN', async () => {
    route(() => res(payload()), () => res({ id: IF1, siteId: 's1', role: null }));
    render(<AssetCircuitCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId(`asset-circuit-toggle-${IF1}`));
    expect(patchCalls()).toHaveLength(0);
    fireEvent.click(await screen.findByTestId('asset-circuit-unmark-confirm'));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(JSON.parse(String(patchCalls()[0][1]?.body))).toEqual({ role: null });
  });

  it.each([
    ['MFA_REQUIRED', 403, /Multi-factor/],
    ['WAN_HAS_TERMINATION', 409, /active circuit termination/],
    ['INTERFACE_RETIRED', 422, /retired/],
  ])('shows a friendly message for %s', async (code, status, re) => {
    route(() => res(payload()), () => res({ error: 'x', code }, status as number));
    render(<AssetCircuitCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId(`asset-circuit-toggle-${IF2}`));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(re) })),
    );
  });

  it('offers no toggle on retired interfaces', async () => {
    route(() => res(payload({
      interfaces: [{ id: IF2, name: 'old0', kind: 'ethernet', role: null, retired: true, circuitId: null }],
    })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    await screen.findByText('old0');
    expect(screen.queryByTestId(`asset-circuit-toggle-${IF2}`)).toBeNull();
  });

  it('offers no toggle without permission or capability', async () => {
    canMock.mockReturnValue(false);
    route(() => res(payload()));
    const { unmount } = render(<AssetCircuitCard subject="device" id={ID} />);
    await screen.findByText('lan1');
    expect(screen.queryByTestId(`asset-circuit-toggle-${IF2}`)).toBeNull();
    unmount();
    canMock.mockReturnValue(true);
    route(() => res(payload({ capabilities: { interfacesVisible: true, wanRoleWritable: false } })));
    render(<AssetCircuitCard subject="device" id={ID} />);
    await screen.findByText('lan1');
    expect(screen.queryByTestId(`asset-circuit-toggle-${IF2}`)).toBeNull();
  });
});
