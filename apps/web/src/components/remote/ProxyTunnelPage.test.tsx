import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ProxyTunnelPage from './ProxyTunnelPage';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
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

    // "Open in new tab" must not reuse the iframe's (already consumed) ticket URL.
    expect(screen.queryByRole('link', { name: /open in new tab/i })).not.toBeInTheDocument();

    // No expiry overlay while connectable and fresh.
    expect(screen.queryByTestId('proxy-session-expired-overlay')).not.toBeInTheDocument();
  });

  describe('Open In New Tab', () => {
    // A fake popup window: records what the page does to it.
    const makePopup = () => ({
      opener: {} as unknown,
      closed: false,
      close: vi.fn(),
      location: { replace: vi.fn() },
    });

    const mintSequence = (tickets: Array<string | null>) => {
      let mints = 0;
      fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
        // The iframe mints `/http-ticket`, the new tab `/http-ticket?mode=tab`.
        if (url.startsWith(`/tunnels/${TUNNEL_ID}/http-ticket`) && opts?.method === 'POST') {
          const next = tickets[Math.min(mints++, tickets.length - 1)];
          return next
            ? makeResponse({ ticket: { ticket: next, expiresInSeconds: 300 } })
            : makeResponse({ error: 'No proxy access' }, false);
        }
        return makeResponse({ status: 'connecting' });
      });
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('mints a fresh ticket for the new tab instead of reusing the iframe\'s consumed one', async () => {
      mintSequence(['TKT-iframe', 'TKT-tab']);
      const popup = makePopup();
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);
      await screen.findByTestId('network-proxy-frame');

      fireEvent.click(screen.getByRole('button', { name: /open in new tab/i }));

      // Opened synchronously inside the click (popup blockers), as a blank page
      // with no handle back to this window.
      expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
      expect(popup.opener).toBeNull();

      await waitFor(() =>
        expect(popup.location.replace).toHaveBeenCalledWith(
          expect.stringContaining(`/api/v1/tunnel-http/${TUNNEL_ID}/?__bzt=TKT-tab`),
        ),
      );
      const mintCalls = fetchMock.mock.calls.map(([url]) => url).filter((url) => url.startsWith(`/tunnels/${TUNNEL_ID}/http-ticket`));
      expect(mintCalls).toEqual([`/tunnels/${TUNNEL_ID}/http-ticket`, `/tunnels/${TUNNEL_ID}/http-ticket?mode=tab`]);
      // The iframe keeps its own session.
      expect(screen.getByTestId('network-proxy-frame').getAttribute('src')).toContain('__bzt=TKT-iframe');
    });

    it('closes the blank tab and surfaces the error when the new ticket cannot be minted', async () => {
      mintSequence(['TKT-iframe', null]);
      const popup = makePopup();
      vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);
      await screen.findByTestId('network-proxy-frame');
      fireEvent.click(screen.getByRole('button', { name: /open in new tab/i }));

      await waitFor(() => expect(popup.close).toHaveBeenCalled());
      expect(popup.location.replace).not.toHaveBeenCalled();
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'No proxy access' }),
      );
      // The iframe session is untouched by a failed new-tab mint.
      expect(screen.getByTestId('network-proxy-frame')).toBeInTheDocument();
    });

    it('does nothing further when the browser blocks the popup', async () => {
      mintSequence(['TKT-iframe', 'TKT-tab']);
      vi.spyOn(window, 'open').mockReturnValue(null);

      render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);
      await screen.findByTestId('network-proxy-frame');
      fireEvent.click(screen.getByRole('button', { name: /open in new tab/i }));

      // No ticket is minted for a tab that never opened.
      await new Promise((r) => setTimeout(r, 0));
      const mintCalls = fetchMock.mock.calls.filter(([url]) => url.startsWith(`/tunnels/${TUNNEL_ID}/http-ticket`));
      expect(mintCalls).toHaveLength(1);
    });
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

