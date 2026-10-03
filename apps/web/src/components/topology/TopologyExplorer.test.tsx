import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TopologyExplorer from './TopologyExplorer';
import { topologyGraphFixture, topologySettingsFixture, SITE, NODE } from './topologyFixtures';
import { fetchWithAuth } from '../../stores/auth';
import { packTopologyLayout } from './layoutAdapter';
import type { LayoutPosition, LayoutRequest } from './layoutTypes';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
const canvas = vi.hoisted(() => ({ props: undefined as undefined | { positions: LayoutPosition[]; onMove: (positions: LayoutPosition[]) => void } }));
vi.mock('./TopologyCanvas', () => ({ default: (props: { positions: LayoutPosition[]; onMove: (positions: LayoutPosition[]) => void }) => { canvas.props = props; return <div data-testid="topology-canvas" data-positions={props.positions.length} />; } }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
beforeEach(() => {
  window.location.hash = '#topology';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, options) => {
    if (options?.method === 'PATCH') return new Response(JSON.stringify({ error: 'Revision changed', code: 'revision_conflict' }), { status: 409 });
    return new Response(JSON.stringify(topologyGraphFixture()));
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });
it('renders a passive snapshot, and local arrangement never persists', async () => {
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  expect(await screen.findByTestId('topology-health-internet')).toHaveTextContent('Not measured');
  fireEvent.click(screen.getByTestId('topology-arrange'));
  await screen.findByTestId('topology-unsaved-layout');
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
it('the automatic arrangement on load is not an unsaved change; only a user action is (#7880)', async () => {
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await waitFor(() => expect(Number(screen.getByTestId('topology-canvas').getAttribute('data-positions'))).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByText('Layout preview complete')).toBeInTheDocument());
  // Browser gates wait on this marker, not on the unsaved indicator.
  expect(screen.getByTestId('topology-explorer')).toHaveAttribute('data-layout-applied', 'true');
  expect(screen.queryByTestId('topology-unsaved-layout')).not.toBeInTheDocument();
  expect(screen.getByTestId('topology-layout-save')).toBeDisabled();
  fireEvent.click(screen.getByTestId('topology-arrange'));
  expect(await screen.findByTestId('topology-unsaved-layout')).toHaveTextContent('Unsaved layout preview');
  expect(screen.getByTestId('topology-layout-save')).toBeEnabled();
});
it('pluralizes the node and connection counts', async () => {
  const graph = topologyGraphFixture(); graph.counts = { ...graph.counts, visibleNodes: 1, visibleRelationships: 1, omittedNodes: 1, omittedRelationships: 0 };
  vi.mocked(fetchWithAuth).mockImplementation(async () => new Response(JSON.stringify(graph)));
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  const counts = await screen.findByTestId('topology-counts');
  expect(counts).toHaveTextContent('1 node · 1 connection');
  expect(counts).not.toHaveTextContent('1 connections');
  expect(counts.nextElementSibling).toHaveTextContent('Outside this view: 1 node · 0 connections');
});
it('provides keyboard-equivalent list inspection and preserves conflict drafts', async () => {
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-health-internet');
  fireEvent.click(screen.getByTestId('topology-list-toggle'));
  fireEvent.click(screen.getByTestId(`topology-node-${NODE}`));
  expect(await screen.findByTestId('topology-inspector')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Reported gateway' })).toHaveFocus();
  fireEvent.click(screen.getByTestId('topology-arrange'));
  await screen.findByTestId('topology-unsaved-layout');
  fireEvent.click(screen.getByTestId('topology-layout-save'));
  expect(await screen.findByTestId('topology-layout-conflict')).toBeVisible();
  expect(screen.getByTestId('topology-unsaved-layout')).toBeVisible();
  fireEvent.keyDown(screen.getByTestId('topology-inspector'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByTestId('topology-inspector')).not.toBeInTheDocument());
  expect(screen.getByTestId('topology-list-toggle')).toHaveFocus();
});
it('read-only users can arrange but cannot save shared coordinates', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ ...topologyGraphFixture(), permissions: { canEdit: false, canDiagnose: false, canConfigureMonitoring: false } })));
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-arrange');
  expect(screen.queryByTestId('topology-layout-save')).not.toBeInTheDocument();
});

