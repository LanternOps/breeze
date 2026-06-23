import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import NetworkTopologyMap, { type TopologyEditApi } from './NetworkTopologyMap';

// jsdom lacks ResizeObserver; Cytoscape (and the layout plugins) reference it.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args)
}));

const runAction = vi.fn(async (opts: { request: () => Promise<Response> }) => {
  const res = await opts.request();
  return res.json();
});
const handleActionError = vi.fn();
vi.mock('@/lib/runAction', () => ({
  runAction: (...args: unknown[]) => (runAction as (...a: unknown[]) => unknown)(...args),
  handleActionError: (...args: unknown[]) => handleActionError(...args),
  ActionError: class ActionError extends Error {}
}));

const canMock = vi.fn();
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (...a: unknown[]) => canMock(...a) })
}));

// Cytoscape needs a real factory; provide a no-op chainable so the component can
// mount in jsdom (mirrors the Phase 3 NetworkTopologyMap.test.tsx convention).
const { cyInstance, cytoscapeFactory } = vi.hoisted(() => {
  const instance = {
    on: vi.fn(),
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
    getElementById: vi.fn((_id: string) => ({
      empty: () => true as boolean,
      data: (_key: string) => undefined as unknown,
      remove: vi.fn()
    })),
    elements: vi.fn(() => ({ remove: vi.fn() })),
    fit: vi.fn()
  };
  const factory = vi.fn(() => instance) as ReturnType<typeof vi.fn> & {
    use: ReturnType<typeof vi.fn>;
  };
  factory.use = vi.fn();
  return { cyInstance: instance, cytoscapeFactory: factory };
});
vi.mock('cytoscape', () => ({ default: cytoscapeFactory }));
vi.mock('cytoscape-fcose', () => ({ default: vi.fn() }));

function mockTopologyResponse(body: unknown) {
  fetchWithAuth.mockResolvedValue({
    ok: true,
    json: async () => body
  } as unknown as Response);
}

