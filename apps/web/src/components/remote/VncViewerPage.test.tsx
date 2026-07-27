import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import VncViewerPage from './VncViewerPage';
import { fetchWithAuth } from '@/stores/auth';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// --- WebSocket mock ---------------------------------------------------------
// noVNC owns the socket, so the page can only observe the handshake through
// the RFB lifecycle. The socket double exists so the test can prove no tunnel
// byte was written and that a retry really built a *different* URL.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  sent: unknown[] = [];
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = MockWebSocket.CLOSED;
  }
}

// --- noVNC RFB mock ---------------------------------------------------------
class MockRfb {
  static instances: MockRfb[] = [];

  url: string;
  socket: MockWebSocket;
  disconnectCalls = 0;
  scaleViewport = false;
  resizeSession = false;
  showDotCursor = false;
  _sock: { flush?: () => void; _websocket: MockWebSocket };
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  constructor(_target: HTMLElement, url: string) {
    this.url = url;
    this.socket = new MockWebSocket(url);
    this._sock = { _websocket: this.socket };
    MockRfb.instances.push(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((h) => h !== cb));
  }

  dispatch(type: string, detail?: unknown) {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb({ detail });
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.socket.close();
    this.dispatch('disconnect', { clean: true });
  }

  sendCredentials() {}
  clipboardPasteFrom() {}
}