it('measures newly expanded nodes when the site graph revision is unchanged', async () => {
  const initial = topologyGraphFixture();
  const added = { ...initial.nodes[0], id: '10000000-0000-4000-8000-000000000099', label: 'Expanded peer' };
  initial.frontier = [{ token: 'next', label: 'More nodes', memberCount: 1 }];
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('/expansions/')
    ? { ...initial, nodes: [...initial.nodes, added], frontier: [] } : initial)));
  const { container } = render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  fireEvent.click(await screen.findByTestId('topology-frontier'));
  await waitFor(() => expect(container.querySelector(`[data-node-id="${added.id}"]`)).toHaveTextContent('Expanded peer'));
});

it('does not restart the layout worker when a repeat measurement reports unchanged card sizes (#7285)', async () => {
  const resized: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized.push(callback); } observe() {} disconnect() {} });
  const posted: unknown[] = [];
  vi.stubGlobal('Worker', class { onmessage = null; onerror = null; postMessage(request: unknown) { posted.push(request); } terminate() {} });
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await waitFor(() => expect(posted).toHaveLength(1));
  // A ResizeObserver callback with no real size change (it always fires once on observe).
  resized.forEach((callback) => callback());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(posted).toHaveLength(1);
});

it('still re-arranges when the shared layout revision changes but card sizes do not', async () => {
  const initial = topologyGraphFixture();
  initial.frontier = [{ token: 'next', label: 'More nodes', memberCount: 1 }];
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('/expansions/')
    ? { ...initial, revisions: { ...initial.revisions, layout: String(Number(initial.revisions.layout) + 1) }, frontier: [] } : initial)));
  const posted: unknown[] = [];
  vi.stubGlobal('Worker', class { onmessage = null; onerror = null; postMessage(request: unknown) { posted.push(request); } terminate() {} });
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await waitFor(() => expect(posted).toHaveLength(1));
  fireEvent.click(await screen.findByTestId('topology-frontier'));
  await waitFor(() => expect(posted).toHaveLength(2));
});

it('enables the physical view from the capability and offers the overview from an empty physical view', async () => {
  const settings = topologySettingsFixture(); settings.capabilities.physical = { available: true, reason: null };
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('view=physical')
    ? { ...topologyGraphFixture(), view: 'physical', nodes: [], counts: { ...topologyGraphFixture().counts, totalNodes: 0, visibleNodes: 0 } } : topologyGraphFixture())));
  render(<TopologyExplorer siteId={SITE} settings={settings} />);
  await screen.findByTestId('topology-health-internet');
  const physical = screen.getByRole('option', { name: 'Physical' }) as HTMLOptionElement;
  expect(physical.disabled).toBe(false);
  fireEvent.change(screen.getByTestId('topology-view'), { target: { value: 'physical' } });
  fireEvent.click(await screen.findByTestId('topology-view-overview'));
  await waitFor(() => expect((screen.getByTestId('topology-view') as HTMLSelectElement).value).toBe('overview'));
});

it('lists connections hidden from the view and restores one through runAction', async () => {
  const relationshipId = '55555555-5555-4555-8555-555555555555';
  const exclusion = { id: '99999999-9999-4999-8999-999999999999', relationshipId, view: 'overview', reason: 'Lab bench cable', active: true,
    createdAt: '2026-09-26T10:00:00.000Z', createdBy: null, revokedAt: null, revokedBy: null,
    relationship: { id: relationshipId, kind: 'attachment', sourceNodeId: '11111111-1111-4111-8111-111111111111', targetNodeId: '22222222-2222-4222-8222-222222222222',
      sourceInterfaceId: null, targetInterfaceId: null, evidenceClass: 'inferred', lifecycle: 'active' } };
  vi.mocked(fetchWithAuth).mockImplementation(async (url, options) => {
    if (options?.method === 'DELETE') return new Response(JSON.stringify({ id: exclusion.id }));
    if (String(url).includes('/exclusions')) return new Response(JSON.stringify({ view: 'overview', graphRevision: '7', items: [exclusion], nextCursor: null }));
    return new Response(JSON.stringify(topologyGraphFixture()));
  });
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-health-internet');
  fireEvent.click(screen.getByTestId('topology-list-toggle'));
  expect(await screen.findByTestId(`topology-hidden-${exclusion.id}`)).toHaveTextContent('Lab bench cable');
  fireEvent.click(screen.getByTestId(`topology-restore-${exclusion.id}`));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(true));
  const [url] = vi.mocked(fetchWithAuth).mock.calls.find(([, options]) => options?.method === 'DELETE')!;
  expect(url).toBe(`/topology/sites/${SITE}/relationships/${exclusion.relationshipId}/exclusions/${exclusion.id}`);
});

