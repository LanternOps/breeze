import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import NetworkTopologyMap from './NetworkTopologyMap';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args)
}));

// Edit-mode gating (#1728 phase 4) calls usePermissions(). Most tests exercise
// the read-only view (deny topology:write); the edit-only controls (Auto-arrange)
// flip the mock to grant it per-test. Hoisted so the vi.mock factory can see it.
const { canMock } = vi.hoisted(() => ({ canMock: vi.fn((..._a: unknown[]) => false) }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (...a: unknown[]) => canMock(...a) })
}));

const runAction = vi.fn(async (opts: { request: () => Promise<Response> }) => {
  const res = await opts.request();
  return res.json();
});
vi.mock('@/lib/runAction', () => ({
  runAction: (...args: unknown[]) => (runAction as (...a: unknown[]) => unknown)(...args)
}));

// Cytoscape needs a real factory; capture the config (esp. the `layout`) it is
// called with so we can assert `preset` is used (consume saved positions, never
// auto-layout-every-render). `dragfree` handlers are stashed so a test can fire
// a synthetic drag-end. Built via vi.hoisted so the vi.mock factory (hoisted to
// top of file) can reference it.
const { cyDragHandlers, cyInstance, cytoscapeFactory } = vi.hoisted(() => {
  const handlers: Array<(evt: unknown) => void> = [];
  const instance = {
    on: vi.fn((event: string, _sel: string, handler: (evt: unknown) => void) => {
      if (event === 'dragfree') handlers.push(handler);
    }),
    nodes: vi.fn(() => ({
      length: 0,
      positions: vi.fn(),
      filter: vi.fn(() => ({
        lock: vi.fn(),
        unlock: vi.fn(),
        layout: vi.fn(() => ({ run: vi.fn() }))
      }))
    })),
    layout: vi.fn(() => ({ run: vi.fn() })),
    destroy: vi.fn(),
    add: vi.fn(),
    // Selection-highlight + hover effects use these; return chainable no-ops.
    container: vi.fn(() => null),
    batch: vi.fn((fn: () => void) => fn()),
    getElementById: vi.fn(() => ({
      empty: () => true,
      addClass: vi.fn(),
      closedNeighborhood: () => ({}),
      connectedNodes: () => ({}),
      union: () => ({})
    })),
    elements: vi.fn(() => ({
      remove: vi.fn(),
      nonempty: () => true,
      removeClass: vi.fn(),
      not: vi.fn(() => ({ addClass: vi.fn() }))
    })),
    fit: vi.fn(),
    resize: vi.fn(),
    // Edit-only interactivity toggles (#1728): set on mode change; no-ops here.
    userPanningEnabled: vi.fn(),
    userZoomingEnabled: vi.fn(),
    autoungrabify: vi.fn(),
    // Theme-change stylesheet rebuild (#1728): no-op in jsdom.
    style: vi.fn()
  };
  const factory = vi.fn(() => instance) as ReturnType<typeof vi.fn> & {
    use: ReturnType<typeof vi.fn>;
  };
  factory.use = vi.fn();
  return { cyDragHandlers: handlers, cyInstance: instance, cytoscapeFactory: factory };
});
vi.mock('cytoscape', () => ({ default: cytoscapeFactory }));
vi.mock('cytoscape-fcose', () => ({ default: vi.fn() }));

function lastCytoscapeConfig(): Record<string, unknown> | undefined {
  const calls = cytoscapeFactory.mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as Record<string, unknown>) : undefined;
}

function mockTopologyResponse(body: unknown) {
  fetchWithAuth.mockResolvedValue({
    ok: true,
    json: async () => body
  } as unknown as Response);
}

