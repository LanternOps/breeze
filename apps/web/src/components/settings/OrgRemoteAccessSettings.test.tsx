import '@/lib/i18n';

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgRemoteAccessSettings from './OrgRemoteAccessSettings';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const SITE = { id: 'site-1', name: 'HQ' };

const PROXY_TUNNEL = {
  id: 'tun-proxy-1',
  siteId: 'site-1',
  type: 'proxy' as const,
  target: '10.0.0.5:443',
  agentName: 'agent-a',
  startedAt: new Date().toISOString(),
  bytesTransferred: 0,
};

const VNC_TUNNEL = {
  id: 'tun-vnc-1',
  siteId: 'site-1',
  type: 'vnc' as const,
  target: 'agent-b',
  agentName: 'agent-b',
  startedAt: new Date().toISOString(),
  bytesTransferred: 0,
};

function mockRoutes(tunnels: unknown[]) {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/tunnels?status=active') {
      return Promise.resolve(makeJsonResponse({ tunnels }));
    }
    if (url.startsWith('/tunnels/allowlist')) {
      return Promise.resolve(makeJsonResponse({ rules: [] }));
    }
    return Promise.resolve(makeJsonResponse({}));
  });
}

describe('OrgRemoteAccessSettings — proxy tunnel rows link to the proxy page', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('links a proxy tunnel row target to /remote/proxy/<id>?target=..., but leaves a vnc row as plain text', async () => {
    mockRoutes([PROXY_TUNNEL, VNC_TUNNEL]);

    render(<OrgRemoteAccessSettings orgId="org-1" sites={[SITE]} onDirty={() => {}} />);

    // Expand the site accordion to reveal the Active Tunnels table.
    fireEvent.click(await screen.findByText('HQ'));

    const link = await screen.findByTestId('remote-access-tunnel-link-tun-proxy-1');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(
      `/remote/proxy/tun-proxy-1?target=${encodeURIComponent('10.0.0.5:443')}`,
    );

    // The vnc row's target is NOT linked.
    expect(screen.queryByTestId('remote-access-tunnel-link-tun-vnc-1')).not.toBeInTheDocument();
    const vncTargetCell = screen.getByText('agent-b', { selector: 'code' });
    expect(vncTargetCell.closest('a')).toBeNull();
  });

  it('Kill still closes the tunnel via DELETE /tunnels/:id and works independently of the new link', async () => {
    mockRoutes([PROXY_TUNNEL]);

    render(<OrgRemoteAccessSettings orgId="org-1" sites={[SITE]} onDirty={() => {}} />);

    fireEvent.click(await screen.findByText('HQ'));
    await screen.findByTestId('remote-access-tunnel-link-tun-proxy-1');

    fireEvent.click(screen.getByTitle('Close tunnel'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/tunnels/tun-proxy-1', expect.objectContaining({ method: 'DELETE' })),
    );
  });

  it('shows the empty state when there are no active tunnels', async () => {
    mockRoutes([]);

    render(<OrgRemoteAccessSettings orgId="org-1" sites={[SITE]} onDirty={() => {}} />);

    fireEvent.click(await screen.findByText('HQ'));

    expect(await screen.findByText('(No active tunnels)')).toBeInTheDocument();
  });
});