it('takes diagnose and monitoring authority from the site settings, not the graph projection (M3 Task 11)', async () => {
  // The graph read reports canDiagnose/canConfigureMonitoring false by design; the
  // per-site settings read carries the real execute/configure + MFA answer.
  vi.mocked(fetchWithAuth).mockImplementation(async () => new Response(JSON.stringify({ ...topologyGraphFixture(), permissions: { canEdit: true, canDiagnose: false, canConfigureMonitoring: false } })));
  const settings = topologySettingsFixture();
  render(<TopologyExplorer siteId={SITE} settings={settings} />);
  await screen.findByTestId('topology-health-internet');
  fireEvent.click(screen.getByTestId('topology-list-toggle'));
  fireEvent.click(screen.getByTestId(`topology-node-${NODE}`));
  expect(await screen.findByTestId('topology-diagnose')).toBeEnabled();
  cleanup();
  render(<TopologyExplorer siteId={SITE} settings={{ ...settings, permissions: { ...settings.permissions, canDiagnose: false } }} />);
  await screen.findByTestId('topology-health-internet');
  fireEvent.click(screen.getByTestId('topology-list-toggle'));
  fireEvent.click(screen.getByTestId(`topology-node-${NODE}`));
  expect(await screen.findByTestId('topology-diagnose')).toBeDisabled();
});

it('a moved card member re-packs its card instead of being drawn at its pin; a moved loose tile stays where it was dropped (#7880)', async () => {
  const member = '10000000-0000-4000-8000-000000000042', card = 'presentation:overview:scope:net-lan';
  const graph = topologyGraphFixture();
  graph.nodes.push({ ...graph.nodes[0]!, id: member, kind: 'endpoint', role: null, label: 'PC-42', bindings: [], availableActions: [],
    inventory: { source: 'device', name: 'PC-42', addresses: ['10.1.2.42'], mac: null, vendor: null, model: null, os: null, type: 'workstation', presence: { state: 'online', source: 'agent', agentStatus: 'online', lastSeenAt: null } } });
  graph.presentation.nodes.push({ id: card, view: 'overview', role: 'network_group', label: '10.1.2.0/24', memberCount: 1, frontierToken: 't', authority: false,
    group: { kind: 'network', basis: 'inferred_site_prefix', networkClass: 'lan', prefix: '10.1.2.0/24', address: null, gatewayAddresses: [], conflict: false, observerCount: 1,
      members: [{ nodeId: member, placement: 'observed', primary: true, stale: false }], canonicalNodeIds: [] } });
  vi.mocked(fetchWithAuth).mockImplementation(async () => new Response(JSON.stringify(graph)));
  const posted: LayoutRequest[] = [];
  vi.stubGlobal('Worker', class { onmessage: ((event: { data: unknown }) => void) | null = null; onerror = null;
    postMessage(request: LayoutRequest) { posted.push(request); setTimeout(() => this.onmessage?.({ data: packTopologyLayout(request) }), 0); } terminate() {} });
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await waitFor(() => expect(canvas.props?.positions.some((p) => p.nodeId === member)).toBe(true));
  expect(posted[0]!.nodes.find((n) => n.id === member)).toMatchObject({ groupId: card, address: '10.1.2.42' });
  const grid = canvas.props!.positions.find((p) => p.nodeId === member)!;
  const runs = posted.length;
  act(() => canvas.props!.onMove([{ nodeId: member, x: 9_000, y: 9_000, pinned: true }]));
  await waitFor(() => expect(posted).toHaveLength(runs + 1));
  await waitFor(() => expect(canvas.props!.positions.find((p) => p.nodeId === member)).toMatchObject({ pinned: true }));
  // A single member's pin anchors the card on it, so the card (not the tile alone) moved there; never a stray tile.
  const moved = canvas.props!.positions.find((p) => p.nodeId === member)!;
  expect(moved).not.toEqual(grid);
  expect(await screen.findByTestId('topology-unsaved-layout')).toBeInTheDocument();
  act(() => canvas.props!.onMove([{ nodeId: NODE, x: 7_000, y: -7_000, pinned: true }]));
  await waitFor(() => expect(canvas.props!.positions.find((p) => p.nodeId === NODE)).toEqual({ nodeId: NODE, x: 7_000, y: -7_000, pinned: true }));
  expect(posted).toHaveLength(runs + 1);
});

