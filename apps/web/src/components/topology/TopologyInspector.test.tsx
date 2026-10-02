import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TopologyInspector from './TopologyInspector';
import { topologyGraphFixture, NODE, ASSET, SITE } from './topologyFixtures';
import { EXCLUSION, FDB, fdbDetail, fdbEvidence, fdbRelationship } from './physicalFixtures';
import { fetchWithAuth } from '../../stores/auth';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
afterEach(cleanup);

it('renders reported entity detail, focuses the heading and offers a live diagnose action', () => {
  const graph = topologyGraphFixture();
  const onDiagnose = vi.fn(), onClose = vi.fn(), onExpand = vi.fn();
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={onDiagnose} onClose={onClose} onExpand={onExpand} />);
  expect(screen.getByRole('heading', { name: 'Reported gateway' })).toHaveFocus();
  expect(screen.queryByText(/schematic/i)).not.toBeInTheDocument();
  expect(screen.getByText(/observed/)).toBeVisible();
  expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByTestId('topology-diagnose'));
  expect(onDiagnose).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByTestId('topology-inspector-close'));
  expect(onClose).toHaveBeenCalledOnce();
});

it('disables diagnose and explains why when the caller says diagnostics are unavailable', () => {
  const graph = topologyGraphFixture();
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose={false} onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
  expect(screen.getByTestId('topology-diagnose')).toBeDisabled();
  expect(screen.getByText(/Diagnostics are unavailable/)).toBeVisible();
});

it('presentation-only schematic nodes explain themselves and never offer diagnose', () => {
  const graph = topologyGraphFixture();
  graph.presentation.nodes = [{ id: 'schematic-1', meaning: 'missing_default_route', authority: false } as never];
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: 'schematic-1' }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
  expect(screen.getByText('This diagram element explains missing evidence. It is not discovered hardware and cannot run diagnostics.')).toBeVisible();
  expect(screen.queryByTestId('topology-diagnose')).not.toBeInTheDocument();
});

it('links reported inventory bindings out to the device record, never to a manual node', () => {
  const graph = topologyGraphFixture();
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
  const link = screen.getByRole('link', { name: 'Open inventory details' });
  expect(link).toHaveAttribute('href', `/devices/network/${ASSET}`);
});

it('toggles pin state through the caller-provided handler and reflects pressed state', () => {
  const graph = topologyGraphFixture();
  const onPin = vi.fn();
  const { rerender } = render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} onPin={onPin} pinned={false} />);
  const pinButton = screen.getByTestId('topology-pin');
  expect(pinButton).toHaveAttribute('aria-pressed', 'false');
  expect(pinButton).toHaveTextContent('Pin');
  fireEvent.click(pinButton);
  expect(onPin).toHaveBeenCalledOnce();
  rerender(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} onPin={onPin} pinned />);
  expect(screen.getByTestId('topology-pin')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByTestId('topology-pin')).toHaveTextContent('Unpin');
});

it('closes on Escape from within the panel', () => {
  const graph = topologyGraphFixture();
  const onClose = vi.fn();
  render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={vi.fn()} onClose={onClose} onExpand={vi.fn()} />);
  fireEvent.keyDown(screen.getByTestId('topology-inspector'), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
});

it('renders nothing when the selected id is not present in the graph', () => {
  const graph = topologyGraphFixture();
  const { container } = render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: 'missing' }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

describe('physical relationship detail', () => {
  beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); });
  it('reads relationship detail and evidence for the selected edge and offers the exclusion action to editors', async () => {
    const graph = topologyGraphFixture();
    graph.relationships = [fdbRelationship()];
    vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('/evidence') ? fdbEvidence() : fdbDetail())));
    render(<TopologyInspector graph={graph} siteId={SITE} view="physical" selection={{ kind: 'edge', id: FDB }} canDiagnose={false} onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByTestId('topology-source-port')).toHaveTextContent('port-24');
    expect(screen.getByTestId('topology-directness')).toHaveTextContent('Direct connection not established');
    expect(await screen.findByTestId(`topology-observation-${EXCLUSION}`)).toBeVisible();
    expect(screen.getByTestId('topology-exclusion-hide')).toBeInTheDocument();
    const urls = vi.mocked(fetchWithAuth).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual(expect.arrayContaining([`/topology/sites/${SITE}/relationships/${FDB}`, expect.stringContaining(`/topology/sites/${SITE}/relationships/${FDB}/evidence`)]));
    expect(vi.mocked(fetchWithAuth).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });
});