describe('NetworkTopologyMap', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    runAction.mockClear();
    cytoscapeFactory.mockClear();
    cytoscapeFactory.use.mockClear();
    cyInstance.on.mockClear();
    cyInstance.layout.mockClear();
    cyInstance.destroy.mockClear();
    canMock.mockReturnValue(false);
    cyDragHandlers.length = 0;
    if (!window.ResizeObserver) {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    }
  });

  function cytoscapeElements(): Array<{ data: Record<string, unknown>; position?: { x: number; y: number } }> {
    const cfg = lastCytoscapeConfig();
    return (cfg?.elements as Array<{ data: Record<string, unknown>; position?: { x: number; y: number } }>) ?? [];
  }

  it('mounts a Cytoscape canvas and exposes Auto-arrange only in edit mode', async () => {
    canMock.mockReturnValue(true);
    mockTopologyResponse({
      subnets: ['10.0.2.0/24'],
      edges: [],
      layout: [],
      nodes: [
        { id: 'a', label: 'host-a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5' },
        { id: 'gw', label: 'gateway', type: 'router', status: 'online', ipAddress: '10.0.2.1' }
      ]
    });

    render(<NetworkTopologyMap />);

    // The canvas mount container is present.
    expect(await screen.findByTestId('topology-cytoscape')).toBeInTheDocument();
    // Auto-arrange is an editing action — hidden in the read-only view (#1728).
    expect(screen.queryByTestId('topology-auto-arrange')).not.toBeInTheDocument();
    // It appears once edit mode is entered.
    fireEvent.click(screen.getByTestId('topology-edit-toggle'));
    expect(screen.getByTestId('topology-auto-arrange')).toBeInTheDocument();

    // Cytoscape was constructed once with the discovered nodes as elements.
    await waitFor(() => expect(cytoscapeFactory).toHaveBeenCalled());
    const ids = cytoscapeElements()
      .map((el) => el.data.id)
      .filter((id) => id === 'a' || id === 'gw');
    expect(ids).toEqual(expect.arrayContaining(['a', 'gw']));
  });

  it('does NOT fabricate edges when the API returns none, and keeps the honesty note', async () => {
    mockTopologyResponse({
      subnets: ['10.0.2.0/24'],
      edges: [],
      layout: [],
      nodes: [
        { id: 'a', label: 'host-a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5' },
        { id: 'b', label: 'host-b', type: 'workstation', status: 'online', ipAddress: '10.0.2.9' },
        { id: 'gw', label: 'gateway', type: 'router', status: 'online', ipAddress: '10.0.2.1' }
      ]
    });

    render(<NetworkTopologyMap />);

    await waitFor(() => expect(cytoscapeFactory).toHaveBeenCalled());

    // No edge elements at all — the old synthetic star is gone.
    const edgeEls = cytoscapeElements().filter((el) => el.data.source !== undefined);
    expect(edgeEls).toHaveLength(0);

    // The honesty note explains why there are no links.
    expect(screen.getByTestId('topology-adjacency-note').textContent).toMatch(
      /appear only where real adjacency is measured/i
    );
  });

  it('renders a subnet legend with host counts', async () => {
    mockTopologyResponse({
      subnets: ['10.0.2.0/24', '192.168.0.0/16'],
      edges: [],
      layout: [],
      nodes: [
        { id: 'a', label: 'host-a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5' },
        { id: 'b', label: 'host-b', type: 'server', status: 'online', ipAddress: '10.0.2.9' },
        { id: 'c', label: 'host-c', type: 'printer', status: 'offline', ipAddress: '192.168.4.10' }
      ]
    });

    render(<NetworkTopologyMap />);

    const legend = await screen.findByTestId('topology-subnet-legend');
    expect(legend.textContent).toContain('10.0.2.0/24');
    expect(legend.textContent).toContain('192.168.0.0/16');
  });

  it('uses a /16 mask correctly instead of slicing 3 octets', async () => {
    // .4.x and .9.x are different /24s but the SAME /16 — they must group together.
    mockTopologyResponse({
      subnets: ['172.16.0.0/16'],
      edges: [],
      layout: [],
      nodes: [
        { id: 'a', label: 'a', type: 'workstation', status: 'online', ipAddress: '172.16.4.1' },
        { id: 'b', label: 'b', type: 'workstation', status: 'online', ipAddress: '172.16.9.250' }
      ]
    });

    render(<NetworkTopologyMap />);

    const legend = await screen.findByTestId('topology-subnet-legend');
    // The label span carries font-medium text-foreground; the count badge is
    // muted, so this selector targets the subnet labels only.
    const chips = legend.querySelectorAll('span.font-medium.text-foreground');
    const labels = Array.from(chips).map((c) => c.textContent);
    expect(labels).toEqual(['172.16.0.0/16']);
  });

  it('adds measured edge elements when the API provides them', async () => {
    mockTopologyResponse({
      subnets: ['10.0.2.0/24'],
      edges: [{ id: 'e1', source: 'sw', target: 'a', type: 'ethernet' }],
      layout: [],
      nodes: [
        { id: 'sw', label: 'switch', type: 'switch', status: 'online', ipAddress: '10.0.2.2' },
        { id: 'a', label: 'a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5' }
      ]
    });

    render(<NetworkTopologyMap />);

    await waitFor(() => expect(cytoscapeFactory).toHaveBeenCalled());
    const edgeEls = cytoscapeElements().filter((el) => el.data.source !== undefined);
    expect(edgeEls).toHaveLength(1);
    // Once real adjacency exists the provenance legend carries the meaning and
    // the empty-state honesty note is dropped.
    expect(screen.queryByTestId('topology-adjacency-note')).toBeNull();
    expect(screen.getByTestId('topology-provenance-legend').textContent).toMatch(/lldp\/cdp/i);
  });

  it('initializes a preset layout and carries provenance onto edge elements', async () => {
    mockTopologyResponse({
      nodes: [
        { id: 'a', label: 'edge', type: 'switch', status: 'online', ipAddress: '10.0.0.1' },
        { id: 'b', label: 'core', type: 'switch', status: 'online', ipAddress: '10.0.0.254' }
      ],
      subnets: ['10.0.0.0/24'],
      // A saved position for node "a" → preset layout consumes it.
      layout: [{ nodeType: 'discovered_asset', nodeId: 'a', x: 120, y: 240, pinned: true }],
      edges: [
        {
          id: 'e1',
          source: 'a',
          target: 'b',
          type: 'infra',
          sourceType: 'discovered_asset',
          targetType: 'discovered_asset',
          method: 'lldp',
          confidence: 'high',
          interfaceName: 'Gi0/1',
          vlan: null
        }
      ]
    });

    render(<NetworkTopologyMap />);

    // The provenance legend row appears.
    await waitFor(() => expect(screen.getByText(/LLDP\/CDP/i)).toBeInTheDocument());

    await waitFor(() => expect(cytoscapeFactory).toHaveBeenCalled());
    const cfg = lastCytoscapeConfig();
    // Preset layout (consume saved positions, never auto-layout-every-render).
    expect((cfg?.layout as { name?: string } | undefined)?.name).toBe('preset');

    // The measured LLDP edge carries its method onto the element data, so the
    // stylesheet can color it by provenance.
    const edgeEl = cytoscapeElements().find((el) => el.data.id === 'e1');
    expect(edgeEl?.data.method).toBe('lldp');

    // The saved position is fed into the element so preset honors it.
    const nodeA = cytoscapeElements().find((el) => el.data.id === 'a');
    expect(nodeA?.position).toEqual({ x: 120, y: 240 });

    // The stylesheet maps lldp/cdp to the high-confidence blue.
    const stylesheet = (cfg?.style as Array<{ selector: string; style: Record<string, unknown> }>) ?? [];
    const lldpRule = stylesheet.find((r) => /method *= *['"]?lldp/.test(r.selector));
    expect(lldpRule?.style['line-color']).toBe('#2563eb');
  });

  it('persists a drag via runAction PATCH to the layout route', async () => {
    fetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ upserted: 1 })
    } as unknown as Response);
    // First fetch is the topology GET; subsequent calls are the PATCH.
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        subnets: ['10.0.2.0/24'],
        edges: [],
        layout: [],
        nodes: [
          { id: 'a', label: 'host-a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5', siteId: 'site-1' }
        ]
      })
    } as unknown as Response);

    render(<NetworkTopologyMap />);

    await waitFor(() => expect(cyInstance.on).toHaveBeenCalledWith('dragfree', 'node', expect.any(Function)));
    expect(cyDragHandlers.length).toBeGreaterThan(0);

    // Simulate a drag-end on node "a" (a discovered asset → nodeType derives
    // from data('kind')).
    await cyDragHandlers[0]({
      target: {
        id: () => 'a',
        data: (key: string) => (key === 'kind' ? 'discovered' : undefined),
        position: () => ({ x: 88, y: 99 })
      }
    });

    await waitFor(() => expect(runAction).toHaveBeenCalled());
    const patchCall = fetchWithAuth.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('/discovery/topology/layout')
    );
    expect(patchCall).toBeTruthy();
    const init = patchCall?.[1] as RequestInit;
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(body.positions[0]).toMatchObject({ nodeType: 'discovered_asset', nodeId: 'a', x: 88, y: 99 });
    // The dragged node's own siteId (from the GET payload) scopes the upsert,
    // since layout rows are unique per (site_id, node_type, node_id) (#1728).
    expect(body.siteId).toBe('site-1');
  });

  it('runs Auto-arrange over never-placed nodes only (locks placed nodes)', async () => {
    const lock = vi.fn();
    const unlock = vi.fn();
    const layoutRun = vi.fn();
    cyInstance.nodes.mockReturnValue({
      length: 2,
      positions: vi.fn(),
      filter: vi.fn(() => ({ lock, unlock, layout: vi.fn(() => ({ run: layoutRun })) }))
    } as unknown as ReturnType<typeof cyInstance.nodes>);

    mockTopologyResponse({
      subnets: ['10.0.2.0/24'],
      edges: [],
      layout: [{ nodeType: 'discovered_asset', nodeId: 'a', x: 5, y: 5, pinned: true }],
      nodes: [
        { id: 'a', label: 'host-a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5' },
        { id: 'b', label: 'host-b', type: 'workstation', status: 'online', ipAddress: '10.0.2.9' }
      ]
    });

    canMock.mockReturnValue(true);
    render(<NetworkTopologyMap />);

    // Auto-arrange lives in edit mode (#1728) — enter it first.
    fireEvent.click(await screen.findByTestId('topology-edit-toggle'));
    const btn = await screen.findByTestId('topology-auto-arrange');
    fireEvent.click(btn);

    await waitFor(() => expect(lock).toHaveBeenCalled());
    expect(unlock).toHaveBeenCalled();
  });

  it('exposes a keyboard-accessible device list that drives the inspector + detail (#1728 P0)', async () => {
    const onNodeClick = vi.fn();
    mockTopologyResponse({
      subnets: ['10.0.2.0/24'],
      edges: [],
      layout: [],
      nodes: [
        { id: 'a', label: 'host-a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5' },
        { id: 'gw', label: 'gateway', type: 'router', status: 'online', ipAddress: '10.0.2.1' }
      ]
    });

    render(<NetworkTopologyMap onNodeClick={onNodeClick} />);

    // The canvas is a <canvas> with no focusable nodes; the device list is the
    // keyboard/screen-reader route. Each device is a real <button>.
    const row = await screen.findByTestId('topology-device-row-gw');
    expect(row.tagName).toBe('BUTTON');

    // Selecting a row opens the inspector for that device (same as a canvas tap)…
    fireEvent.click(row);
    const inspector = await screen.findByTestId('topology-inspector');
    expect(inspector).toHaveTextContent('gateway');
    expect(row).toHaveAttribute('aria-pressed', 'true');

    // …and a tap alone must NOT open the detail modal — that's the second step.
    expect(onNodeClick).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('topology-inspector-view-details'));
    expect(onNodeClick).toHaveBeenCalledWith('gw');
  });
});