it('saving keeps card members in the grid; the saved legacy pins are sent unchanged, not drawn (#7880 review)', async () => {
  const [m1, m2] = ['10000000-0000-4000-8000-000000000051', '10000000-0000-4000-8000-000000000052'];
  const card = 'presentation:overview:scope:net-lan';
  const graph = topologyGraphFixture();
  for (const [id, ip] of [[m1, '10.1.2.51'], [m2, '10.1.2.52']] as const) {
    graph.nodes.push({ ...graph.nodes[0]!, id, kind: 'endpoint', role: null, label: id.slice(-2), bindings: [], availableActions: [],
      inventory: { source: 'device', name: id.slice(-2), addresses: [ip], mac: null, vendor: null, model: null, os: null, type: 'workstation', presence: { state: 'online', source: 'agent', agentStatus: 'online', lastSeenAt: null } } });
  }
  graph.presentation.nodes.push({ id: card, view: 'overview', role: 'network_group', label: '10.1.2.0/24', memberCount: 2, frontierToken: 't', authority: false,
    group: { kind: 'network', basis: 'inferred_site_prefix', networkClass: 'lan', prefix: '10.1.2.0/24', address: null, gatewayAddresses: [], conflict: false, observerCount: 2,
      members: [m1, m2].map((nodeId) => ({ nodeId, placement: 'observed' as const, primary: true, stale: false })), canonicalNodeIds: [] } });
  const legacy = [{ nodeId: m1, x: 5_000, y: 5_000, pinned: true, source: 'legacy' as const, rowRevision: '1' }, { nodeId: m2, x: -3_000, y: 100, pinned: true, source: 'legacy' as const, rowRevision: '1' }];
  graph.layout = { algorithm: 'elk', version: 1, positions: legacy };
  let saved: { positions: LayoutPosition[] } | undefined;
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, options) => {
    if (options?.method === 'PATCH') {
      saved = JSON.parse(String(options.body));
      return new Response(JSON.stringify({ siteId: SITE, view: 'overview', layoutRevision: '2', positions: saved!.positions.map((p) => ({ ...p, source: p.nodeId === NODE ? 'user' : 'legacy', rowRevision: '2' })) }));
    }
    return new Response(JSON.stringify(graph));
  });
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await waitFor(() => expect(canvas.props?.positions.some((p) => p.nodeId === m1)).toBe(true));
  const drawn = () => [m1, m2].map((id) => canvas.props!.positions.find((p) => p.nodeId === id)!);
  const grid = drawn();
  for (const [index, pin] of legacy.entries()) expect({ x: grid[index]!.x, y: grid[index]!.y }).not.toEqual({ x: pin.x, y: pin.y });
  act(() => canvas.props!.onMove([{ nodeId: NODE, x: 7_000, y: -7_000, pinned: true }]));
  fireEvent.click(await screen.findByTestId('topology-layout-save'));
  await waitFor(() => expect(saved).toBeDefined());
  for (const pin of legacy) expect(saved!.positions.find((p) => p.nodeId === pin.nodeId)).toEqual({ nodeId: pin.nodeId, x: pin.x, y: pin.y, pinned: true });
  await waitFor(() => expect(screen.queryByTestId('topology-unsaved-layout')).not.toBeInTheDocument());
  expect(drawn()).toEqual(grid);
});

