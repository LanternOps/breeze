import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const NEW_TUNNEL_ID = 'tunnel-456';
const ASSET_ID = 'asset-789';
const DEVICE_ID = 'device-abc';

// jsdom refuses real navigation, so swap `window.location` for a recorder
// (pattern from VncViewerPage.test.tsx). It is a configurable accessor
// property here, so it restores cleanly in afterEach.
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location')!;
let navigations: string[] = [];

const installLocationRecorder = () => {
  navigations = [];
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      origin: 'http://localhost:3000',
      _href: 'http://localhost:3000/remote/proxy/tunnel-123',
      get href() {
        return this._href;
      },
      set href(next: string) {
        navigations.push(next);
        this._href = next;
      },
    },
  });
};

beforeEach(() => {
  fetchMock.mockReset();
  installLocationRecorder();
});

afterEach(() => {
  Object.defineProperty(window, 'location', originalLocationDescriptor);
});

const sessionFieldsPayload = {
  deviceId: DEVICE_ID,
  targetHost: '10.1.2.209',
  targetPort: 80,
  scheme: 'http',
  skipTlsVerify: false,
};

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

    // No expiry overlay while connectable and fresh.
    expect(screen.queryByTestId('proxy-session-expired-overlay')).not.toBeInTheDocument();
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

  it('shows the session-expired overlay on a server-side terminal failure and Reconnect creates a new tunnel', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') {
        return makeResponse({ ticket: { ticket: 'TKT-abc', expiresInSeconds: 300 } });
      }
      if (url === `/tunnels/${TUNNEL_ID}`) {
        return makeResponse({
          status: 'failed',
          error: 'Tunnel open failed on agent',
          idleSeconds: 12,
          ...sessionFieldsPayload,
        });
      }
      if (url === '/tunnels' && opts?.method === 'POST') {
        return makeResponse({ id: NEW_TUNNEL_ID });
      }
      return makeResponse({});
    });

    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" assetId={ASSET_ID} />);

    // The overlay appears for a terminal status.
    const overlay = await screen.findByTestId('proxy-session-expired-overlay');
    expect(overlay).toBeInTheDocument();
    // The stale status badge is not shown alongside the overlay.
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();

    const reconnectButton = screen.getByRole('button', { name: /^reconnect$/i });
    reconnectButton.click();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tunnels',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            deviceId: DEVICE_ID,
            type: 'proxy',
            targetHost: '10.1.2.209',
            targetPort: 80,
            scheme: 'http',
            skipTlsVerify: false,
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(navigations).toEqual([
        `/remote/proxy/${NEW_TUNNEL_ID}?target=${encodeURIComponent('10.1.2.209:80')}&asset=${ASSET_ID}`,
      ]);
    });
  });

  it('shows the session-expired overlay when idleSeconds exceeds the threshold and Reconnect re-mints the ticket in place', async () => {
    let pollCount = 0;
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') {
        pollCount += 1;
        return makeResponse({ ticket: { ticket: `TKT-${pollCount}`, expiresInSeconds: 300 } });
      }
      if (url === `/tunnels/${TUNNEL_ID}`) {
        return makeResponse({
          status: 'active',
          idleSeconds: 400, // > 330 threshold
          ...sessionFieldsPayload,
        });
      }
      return makeResponse({});
    });

    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);

    const overlay = await screen.findByTestId('proxy-session-expired-overlay');
    expect(overlay).toBeInTheDocument();

    const mintCallsBefore = fetchMock.mock.calls.filter(
      ([url, o]) => url === `/tunnels/${TUNNEL_ID}/http-ticket` && (o as RequestInit)?.method === 'POST',
    ).length;

    const reconnectButton = screen.getByRole('button', { name: /^reconnect$/i });
    reconnectButton.click();

    await waitFor(() => {
      const mintCallsAfter = fetchMock.mock.calls.filter(
        ([url, o]) => url === `/tunnels/${TUNNEL_ID}/http-ticket` && (o as RequestInit)?.method === 'POST',
      ).length;
      expect(mintCallsAfter).toBeGreaterThan(mintCallsBefore);
    });

    // No new tunnel was created — this is an in-place re-mint, not a re-create.
    expect(fetchMock.mock.calls.some(([url, o]) => url === '/tunnels' && (o as RequestInit)?.method === 'POST')).toBe(false);
    expect(navigations).toEqual([]);
  });

  it('shows the untrusted-certificate screen on tls_cert_untrusted with a working self-signed retry button', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') {
        return makeResponse({ ticket: { ticket: 'TKT-abc', expiresInSeconds: 300 } });
      }
      if (url === `/tunnels/${TUNNEL_ID}`) {
        return makeResponse({
          status: 'failed',
          errorMessage: 'tls_cert_untrusted',
          idleSeconds: 5,
          ...sessionFieldsPayload,
          scheme: 'https',
          targetPort: 8443,
          skipTlsVerify: false,
        });
      }
      if (url === '/tunnels' && opts?.method === 'POST') {
        return makeResponse({ id: NEW_TUNNEL_ID });
      }
      return makeResponse({});
    });

    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:8443" />);

    expect(
      await screen.findByText('This device presented an untrusted or self-signed certificate.'),
    ).toBeInTheDocument();

    // The generic expiry overlay must NOT also appear — the TLS screen owns
    // this failure mode with its own dedicated retry.
    expect(screen.queryByTestId('proxy-session-expired-overlay')).not.toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: /reconnect allowing self-signed certificate/i });
    retryButton.click();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tunnels',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            deviceId: DEVICE_ID,
            type: 'proxy',
            targetHost: '10.1.2.209',
            targetPort: 8443,
            scheme: 'https',
            skipTlsVerify: true, // forced true regardless of the row's original value
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(navigations).toEqual([`/remote/proxy/${NEW_TUNNEL_ID}?target=${encodeURIComponent('10.1.2.209:8443')}`]);
    });
  });

  it('targets the asset page for Back when an assetId is present, else falls back to /remote', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/tunnels/${TUNNEL_ID}`) return makeResponse({ status: 'connecting' });
      return makeResponse({ ticket: { ticket: 'TKT-abc', expiresInSeconds: 300 } });
    });

    const { unmount } = render(
      <ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" assetId={ASSET_ID} />,
    );
    const backLinkWithAsset = await screen.findByRole('link', { name: /back/i });
    expect(backLinkWithAsset.getAttribute('href')).toBe(`/devices/network/${ASSET_ID}`);
    unmount();

    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);
    const backLinkNoAsset = await screen.findByRole('link', { name: /back/i });
    expect(backLinkNoAsset.getAttribute('href')).toBe('/remote');
  });
});