// ── Dedicated tunnel origin (#8155 W03) ───────────────────────────────────
const HOST_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const HOST_ORIGIN = `https://${HOST_ID}.us.breezetunnel.test`;
const HOST_URL = `${HOST_ORIGIN}/__bz/enter?t=TKT`;
const HOST_TAB_URL = `${HOST_ORIGIN}/__bz/enter?t=TAB&mode=tab`;
const HOST_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';
const COOKIE_BLOCKED = 'breeze-tunnel-cookie-blocked';

function hostModeFetch(overrides: Record<string, () => Response> = {}) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const key = `${opts?.method ?? 'GET'} ${url}`;
    if (overrides[key]) return overrides[key]!();
    if (key === `POST /tunnels/${HOST_ID}/http-ticket`) {
      return makeResponse({ ticket: { ticket: 'TKT', expiresInSeconds: 300 }, url: HOST_URL, mode: 'host' });
    }
    if (key === `POST /tunnels/${HOST_ID}/http-ticket?mode=tab`) {
      return makeResponse({ ticket: { ticket: 'TAB', expiresInSeconds: 300 }, url: HOST_TAB_URL, mode: 'host' });
    }
    if (key === `GET /tunnels/${HOST_ID}`) return makeResponse({ status: 'active', idleSeconds: 0 });
    return makeResponse({});
  });
}

const pathModeTicket = () =>
  makeResponse({
    ticket: { ticket: 'P', expiresInSeconds: 300 },
    url: `/api/v1/tunnel-http/${HOST_ID}/?__bzt=P`,
    mode: 'path',
  });

const fakePopup = () => ({ opener: {} as unknown, close: vi.fn(), location: { replace: vi.fn() } });

const postFromFrame = (
  frame: HTMLElement,
  data: unknown,
  origin = HOST_ORIGIN,
  source: MessageEventSource | null = (frame as HTMLIFrameElement).contentWindow,
) => {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { origin, data, source }));
  });
};

// The component registers its window `message` listener in a passive effect that
// can commit after the iframe is already in the DOM (slow under load, #9159), so a
// single post can be lost. Re-post until `check` passes; the assertion stays strict.
const postUntil = (frame: HTMLElement, data: unknown, check: () => void) =>
  waitFor(
    () => {
      postFromFrame(frame, data);
      check();
    },
    // Kept under the 5s per-test timeout so a real failure reports the assertion, not a bare timeout.
    { timeout: 3000 },
  );