describe('Explain this in the inspector (M4 Task 5)', () => {
  const explain = { canApprove: true, onInvestigation: vi.fn(), onRun: vi.fn(), onEvidenceSelect: vi.fn() };
  beforeEach(() => vi.mocked(fetchWithAuth).mockReset());

  it('offers Explain for a canonical selection when AI is available, and keeps the deterministic Diagnose action', () => {
    render(<TopologyInspector graph={topologyGraphFixture()} selection={{ kind: 'node', id: NODE }} siteId={SITE} view="overview" canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} explain={explain} />);
    expect(screen.getByTestId('topology-explain')).toBeEnabled();
    expect(screen.getByTestId('topology-diagnose')).toBeEnabled();
    // Rendering the panel never starts a model call.
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('says AI is not configured, instead of offering an Explain that cannot run, when the server has no model provider', () => {
    render(<TopologyInspector graph={topologyGraphFixture()} selection={{ kind: 'node', id: NODE }} siteId={SITE} view="overview" canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} aiNotConfigured />);
    expect(screen.queryByTestId('topology-explain')).toBeNull();
    expect(screen.getByTestId('topology-explain-not-configured')).toHaveTextContent("AI isn't configured on this server");
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('offers no Explain when AI is unavailable (no explain wiring) or for a schematic element', () => {
    const { unmount } = render(<TopologyInspector graph={topologyGraphFixture()} selection={{ kind: 'node', id: NODE }} siteId={SITE} view="overview" canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.queryByTestId('topology-explain')).toBeNull();
    unmount();
    const graph = topologyGraphFixture();
    graph.presentation.nodes = [{ id: 'schematic-1', meaning: 'missing_default_route', authority: false } as never];
    render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: 'schematic-1' }} siteId={SITE} view="overview" canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} explain={explain} aiNotConfigured />);
    expect(screen.queryByTestId('topology-explain')).toBeNull();
    expect(screen.queryByTestId('topology-explain-not-configured')).toBeNull();
  });
});

describe('grouped overview inspector (2026-10-02)', () => {
  const inventory = { source: 'device' as const, name: 'DRT-HYG3', addresses: ['10.1.2.57'], mac: 'aa:bb:cc:dd:ee:ff', vendor: null, model: null, os: 'windows 10.0.19045', type: 'workstation',
    presence: { state: 'offline' as const, source: 'agent' as const, agentStatus: 'offline', lastSeenAt: '2026-10-01T22:00:00.000Z' } };
  it('leads with identity — presence as text, addresses, OS — and keeps evidence in a collapsed section', () => {
    const graph = topologyGraphFixture();
    graph.nodes[0] = { ...graph.nodes[0]!, kind: 'endpoint', label: 'DRT-HYG3', inventory };
    render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.getByTestId('topology-presence')).toHaveTextContent('Agent offline');
    expect(screen.getByTestId('topology-identity')).toHaveTextContent('10.1.2.57');
    expect(screen.getByTestId('topology-identity')).toHaveTextContent('windows 10.0.19045');
    expect(screen.getByText('Evidence and freshness').closest('details')).not.toHaveAttribute('open');
  });

  it('lists each reporter of a folded gateway and selects that reporter’s own canonical gateway', () => {
    const graph = topologyGraphFixture();
    const gatewayId = graph.nodes[0]!.id;
    const reporter = { ...graph.nodes[0]!, id: '10000000-0000-4000-8000-0000000000b1', kind: 'endpoint' as const, label: 'FRONT-DESK' };
    const udm = { ...graph.nodes[0]!, id: '10000000-0000-4000-8000-0000000000b2', kind: 'endpoint' as const, label: '10.1.2.100',
      inventory: { ...inventory, source: 'discovered_asset' as const, name: null, addresses: ['10.1.2.100'], vendor: 'Ubiquiti', model: 'UDM-Pro', type: 'router' } };
    graph.nodes = [graph.nodes[0]!, reporter, udm];
    graph.relationships = [{ ...graph.relationships[0]!, kind: 'default_route', sourceNodeId: reporter.id, targetNodeId: gatewayId }];
    graph.presentation.nodes = [{ id: 'presentation:overview:s:gw-a', view: 'overview', role: 'gateway_group', label: 'Reported gateway 10.1.2.100', memberCount: 0, frontierToken: 't', authority: false,
      group: { kind: 'gateway', basis: 'reported_gateway', networkClass: null, prefix: null, address: '10.1.2.100', gatewayAddresses: [], conflict: false, observerCount: 1, members: [], canonicalNodeIds: [gatewayId] } }];
    const onSelectNode = vi.fn();
    render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: 'presentation:overview:s:gw-a' }} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} onSelectNode={onSelectNode} />);
    expect(screen.getByTestId('topology-group-summary')).toHaveTextContent('1 device reports 10.1.2.100 as its default gateway');
    expect(screen.getByTestId('topology-gateway-address-match')).toHaveTextContent('not verified');
    fireEvent.click(screen.getByRole('button', { name: 'Ubiquiti UDM-Pro' }));
    expect(onSelectNode).toHaveBeenCalledWith(udm.id);
    fireEvent.click(screen.getByRole('button', { name: reporter.label }));
    expect(onSelectNode).toHaveBeenCalledWith(gatewayId);
    expect(screen.queryByTestId('topology-diagnose')).not.toBeInTheDocument();
    expect(screen.queryByTestId('topology-expand')).not.toBeInTheDocument();
  });

  it('offers SNMP port measurement for infrastructure, never for a workstation', () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({})));
    const operations = { interfaceHealth: true, monitoring: false, canConfigure: true };
    const graph = topologyGraphFixture();
    graph.nodes[0] = { ...graph.nodes[0]!, kind: 'endpoint', role: null, label: 'DRT-HYG3', inventory };
    const { unmount } = render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} siteId={SITE} operations={operations} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.queryByTestId('topology-telemetry')).not.toBeInTheDocument();
    unmount();
    graph.nodes[0] = { ...graph.nodes[0]!, role: 'switch' };
    render(<TopologyInspector graph={graph} selection={{ kind: 'node', id: NODE }} siteId={SITE} operations={operations} canDiagnose onDiagnose={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.getByTestId('topology-telemetry')).toBeInTheDocument();
  });
});
