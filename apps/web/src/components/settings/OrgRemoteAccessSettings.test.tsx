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

    render(<OrgRemoteAccessSettings orgId="org-1" sites={[SITE]} />);

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

    render(<OrgRemoteAccessSettings orgId="org-1" sites={[SITE]} />);

    fireEvent.click(await screen.findByText('HQ'));
    await screen.findByTestId('remote-access-tunnel-link-tun-proxy-1');

    fireEvent.click(screen.getByTitle('Close tunnel'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/tunnels/tun-proxy-1', expect.objectContaining({ method: 'DELETE' })),
    );
  });

  it('shows the empty state when there are no active tunnels', async () => {
    mockRoutes([]);

    render(<OrgRemoteAccessSettings orgId="org-1" sites={[SITE]} />);

    fireEvent.click(await screen.findByText('HQ'));

    expect(await screen.findByText('(No active tunnels)')).toBeInTheDocument();
  });
});

// Regression for #3432: this tab used to mark the whole Org Settings page
// "unsaved" and could never clear it, so a `beforeunload` prompt fired on the
// way out even though nothing was pending. The allowlist controls each persist
// through their own request, so there is no draft state to warn about — the
// tab must not accept an onDirty channel at all.
describe('OrgRemoteAccessSettings — never reports unsaved changes (#3432)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('persists an added allowlist rule immediately, with no dirty-state channel to the parent', async () => {
    mockRoutes([]);

    render(<OrgRemoteAccessSettings orgId="org-1" sites={[SITE]} />);

    fireEvent.click(await screen.findByText('HQ'));

    fireEvent.click(await screen.findByText('Add Rule'));
    fireEvent.change(screen.getByPlaceholderText('192.168.1.0/24:5900-5910'), {
      target: { value: '192.168.1.0/24:5900-5910' },
    });
    fireEvent.click(screen.getByText('Save'));

    // The rule round-trips to the API on its own — nothing is left unsaved.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/tunnels/allowlist',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('no longer renders the source-IP restriction control, which never persisted anywhere', async () => {
    mockRoutes([]);

    render(<OrgRemoteAccessSettings orgId="org-1" sites={[SITE]} />);
    await screen.findByText('HQ');

    expect(screen.queryByText('Source IP Restrictions')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('e.g. 10.0.0.0/8')).not.toBeInTheDocument();
  });
});