describe('ProxyTunnelPage host mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(showToast).mockClear();
  });

  it('renders the server URL with the host-mode sandbox', async () => {
    hostModeFetch();
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    const frame = await screen.findByTestId('network-proxy-frame');
    expect(frame.getAttribute('src')).toBe(HOST_URL);
    expect(frame.getAttribute('data-proxy-mode')).toBe('host');
    expect(frame.getAttribute('sandbox')).toBe(HOST_SANDBOX);
  });

  it('renders a server path-mode URL against the API base with the opaque-origin sandbox', async () => {
    hostModeFetch({ [`POST /tunnels/${HOST_ID}/http-ticket`]: pathModeTicket });
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    const frame = await screen.findByTestId('network-proxy-frame');
    expect(frame.getAttribute('src')).toBe(`http://localhost:3000/api/v1/tunnel-http/${HOST_ID}/?__bzt=P`);
    expect(frame.getAttribute('data-proxy-mode')).toBe('path');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
  });

  it.each([
    ['the app origin', 'http://localhost:3000/__bz/enter?t=T'],
    ['another tunnel', 'https://ffffffff-ffff-4fff-8fff-ffffffffffff.us.breezetunnel.test/__bz/enter?t=T'],
    ['a tab URL in the iframe', `${HOST_ORIGIN}/__bz/enter?t=T&mode=tab`],
    ['a non-string url', 42],
  ])('refuses a server URL on %s and never renders a frame', async (_label, url) => {
    hostModeFetch({
      [`POST /tunnels/${HOST_ID}/http-ticket`]: () =>
        makeResponse({ ticket: { ticket: 'T', expiresInSeconds: 300 }, url, mode: 'host' }),
    });
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    expect(await screen.findByText('The server returned an invalid proxy address.')).toBeInTheDocument();
    expect(screen.queryByTestId('network-proxy-frame')).toBeNull();
  });

  it('falls back to composing the path URL when an older API returns no url', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') {
        return makeResponse({ ticket: { ticket: 'TKT-abc', expiresInSeconds: 300 } });
      }
      return makeResponse({ status: 'connecting' });
    });
    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);
    const frame = await screen.findByTestId('network-proxy-frame');
    expect(frame.getAttribute('data-proxy-mode')).toBe('path');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
  });

  describe('cookie-blocked notice', () => {
    it('ignores a message from another origin, another tunnel, another window or of another type', async () => {
      hostModeFetch();
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      const frame = await screen.findByTestId('network-proxy-frame');
      const msg = { type: COOKIE_BLOCKED, tunnelId: HOST_ID, reason: 'cookie' };

      postFromFrame(frame, msg, 'https://evil.test');
      postFromFrame(frame, msg, 'http://localhost:3000');
      postFromFrame(frame, { ...msg, tunnelId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
      postFromFrame(frame, { ...msg, type: 'something-else' });
      postFromFrame(frame, msg, HOST_ORIGIN, window);
      postFromFrame(frame, COOKIE_BLOCKED);
      expect(screen.queryByTestId('proxy-cookie-blocked-notice')).toBeNull();
    });

    it('shows the cookie notice for a cookie message from this tunnel frame', async () => {
      hostModeFetch();
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      const frame = await screen.findByTestId('network-proxy-frame');
      await postUntil(frame, { type: COOKIE_BLOCKED, tunnelId: HOST_ID, reason: 'cookie' }, () =>
        expect(screen.getByTestId('proxy-cookie-blocked-notice')).toBeInTheDocument(),
      );
      const notice = screen.getByTestId('proxy-cookie-blocked-notice');
      expect(notice).toHaveAttribute('data-reason', 'cookie');
      expect(notice).toHaveTextContent('This browser blocked the embedded proxy session');
      expect(notice).toHaveTextContent('Open the device in a new tab to continue.');
    });

    it('explains the storage case differently (amendment 2026-10-12b item 1)', async () => {
      hostModeFetch();
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      const frame = await screen.findByTestId('network-proxy-frame');
      await postUntil(frame, { type: COOKIE_BLOCKED, tunnelId: HOST_ID, reason: 'storage' }, () =>
        expect(screen.getByTestId('proxy-cookie-blocked-notice')).toBeInTheDocument(),
      );
      const notice = screen.getByTestId('proxy-cookie-blocked-notice');
      expect(notice).toHaveAttribute('data-reason', 'storage');
      expect(notice).toHaveTextContent('blocks site storage');
      expect(notice).not.toHaveTextContent('Open the device in a new tab to continue.');
    });

    it('treats an unknown reason as the cookie case and matches the tunnel id case-insensitively', async () => {
      hostModeFetch();
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      const frame = await screen.findByTestId('network-proxy-frame');
      await postUntil(frame, { type: COOKIE_BLOCKED, tunnelId: HOST_ID.toUpperCase(), reason: 'weird' }, () =>
        expect(screen.getByTestId('proxy-cookie-blocked-notice')).toHaveAttribute('data-reason', 'cookie'),
      );
    });

    it('offers Open in New Tab from the notice', async () => {
      hostModeFetch();
      const popup = fakePopup();
      vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      const frame = await screen.findByTestId('network-proxy-frame');
      await postUntil(frame, { type: COOKIE_BLOCKED, tunnelId: HOST_ID, reason: 'storage' }, () =>
        expect(screen.getByTestId('proxy-cookie-blocked-open-new-tab')).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId('proxy-cookie-blocked-open-new-tab'));
      await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(HOST_TAB_URL));
    });

    it('is never wired up in path mode', async () => {
      hostModeFetch({ [`POST /tunnels/${HOST_ID}/http-ticket`]: pathModeTicket });
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      const frame = await screen.findByTestId('network-proxy-frame');
      postFromFrame(frame, { type: COOKIE_BLOCKED, tunnelId: HOST_ID, reason: 'cookie' }, 'http://localhost:3000');
      expect(screen.queryByTestId('proxy-cookie-blocked-notice')).toBeNull();
    });
  });

  describe('Close', () => {
    it('shows "Disconnected" only after the DELETE succeeds', async () => {
      let deleteOk = false;
      hostModeFetch({
        [`DELETE /tunnels/${HOST_ID}`]: () =>
          deleteOk ? makeResponse({ closed: true }) : makeResponse({ error: 'boom' }, false),
      });
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      await screen.findByTestId('network-proxy-frame');

      fireEvent.click(screen.getByTestId('proxy-close'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/tunnels/${HOST_ID}`, { method: 'DELETE' }));
      // runAction toasts the server's reason; the page stays live and Close stays usable.
      await waitFor(() =>
        expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'boom' })),
      );
      await waitFor(() => expect(screen.getByTestId('proxy-close')).not.toBeDisabled());
      expect(screen.queryByTestId('proxy-session-expired-overlay')).toBeNull();
      expect(screen.getByTestId('proxy-status')).not.toHaveTextContent('Disconnected');

      deleteOk = true;
      fireEvent.click(screen.getByTestId('proxy-close'));
      expect(await screen.findByTestId('proxy-session-expired-overlay')).toBeInTheDocument();
      expect(screen.getByTestId('proxy-close')).toBeDisabled();
    });

    it('toasts and stays live when the DELETE request itself throws', async () => {
      hostModeFetch({
        [`DELETE /tunnels/${HOST_ID}`]: () => {
          throw new TypeError('Failed to fetch');
        },
      });
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      await screen.findByTestId('network-proxy-frame');
      fireEvent.click(screen.getByTestId('proxy-close'));
      await waitFor(() =>
        expect(vi.mocked(showToast)).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: 'Failed to close the tunnel' }),
        ),
      );
      expect(screen.queryByTestId('proxy-session-expired-overlay')).toBeNull();
    });
  });

  describe('Open in New Tab', () => {
    it('opens a blank tab synchronously, severs the opener, then navigates it to a fresh mode=tab ticket', async () => {
      hostModeFetch();
      const popup = fakePopup();
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      fireEvent.click(await screen.findByTestId('proxy-open-new-tab'));

      expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
      expect(popup.opener).toBeNull();
      await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(HOST_TAB_URL));
      expect(fetchMock).toHaveBeenCalledWith(`/tunnels/${HOST_ID}/http-ticket?mode=tab`, { method: 'POST' });
      // The iframe keeps its own frame ticket.
      expect(screen.getByTestId('network-proxy-frame').getAttribute('src')).toBe(HOST_URL);
    });

    it('closes the blank tab and toasts when the server returns a URL that is not a tab URL', async () => {
      hostModeFetch({
        [`POST /tunnels/${HOST_ID}/http-ticket?mode=tab`]: () =>
          makeResponse({ ticket: { ticket: 'TAB', expiresInSeconds: 300 }, url: HOST_URL, mode: 'host' }),
      });
      const popup = fakePopup();
      vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      fireEvent.click(await screen.findByTestId('proxy-open-new-tab'));
      await waitFor(() => expect(popup.close).toHaveBeenCalled());
      expect(popup.location.replace).not.toHaveBeenCalled();
      expect(vi.mocked(showToast)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'The server returned an invalid proxy address.' }),
      );
      expect(screen.getByTestId('network-proxy-frame')).toBeInTheDocument();
    });

    it('tells the user when the browser blocks the new tab, and mints nothing', async () => {
      hostModeFetch();
      vi.spyOn(window, 'open').mockReturnValue(null);
      render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
      fireEvent.click(await screen.findByTestId('proxy-open-new-tab'));
      await waitFor(() =>
        expect(vi.mocked(showToast)).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: 'Your browser blocked the new tab. Allow pop-ups for this site and try again.' }),
        ),
      );
      expect(fetchMock).not.toHaveBeenCalledWith(`/tunnels/${HOST_ID}/http-ticket?mode=tab`, { method: 'POST' });
    });
  });
});

// Review round on #9150.
describe('ProxyTunnelPage host mode — review follow-ups', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(showToast).mockClear();
  });

  it('hides the "Connected" badge while the blocked notice is up', async () => {
    hostModeFetch();
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    const frame = await screen.findByTestId('network-proxy-frame');
    fireEvent.load(frame);
    expect(await screen.findByTestId('proxy-status')).toHaveTextContent('Connected');
    await postUntil(frame, { type: COOKIE_BLOCKED, tunnelId: HOST_ID, reason: 'cookie' }, () =>
      expect(screen.getByTestId('proxy-cookie-blocked-notice')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('proxy-status')).toBeNull();
  });

  it('clears the blocked notice when the idle reconnect re-mints the frame', async () => {
    let mints = 0;
    hostModeFetch({
      [`GET /tunnels/${HOST_ID}`]: () => makeResponse({ status: 'active', idleSeconds: mints > 1 ? 0 : 400 }),
      [`POST /tunnels/${HOST_ID}/http-ticket`]: () => {
        mints += 1;
        return makeResponse({
          ticket: { ticket: `TKT${mints}`, expiresInSeconds: 300 },
          url: `${HOST_ORIGIN}/__bz/enter?t=TKT${mints}`,
          mode: 'host',
        });
      },
    });
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    const frame = await screen.findByTestId('network-proxy-frame');
    // The idle overlay covers the notice; Reconnect re-mints in place.
    await postUntil(frame, { type: COOKIE_BLOCKED, tunnelId: HOST_ID, reason: 'storage' }, () =>
      expect(screen.getByRole('button', { name: /^reconnect$/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^reconnect$/i }));
    await waitFor(() =>
      expect(screen.getByTestId('network-proxy-frame').getAttribute('src')).toBe(`${HOST_ORIGIN}/__bz/enter?t=TKT2`),
    );
    expect(screen.queryByTestId('proxy-session-expired-overlay')).toBeNull();
    expect(screen.queryByTestId('proxy-cookie-blocked-notice')).toBeNull();
  });

  it('keeps Close disabled while its DELETE is in flight', async () => {
    let resolveDelete: (r: Response) => void = () => {};
    hostModeFetch({
      [`DELETE /tunnels/${HOST_ID}`]: () => new Promise<Response>((r) => { resolveDelete = r; }) as unknown as Response,
    });
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    await screen.findByTestId('network-proxy-frame');
    fireEvent.click(screen.getByTestId('proxy-close'));
    await waitFor(() => expect(screen.getByTestId('proxy-close')).toBeDisabled());
    await act(async () => { resolveDelete(makeResponse({ closed: true })); });
    expect(await screen.findByTestId('proxy-session-expired-overlay')).toBeInTheDocument();
  });

  it('on a 401 Close leaves the session as it was and toasts nothing (the auth redirect handles it)', async () => {
    hostModeFetch({
      [`DELETE /tunnels/${HOST_ID}`]: () =>
        ({ ok: false, status: 401, json: vi.fn().mockResolvedValue({ error: 'Unauthorized' }) }) as unknown as Response,
    });
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    await screen.findByTestId('network-proxy-frame');
    fireEvent.click(screen.getByTestId('proxy-close'));
    await waitFor(() => expect(screen.getByTestId('proxy-close')).not.toBeDisabled());
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
    expect(screen.queryByTestId('proxy-session-expired-overlay')).toBeNull();
  });

  it('logs the refused URL shape for operators, never the ticket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    hostModeFetch({
      [`POST /tunnels/${HOST_ID}/http-ticket`]: () =>
        makeResponse({ ticket: { ticket: 'SECRET', expiresInSeconds: 300 }, url: 'http://localhost:3000/__bz/enter?t=SECRET', mode: 'host' }),
    });
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    await screen.findByText('The server returned an invalid proxy address.');
    expect(warn).toHaveBeenCalledWith(
      '[network-proxy] refused the server-built proxy URL',
      expect.objectContaining({ tunnelId: HOST_ID, context: 'frame', mode: 'host', host: 'localhost:3000' }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });

  it('shows a structured API error as text, not [object Object]', async () => {
    hostModeFetch({
      [`POST /tunnels/${HOST_ID}/http-ticket`]: () => makeResponse({ error: { message: 'Proxy disabled by policy' } }, false),
    });
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    expect(await screen.findByText(/Proxy disabled by policy|Failed to obtain tunnel ticket/)).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).toBeNull();
  });
});
