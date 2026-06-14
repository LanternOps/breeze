import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import NetworkTopologyMap from './NetworkTopologyMap';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args)
}));

function mockTopologyResponse(body: unknown) {
  fetchWithAuth.mockResolvedValue({
    ok: true,
    json: async () => body
  } as unknown as Response);
}

describe('NetworkTopologyMap', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
  });

  it('does NOT fabricate edges when the API returns none', async () => {
    mockTopologyResponse({
      subnets: ['10.0.2.0/24'],
      edges: [],
      nodes: [
        { id: 'a', label: 'host-a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5' },
        { id: 'b', label: 'host-b', type: 'workstation', status: 'online', ipAddress: '10.0.2.9' },
        { id: 'gw', label: 'gateway', type: 'router', status: 'online', ipAddress: '10.0.2.1' }
      ]
    });

    const { container } = render(<NetworkTopologyMap />);

    // Nodes render (one circle per node).
    await waitFor(() => {
      expect(container.querySelectorAll('.nodes circle')).toHaveLength(3);
    });

    // No edge lines at all — the old synthetic star is gone.
    expect(container.querySelectorAll('.links line')).toHaveLength(0);

    // The honesty note explains why there are no links.
    expect(screen.getByTestId('topology-adjacency-note').textContent).toMatch(
      /shown only when real adjacency is measured/i
    );
  });

  it('groups nodes by their real subnet and renders a subnet legend with host counts', async () => {
    mockTopologyResponse({
      subnets: ['10.0.2.0/24', '192.168.0.0/16'],
      edges: [],
      nodes: [
        { id: 'a', label: 'host-a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5' },
        { id: 'b', label: 'host-b', type: 'server', status: 'online', ipAddress: '10.0.2.9' },
        { id: 'c', label: 'host-c', type: 'printer', status: 'offline', ipAddress: '192.168.4.10' }
      ]
    });

    render(<NetworkTopologyMap />);

    const legend = await screen.findByTestId('topology-subnet-legend');
    // Both real subnets appear as labels.
    expect(legend.textContent).toContain('10.0.2.0/24');
    expect(legend.textContent).toContain('192.168.0.0/16');

    // The /24 holds 2 hosts, the /16 holds 1 — the SVG renders per-group
    // labels with host counts.
    await waitFor(() => {
      const labels = Array.from(document.querySelectorAll('.subnet-group-label'));
      const text = labels.map((l) => l.textContent).join(' ');
      expect(text).toContain('10.0.2.0/24');
      expect(text).toContain('2 hosts');
      expect(text).toContain('192.168.0.0/16');
      expect(text).toContain('1 host');
    });
  });

  it('uses a /16 mask correctly instead of slicing 3 octets', async () => {
    // .4.x and .9.x are different /24s but the SAME /16 — they must land together.
    mockTopologyResponse({
      subnets: ['172.16.0.0/16'],
      edges: [],
      nodes: [
        { id: 'a', label: 'a', type: 'workstation', status: 'online', ipAddress: '172.16.4.1' },
        { id: 'b', label: 'b', type: 'workstation', status: 'online', ipAddress: '172.16.9.250' }
      ]
    });

    render(<NetworkTopologyMap />);

    const legend = await screen.findByTestId('topology-subnet-legend');
    // A single grouped entry for the /16 holding both hosts (count = 2).
    const chips = legend.querySelectorAll('span > span.font-medium');
    const labels = Array.from(chips).map((c) => c.textContent);
    expect(labels).toEqual(['172.16.0.0/16']);
  });

  it('renders measured edges when the API does provide them', async () => {
    mockTopologyResponse({
      subnets: ['10.0.2.0/24'],
      edges: [{ id: 'e1', source: 'sw', target: 'a', type: 'ethernet' }],
      nodes: [
        { id: 'sw', label: 'switch', type: 'switch', status: 'online', ipAddress: '10.0.2.2' },
        { id: 'a', label: 'a', type: 'workstation', status: 'online', ipAddress: '10.0.2.5' }
      ]
    });

    const { container } = render(<NetworkTopologyMap />);

    await waitFor(() => {
      expect(container.querySelectorAll('.links line')).toHaveLength(1);
    });
    expect(screen.getByTestId('topology-adjacency-note').textContent).toMatch(
      /reflect measured adjacency/i
    );
  });
});