vi.mock('@/lib/novnc', () => ({
  RFB: MockRfb,
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown = {}, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response);

const TUNNEL_ID = 'tunnel-abcdef01';

const ticketPostCount = () =>
  fetchMock.mock.calls.filter(([url]) => /\/ws-ticket$/.test(url as string)).length;

const tunnelDeleteCount = () =>
  fetchMock.mock.calls.filter(
    ([url, opts]) =>
      url === `/tunnels/${TUNNEL_ID}` && (opts as RequestInit | undefined)?.method === 'DELETE',
  ).length;

let ticketSeq = 0;

// jsdom refuses real navigation, so swap `window.location` for a recorder. It
// is a configurable accessor property here, so it restores cleanly.
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location')!;
let navigations: string[] = [];

const installLocationRecorder = () => {
  navigations = [];
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      origin: 'http://localhost:3000',
      _href: 'http://localhost:3000/remote/vnc',
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
  MockWebSocket.instances = [];
  MockRfb.instances = [];
  ticketSeq = 0;
  installLocationRecorder();
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (/\/ws-ticket$/.test(url)) {
      // One-time tickets — every mint is a distinct value.
      return makeResponse({ ticket: `VTKT-${++ticketSeq}` });
    }
    return makeResponse({});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', originalLocationDescriptor);
});

const renderPage = () => render(<VncViewerPage tunnelId={TUNNEL_ID} />);

const waitForRfb = async (count: number) =>
  waitFor(() => expect(MockRfb.instances).toHaveLength(count), { timeout: 2000 });

/**
 * The tunnel WebSocket is now rejected before the HTTP 101 upgrade
 * (401/403/409/429). noVNC reports that as a non-clean `disconnect` with no
 * preceding `connect`; the HTTP status is never visible to the page.
 */
describe('VncViewerPage rejected handshake', () => {
  it('mints one ticket and opens exactly one tunnel socket on mount', async () => {
    renderPage();
    await waitForRfb(1);

    expect(ticketPostCount()).toBe(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockRfb.instances[0]!.url).toContain('VTKT-1');
  });

  it('presents a retry state instead of silently tearing the tunnel down', async () => {
    renderPage();
    await waitForRfb(1);
    const rfb = MockRfb.instances[0]!;

    act(() => rfb.dispatch('disconnect', { clean: false }));

    expect(await screen.findByRole('button', { name: /^retry$/i })).toBeInTheDocument();
    // A rejected handshake must not delete the tunnel out from under the retry.
    expect(tunnelDeleteCount()).toBe(0);
    // And it must not navigate the operator away from the retry affordance.
    expect(navigations).toEqual([]);
    // No tunnel byte was ever written.
    expect(MockWebSocket.instances[0]!.sent).toEqual([]);
  });

  it('discards the burnt ticket url — the rejected viewer is unmounted', async () => {
    renderPage();
    await waitForRfb(1);
    const rejectedUrl = MockRfb.instances[0]!.url;

    act(() => MockRfb.instances[0]!.dispatch('disconnect', { clean: false }));
    await screen.findByRole('button', { name: /^retry$/i });

    // Nothing may reconnect on its own, and never with the consumed ticket.
    await new Promise((r) => setTimeout(r, 300));
    expect(MockRfb.instances).toHaveLength(1);
    expect(MockRfb.instances.filter((r) => r.url === rejectedUrl)).toHaveLength(1);
    expect(ticketPostCount()).toBe(1);
  });

  it('mints a fresh ticket before the retry socket and uses a different url', async () => {
    renderPage();
    await waitForRfb(1);
    const rejectedUrl = MockRfb.instances[0]!.url;

    act(() => MockRfb.instances[0]!.dispatch('disconnect', { clean: false }));
    await userEvent.click(await screen.findByRole('button', { name: /^retry$/i }));

    await waitForRfb(2);
    const retryRfb = MockRfb.instances[1]!;

    expect(ticketPostCount()).toBe(2);
    expect(retryRfb.url).not.toBe(rejectedUrl);
    expect(retryRfb.url).toContain('VTKT-2');
    // Same tunnel — only the one-time ticket is re-minted.
    expect(retryRfb.url).toContain(TUNNEL_ID);
    expect(tunnelDeleteCount()).toBe(0);
  });

  it('keeps a stale attempt inert once a retry is under way', async () => {
    renderPage();
    await waitForRfb(1);
    const stale = MockRfb.instances[0]!;

    act(() => stale.dispatch('disconnect', { clean: false }));
    await userEvent.click(await screen.findByRole('button', { name: /^retry$/i }));
    await waitForRfb(2);

    // The abandoned attempt reports again — it must not push the live attempt
    // back into the rejected state.
    act(() => stale.dispatch('disconnect', { clean: false }));

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: /^retry$/i })).not.toBeInTheDocument();
    expect(MockRfb.instances).toHaveLength(2);
    expect(tunnelDeleteCount()).toBe(0);
  });

  /**
   * The retry panel exists for handshakes the server refused. Once a session
   * has actually opened, a disconnect is an ordinary end-of-session and MUST
   * keep the previous behaviour: release the tunnel and leave. Holding the
   * tunnel open here would leave a live network path into a customer device
   * until the server-side idle reaper eventually closes it.
   */
  it('releases the tunnel and navigates away on an unclean disconnect AFTER the session opened', async () => {
    renderPage();
    await waitForRfb(1);
    const rfb = MockRfb.instances[0]!;

    act(() => rfb.dispatch('connect'));
    act(() => rfb.dispatch('disconnect', { clean: false }));

    await waitFor(() => expect(tunnelDeleteCount()).toBe(1), { timeout: 2000 });
    expect(navigations).toEqual(['/remote']);
    expect(screen.queryByRole('button', { name: /^retry$/i })).not.toBeInTheDocument();
  });

  it('releases the tunnel and navigates away on a clean disconnect AFTER the session opened', async () => {
    renderPage();
    await waitForRfb(1);
    const rfb = MockRfb.instances[0]!;

    act(() => rfb.dispatch('connect'));
    act(() => rfb.dispatch('disconnect', { clean: true }));

    await waitFor(() => expect(tunnelDeleteCount()).toBe(1), { timeout: 2000 });
    expect(navigations).toEqual(['/remote']);
    expect(screen.queryByRole('button', { name: /^retry$/i })).not.toBeInTheDocument();
  });

  it('releases the tunnel and navigates away when the operator disconnects the viewer itself', async () => {
    renderPage();
    await waitForRfb(1);
    const rfb = MockRfb.instances[0]!;
    act(() => rfb.dispatch('connect'));

    // The viewer's own Disconnect control (VncViewer's toolbar / credentials
    // Cancel) is a deliberate teardown, never a rejected handshake.
    const viewerDisconnect = screen.getAllByRole('button', { name: /disconnect/i }).at(-1)!;
    await userEvent.click(viewerDisconnect);

    await waitFor(() => expect(tunnelDeleteCount()).toBe(1), { timeout: 2000 });
    expect(navigations).toEqual(['/remote']);
    expect(screen.queryByRole('button', { name: /^retry$/i })).not.toBeInTheDocument();
  });

  it('surfaces a ticket-mint failure without opening a socket', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (/\/ws-ticket$/.test(url)) return makeResponse({ error: 'nope' }, false);
      return makeResponse({});
    });

    renderPage();

    expect(await screen.findByText(/nope/i)).toBeInTheDocument();
    expect(MockRfb.instances).toHaveLength(0);
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
