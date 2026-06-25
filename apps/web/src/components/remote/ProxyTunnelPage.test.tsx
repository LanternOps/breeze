import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProxyTunnelPage from './ProxyTunnelPage';
import { fetchWithAuth } from '@/stores/auth';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown = {}, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response);

const TUNNEL_ID = 'tunnel-123';

beforeEach(() => {
  fetchMock.mockReset();
});

describe('ProxyTunnelPage', () => {
  it('mints an http-ticket and renders the proxied service in an iframe', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') {
        // The mint endpoint wraps the ticket.
        return makeResponse({ ticket: { ticket: 'TKT-abc', expiresInSeconds: 300 } });
      }
      if (url === `/tunnels/${TUNNEL_ID}`) {
        return makeResponse({ status: 'connecting' });
      }
      return makeResponse({});
    });

    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);

    const frame = await screen.findByTestId('network-proxy-frame');
    expect(frame.getAttribute('src')).toContain(
      `/api/v1/tunnel-http/${TUNNEL_ID}/?__bzt=TKT-abc`,
    );
    // Untrusted device content must be sandboxed without allow-same-origin.
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');

    // The mint call was actually made with POST.
    expect(fetchMock).toHaveBeenCalledWith(
      `/tunnels/${TUNNEL_ID}/http-ticket`,
      expect.objectContaining({ method: 'POST' }),
    );

    // "Open in new tab" points at the same proxy URL.
    const openLink = screen.getByRole('link', { name: /open in new tab/i });
    expect(openLink.getAttribute('href')).toContain(`/api/v1/tunnel-http/${TUNNEL_ID}/?__bzt=TKT-abc`);
  });

  it('shows an error when the ticket cannot be minted', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') {
        return makeResponse({ error: 'No proxy access' }, false);
      }
      return makeResponse({ status: 'connecting' });
    });

    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);

    expect(await screen.findByText('No proxy access')).toBeInTheDocument();
    expect(screen.queryByTestId('network-proxy-frame')).not.toBeInTheDocument();
  });

  it('surfaces a server-side tunnel failure from the status poll', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') {
        return makeResponse({ ticket: { ticket: 'TKT-abc', expiresInSeconds: 300 } });
      }
      if (url === `/tunnels/${TUNNEL_ID}`) {
        return makeResponse({ status: 'failed', error: 'Tunnel open failed on agent' });
      }
      return makeResponse({});
    });

    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);

    await waitFor(() => {
      expect(screen.getByText('Tunnel open failed on agent')).toBeInTheDocument();
    });
  });

  it('shows the recreate-with-self-signed banner on tls_cert_untrusted', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') {
        return makeResponse({ ticket: { ticket: 'TKT-abc', expiresInSeconds: 300 } });
      }
      if (url === `/tunnels/${TUNNEL_ID}`) {
        return makeResponse({ status: 'failed', errorMessage: 'tls_cert_untrusted' });
      }
      return makeResponse({});
    });

    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:8443" />);

    await screen.findByText(/self-signed certificate/i);
    expect(screen.getByText(/recreate the proxy session/i)).toBeInTheDocument();
  });
});