describe('NetworkTopologyMap edit mode (#1728 phase 4)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    runAction.mockClear();
    handleActionError.mockClear();
    canMock.mockReset();
    cytoscapeFactory.mockClear();
    cyInstance.on.mockClear();
    cyInstance.add.mockClear();
    mockTopologyResponse({
      subnets: ['10.0.2.0/24'],
      edges: [],
      layout: [],
      nodes: [
        {
          id: 'a',
          label: 'host-a',
          type: 'workstation',
          status: 'online',
          ipAddress: '10.0.2.5',
          siteId: 'site-1'
        }
      ]
    });
  });

  it('shows the edit-mode toggle when the user has topology:write', async () => {
    canMock.mockReturnValue(true);

    render(<NetworkTopologyMap />);

    expect(await screen.findByTestId('topology-edit-toggle')).toBeInTheDocument();
    expect(canMock).toHaveBeenCalledWith('topology', 'write');
  });

  it('hides the edit-mode toggle when the user lacks topology:write', async () => {
    canMock.mockReturnValue(false);

    render(<NetworkTopologyMap />);

    // Canvas still mounts, but the toggle is absent.
    expect(await screen.findByTestId('topology-cytoscape')).toBeInTheDocument();
    await waitFor(() => expect(cytoscapeFactory).toHaveBeenCalled());
    expect(screen.queryByTestId('topology-edit-toggle')).toBeNull();
  });

  it('add-node palette posts a manual node via runAction and adds it to the canvas', async () => {
    canMock.mockReturnValue(true);
    const user = userEvent.setup();

    render(<NetworkTopologyMap />);

    // Enter edit mode to reveal the palette.
    await user.click(await screen.findByTestId('topology-edit-toggle'));

    // The POST resolves with the created node.
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'n1', role: 'switch', label: 'Switch', kind: 'manual' })
    } as unknown as Response);

    await user.click(await screen.findByTestId('topology-add-node-switch'));

    await waitFor(() => {
      const postCall = fetchWithAuth.mock.calls.find(
        ([url]) => url === '/discovery/topology/manual-node'
      );
      expect(postCall).toBeTruthy();
      const opts = postCall![1] as { method?: string; body?: string };
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body ?? '{}');
      expect(body.role).toBe('switch');
      expect(body.siteId).toBe('site-1');
    });

    // runAction's success path ran, and the returned node was added to the graph.
    expect(runAction).toHaveBeenCalled();
    await waitFor(() => {
      expect(cyInstance.add).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ id: 'n1', kind: 'manual', role: 'switch' })
        })
      );
    });
    expect(handleActionError).not.toHaveBeenCalled();
  });

  it('connectNodes posts a manual edge via runAction and adds it to the canvas', async () => {
    canMock.mockReturnValue(true);

    // Make the two endpoints resolvable on the (mocked) cy instance:
    // n1 is a manual placeholder, a1 is a discovered asset.
    const kindById: Record<string, string> = { n1: 'manual', a1: 'discovered' };
    cyInstance.getElementById.mockImplementation((id: string) => ({
      empty: () => !(id in kindById),
      data: (key: string) => (key === 'kind' ? kindById[id] : id),
      remove: vi.fn()
    }));

    // Capture the edit API the component publishes (used by both the connect
    // gesture and the test).
    let connectNodes: ((sourceId: string, targetId: string) => Promise<void>) | undefined;

    render(<NetworkTopologyMap onEditApiReady={(api) => (connectNodes = api.connectNodes)} />);

    await waitFor(() => expect(cytoscapeFactory).toHaveBeenCalled());
    await waitFor(() => expect(connectNodes).toBeDefined());

    // The POST resolves with the created edge.
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'e1', method: 'manual', confidence: 'asserted' })
    } as unknown as Response);

    await connectNodes!('n1', 'a1');

    const postCall = fetchWithAuth.mock.calls.find(
      ([url]) => url === '/discovery/topology/manual-edge'
    );
    expect(postCall).toBeTruthy();
    const opts = postCall![1] as { method?: string; body?: string };
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body ?? '{}');
    expect(body.siteId).toBe('site-1');
    expect(body.source).toEqual({ type: 'manual_node', id: 'n1' });
    expect(body.target).toEqual({ type: 'discovered_asset', id: 'a1' });

    // The returned manual edge is added to the graph (dashed-orange style keyed
    // on method:'manual').
    expect(runAction).toHaveBeenCalled();
    await waitFor(() => {
      expect(cyInstance.add).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            id: 'e1',
            source: 'n1',
            target: 'a1',
            method: 'manual',
            confidence: 'asserted'
          })
        })
      );
    });
    expect(handleActionError).not.toHaveBeenCalled();
  });

  it('connectNodes refuses a self-connect (no POST)', async () => {
    canMock.mockReturnValue(true);
    const kindById: Record<string, string> = { n1: 'manual' };
    cyInstance.getElementById.mockImplementation((id: string) => ({
      empty: () => !(id in kindById),
      data: (key: string) => (key === 'kind' ? kindById[id] : id),
      remove: vi.fn()
    }));

    let connectNodes: ((sourceId: string, targetId: string) => Promise<void>) | undefined;
    render(<NetworkTopologyMap onEditApiReady={(api) => (connectNodes = api.connectNodes)} />);
    await waitFor(() => expect(connectNodes).toBeDefined());

    await connectNodes!('n1', 'n1');

    expect(
      fetchWithAuth.mock.calls.find(([url]) => url === '/discovery/topology/manual-edge')
    ).toBeUndefined();
    expect(cyInstance.add).not.toHaveBeenCalled();
  });

  it('selecting a manual edge in edit mode deletes it via runAction', async () => {
    canMock.mockReturnValue(true);
    const removeSpy = vi.fn();
    cyInstance.getElementById.mockImplementation((_id: string) => ({
      empty: () => false,
      data: (_key: string) => undefined,
      remove: removeSpy
    }));

    let api: TopologyEditApi | undefined;
    render(<NetworkTopologyMap onEditApiReady={(a) => (api = a)} />);
    await waitFor(() => expect(api).toBeDefined());

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('topology-edit-toggle'));

    // Select a manual edge through the exposed selection API.
    api!.selectElement({ id: 'e1', group: 'edges', method: 'manual', confidence: 'asserted' });

    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    } as unknown as Response);

    await user.click(await screen.findByTestId('topology-delete-edge'));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        ([url]) => url === '/discovery/topology/manual-edge/e1'
      );
      expect(call).toBeTruthy();
      const opts = call![1] as { method?: string };
      expect(opts.method).toBe('DELETE');
    });
    expect(runAction).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(handleActionError).not.toHaveBeenCalled();
  });

  it('selecting a measured edge shows read-only provenance and no delete button', async () => {
    canMock.mockReturnValue(true);

    let api: TopologyEditApi | undefined;
    render(<NetworkTopologyMap onEditApiReady={(a) => (api = a)} />);
    await waitFor(() => expect(api).toBeDefined());

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('topology-edit-toggle'));

    api!.selectElement({
      id: 'm1',
      group: 'edges',
      method: 'fdb',
      confidence: 'medium',
      interfaceName: 'Gi0/1',
      vlan: 10
    });

    const provenance = await screen.findByTestId('topology-edge-provenance');
    expect(provenance).toHaveTextContent('FDB');
    expect(screen.queryByTestId('topology-delete-edge')).toBeNull();
  });

  it('selecting a manual node in edit mode deletes it via runAction', async () => {
    canMock.mockReturnValue(true);
    const removeSpy = vi.fn();
    const connectedRemoveSpy = vi.fn();
    cyInstance.getElementById.mockImplementation((_id: string) => ({
      empty: () => false,
      data: (_key: string) => undefined,
      remove: removeSpy,
      connectedEdges: () => ({ remove: connectedRemoveSpy })
    }));

    let api: TopologyEditApi | undefined;
    render(<NetworkTopologyMap onEditApiReady={(a) => (api = a)} />);
    await waitFor(() => expect(api).toBeDefined());

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('topology-edit-toggle'));

    api!.selectElement({ id: 'n1', group: 'nodes', kind: 'manual' });

    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    } as unknown as Response);

    await user.click(await screen.findByTestId('topology-delete-node'));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        ([url]) => url === '/discovery/topology/manual-node/n1'
      );
      expect(call).toBeTruthy();
      const opts = call![1] as { method?: string };
      expect(opts.method).toBe('DELETE');
    });
    expect(runAction).toHaveBeenCalled();
    expect(connectedRemoveSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(handleActionError).not.toHaveBeenCalled();
  });
});
