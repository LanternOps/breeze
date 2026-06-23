import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import NetworkTopologyMap from './NetworkTopologyMap';

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
    getElementById: vi.fn(() => ({ empty: () => true, data: vi.fn(), remove: vi.fn() })),
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
});