it('frames the overview as networks within one site and says when a second network has no observed link', async () => {
  const graph = topologyGraphFixture();
  const lan = (card: string, prefix: string, members: [string, string][]) => {
    for (const [id, ip] of members) graph.nodes.push({ ...graph.nodes[0]!, id, kind: 'endpoint', role: null, label: `PC-${ip}`, bindings: [], availableActions: [],
      inventory: { source: 'device', name: `PC-${ip}`, addresses: [ip], mac: null, vendor: null, model: null, os: null, type: 'workstation', presence: { state: 'online', source: 'agent', agentStatus: 'online', lastSeenAt: null } } });
    graph.presentation.nodes.push({ id: card, view: 'overview', role: 'network_group', label: prefix, memberCount: members.length, frontierToken: 't', authority: false,
      group: { kind: 'network', basis: 'inferred_site_prefix', networkClass: 'lan', prefix, address: null, gatewayAddresses: [], conflict: false, observerCount: members.length,
        members: members.map(([nodeId]) => ({ nodeId, placement: 'observed' as const, primary: true, stale: false })), canonicalNodeIds: [] } });
  };
  lan('presentation:overview:scope:net-a', '10.1.2.0/24', [['10000000-0000-4000-8000-000000000061', '10.1.2.61'], ['10000000-0000-4000-8000-000000000062', '10.1.2.62']]);
  lan('presentation:overview:scope:net-b', '10.1.5.0/24', [['10000000-0000-4000-8000-000000000071', '10.1.5.71']]);
  vi.mocked(fetchWithAuth).mockImplementation(async () => new Response(JSON.stringify(graph)));
  render(<TopologyExplorer siteId={SITE} siteName="Harbor Dental — Main Office" settings={topologySettingsFixture()} />);
  const header = await screen.findByTestId('topology-site-header');
  expect(header).toHaveTextContent('Harbor Dental — Main Office');
  expect(header).toHaveTextContent('2 networks · 3 devices');
  expect(screen.getByTestId('topology-unlinked-note')).toHaveTextContent('No observed link between 10.1.5.0/24 and 10.1.2.0/24');
});

it('compacts the header: one status row, a secondary control group with accessible names, and a site control in the toolbar', async () => {
  render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} toolbarStart={<select data-testid="topology-site" aria-label="Site"><option>Main</option></select>} />);
  const status = await screen.findByTestId('topology-status');
  for (const id of ['topology-coverage', 'topology-health-internet', 'topology-counts']) expect(status).toContainElement(screen.getByTestId(id));
  const toolbar = screen.getByTestId('topology-toolbar');
  for (const id of ['topology-site', 'topology-search', 'topology-view', 'topology-list-toggle', 'topology-refresh', 'topology-configure', 'topology-operations-toggle']) {
    expect(toolbar).toContainElement(screen.getByTestId(id));
  }
  expect(screen.getByRole('button', { name: 'Refresh snapshot' })).toBe(screen.getByTestId('topology-refresh'));
  expect(screen.getByRole('button', { name: 'Configuration' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('button', { name: 'Operations' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('searchbox', { name: 'Search this site by name or address' })).toBe(screen.getByTestId('topology-search'));
});

it('collapses an expansion back to the base read (#7818)', async () => {
  const initial = topologyGraphFixture();
  const added = { ...initial.nodes[0], id: '10000000-0000-4000-8000-000000000099', label: 'Expanded peer' };
  initial.frontier = [{ token: 'next', label: 'More nodes', memberCount: 1 }];
  vi.mocked(fetchWithAuth).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('/expansions/')
    ? { ...initial, nodes: [...initial.nodes, added], frontier: [] } : initial)));
  const { container } = render(<TopologyExplorer siteId={SITE} settings={topologySettingsFixture()} />);
  await screen.findByTestId('topology-frontier');
  expect(screen.queryByTestId('topology-collapse')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('topology-frontier'));
  fireEvent.click(await screen.findByTestId('topology-collapse'));
  await waitFor(() => expect(container.querySelector(`[data-node-id="${added.id}"]`)).toBeNull());
  expect(screen.queryByTestId('topology-collapse')).not.toBeInTheDocument();
  expect(screen.getByTestId('topology-frontier')).toBeVisible();
});
