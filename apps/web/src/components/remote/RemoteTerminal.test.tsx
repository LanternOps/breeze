import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RemoteTerminal from './RemoteTerminal';
import { fetchWithAuth } from '@/stores/auth';

// --- xterm.js dynamic-import mocks -----------------------------------------
// RemoteTerminal lazy-imports xterm and its addons inside initTerminal(); the
// real modules touch canvas/DOM APIs jsdom lacks, so stub them out. These use
// plain functions/methods (not vi.fn) so the suite's clearMocks/restoreMocks
// can't wipe the constructor return values between tests.
type DataHandler = (data: string) => void;
type ResizeHandler = (size: { cols: number; rows: number }) => void;

/**
 * Live xterm listener registry. `dispose()` removes the handler exactly like
 * the real xterm disposable does, so a test can prove that a torn-down
 * connection attempt really unhooked terminal input rather than merely
 * refusing to forward it.
 */
const terminalHandlers = {
  data: [] as DataHandler[],
  resize: [] as ResizeHandler[],
  disposeCalls: 0,
};

const resetTerminalHandlers = () => {
  terminalHandlers.data = [];
  terminalHandlers.resize = [];
  terminalHandlers.disposeCalls = 0;
};

const makeTerminalStub = () => ({
  loadAddon() {},
  open() {},
  write() {},
  writeln() {},
  onData(cb: DataHandler) {
    terminalHandlers.data.push(cb);
    return {
      dispose() {
        terminalHandlers.disposeCalls += 1;
        terminalHandlers.data = terminalHandlers.data.filter((h) => h !== cb);
      },
    };
  },
  onResize(cb: ResizeHandler) {
    terminalHandlers.resize.push(cb);
    return {
      dispose() {
        terminalHandlers.disposeCalls += 1;
        terminalHandlers.resize = terminalHandlers.resize.filter((h) => h !== cb);
      },
    };
  },
  dispose() {},
  focus() {},
  clear() {},
  rows: 24,
  cols: 80,
});

vi.mock('@xterm/xterm', () => ({
  Terminal: function () {
    return makeTerminalStub();
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: function () {
    return {
      fit() {},
      proposeDimensions() {
        return { cols: 80, rows: 24 };
      },
    };
  },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: function () {
    return {};
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

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

const ticketPostCount = () =>
  fetchMock.mock.calls.filter(([url]) => /\/ws-ticket$/.test(url as string)).length;

// --- WebSocket mock ---------------------------------------------------------
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  /**
   * When false the socket stays in CONNECTING until the test drives it. That
   * is the only way to reproduce a handshake the server rejected before the
   * HTTP 101 upgrade: the browser surfaces `error`/`close` with no `open`, and
   * never exposes the 401/403/409/429 that caused it.
   */
  static autoOpen = true;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  /** ws-ticket POSTs that had already been issued when this socket was built. */
  ticketPostsBefore: number;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.ticketPostsBefore = ticketPostCount();
    MockWebSocket.instances.push(this);
    if (MockWebSocket.autoOpen) {
      // Fire open asynchronously so handlers assigned after construction win.
      queueMicrotask(() => this.fireOpen());
    }
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.closeCalls += 1;
    const wasClosed = this.readyState === MockWebSocket.CLOSED;
    this.readyState = MockWebSocket.CLOSED;
    if (!wasClosed) this.onclose?.({ code: code ?? 1000 });
  }

  // -- test drivers ---------------------------------------------------------
  fireOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  fireMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  fireError() {
    this.onerror?.({});
  }

  fireClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  get isDetached() {
    return (
      this.onopen === null && this.onmessage === null && this.onerror === null && this.onclose === null
    );
  }
}

/** Drive the mock socket to the "server ready" state the UI treats as connected. */
const fireConnected = (ws: MockWebSocket) => {
  act(() => {
    ws.onmessage?.({ data: JSON.stringify({ type: 'connected' }) });
  });
};

const sessionPostCount = () =>
  fetchMock.mock.calls.filter(
    ([url, opts]) => url === '/remote/sessions' && (opts as RequestInit | undefined)?.method === 'POST',
  ).length;

beforeEach(() => {
  MockWebSocket.instances = [];
  MockWebSocket.autoOpen = true;
  resetTerminalHandlers();
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
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (url === '/remote/sessions' && opts?.method === 'POST') {
      return makeResponse({ id: `session-${sessionPostCount()}` });
    }
    if (/\/ws-ticket$/.test(url)) {
      // One-time tickets: every mint must be a different value so a test can
      // prove a retry never replays the previous WebSocket URL.
      return makeResponse({ ticket: `TKT-${ticketPostCount()}` });
    }
    if (/\/end$/.test(url)) {
      return makeResponse({});
    }
    return makeResponse({});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderTerminal = () =>
  render(<RemoteTerminal deviceId="device-1" deviceHostname="host-1" />);

describe('RemoteTerminal auto-connect / disconnect (#2137)', () => {
  it('auto-connects exactly once on mount', async () => {
    renderTerminal();

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1), { timeout: 2000 });
    // Settle past the 500ms auto-connect delay to prove it does not fire again.
    await new Promise((r) => setTimeout(r, 700));
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(sessionPostCount()).toBe(1);
  });

  it('does NOT reconnect after the user clicks Disconnect', async () => {
    renderTerminal();

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1), { timeout: 2000 });
    fireConnected(MockWebSocket.instances[0]!);

    const disconnectBtn = await screen.findByRole('button', { name: /disconnect/i });
    await userEvent.click(disconnectBtn);

    // The Disconnect click closes the socket (code 1000) → status 'disconnected',
    // sessionId cleared. The pre-fix bug: the auto-connect effect re-fires here.
    // Give it well past the 500ms auto-connect delay and assert nothing reconnects.
    await new Promise((r) => setTimeout(r, 700));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(sessionPostCount()).toBe(1);
    // And an explicit Reconnect affordance is offered instead.
    expect(await screen.findByRole('button', { name: /reconnect/i })).toBeInTheDocument();
  });

  it('reconnects only when the user clicks Reconnect', async () => {
    renderTerminal();

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1), { timeout: 2000 });
    fireConnected(MockWebSocket.instances[0]!);

    await userEvent.click(await screen.findByRole('button', { name: /disconnect/i }));

    const reconnectBtn = await screen.findByRole('button', { name: /reconnect/i });
    await userEvent.click(reconnectBtn);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 2000 });
    expect(sessionPostCount()).toBe(2);
  });

  it('does NOT reconnect on a clean server-side session end (close 1000)', async () => {
    renderTerminal();

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1), { timeout: 2000 });
    fireConnected(MockWebSocket.instances[0]!);
    await screen.findByRole('button', { name: /disconnect/i });

    // Server ends the session cleanly (no user click) — same disconnected+no-
    // session state a manual Disconnect produces. Must not auto-reconnect.
    act(() => {
      MockWebSocket.instances[0]!.close(1000);
    });

    await new Promise((r) => setTimeout(r, 700));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(sessionPostCount()).toBe(1);
    expect(await screen.findByRole('button', { name: /reconnect/i })).toBeInTheDocument();
  });

  it('surfaces a failed connection with a Retry button that reconnects', async () => {
    renderTerminal();

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1), { timeout: 2000 });

    // An unexpected close (code !== 1000) marks the connection failed.
    act(() => {
      MockWebSocket.instances[0]!.close(1006);
    });

    const retryBtn = await screen.findByRole('button', { name: /retry/i });

    // Retry must not have auto-reconnected on its own before the click.
    expect(MockWebSocket.instances).toHaveLength(1);

    await userEvent.click(retryBtn);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 2000 });
    expect(sessionPostCount()).toBe(2);
  });
});

// The server now rejects a terminal WebSocket *before* the HTTP 101 upgrade
// (401/403/409/429). The browser WebSocket API never exposes that status — the
// page only sees `error`/`close` with no preceding `open`. Assert on that
// observable sequence only.
describe('RemoteTerminal rejected handshake (error/close before open)', () => {
  const renderAndAwaitFirstSocket = async () => {
    MockWebSocket.autoOpen = false;
    renderTerminal();
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1), { timeout: 2000 });
    return MockWebSocket.instances[0]!;
  };

  it('shows a retry state and fully disposes the attempt when the socket errors before open', async () => {
    const ws = await renderAndAwaitFirstSocket();
    const typeBeforeRejection = terminalHandlers.data[0];

    act(() => ws.fireError());

    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
    // No session is presented as live.
    expect(screen.queryByRole('button', { name: /^disconnect$/i })).not.toBeInTheDocument();

    // The dead socket is closed and every listener unhooked.
    expect(ws.closeCalls).toBeGreaterThan(0);
    expect(ws.isDetached).toBe(true);
    expect(terminalHandlers.disposeCalls).toBeGreaterThanOrEqual(2);
    expect(terminalHandlers.data).toHaveLength(0);
    expect(terminalHandlers.resize).toHaveLength(0);

    // Nothing may be written to a socket that never opened.
    act(() => typeBeforeRejection?.('whoami\r'));
    expect(ws.sent).toEqual([]);
  });

  it('shows a retry state when the socket closes before open', async () => {
    const ws = await renderAndAwaitFirstSocket();

    act(() => ws.fireClose(1006));

    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(ws.isDetached).toBe(true);
    expect(ws.sent).toEqual([]);
    expect(terminalHandlers.data).toHaveLength(0);
  });

  it('keeps a rejected attempt inert when it later reports open/connected', async () => {
    const ws = await renderAndAwaitFirstSocket();

    act(() => ws.fireError());
    await screen.findByRole('button', { name: /retry/i });

    // A late event from the disposed attempt must not drive the UI or the wire.
    act(() => {
      ws.fireOpen();
      ws.fireMessage({ type: 'connected' });
      ws.fireMessage({ type: 'output', data: 'stale output' });
    });

    expect(screen.queryByRole('button', { name: /^disconnect$/i })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(ws.sent).toEqual([]);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('mints a fresh ticket before the retry socket and never replays the rejected url', async () => {
    const ws = await renderAndAwaitFirstSocket();
    const rejectedUrl = ws.url;

    act(() => ws.fireError());
    const retryBtn = await screen.findByRole('button', { name: /retry/i });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ticketPostCount()).toBe(1);

    MockWebSocket.autoOpen = true;
    await userEvent.click(retryBtn);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 2000 });
    const retrySocket = MockWebSocket.instances[1]!;

    // A fresh authenticated ticket request precedes the replacement socket.
    expect(ticketPostCount()).toBe(2);
    expect(retrySocket.ticketPostsBefore).toBe(2);
    expect(retrySocket.url).not.toBe(rejectedUrl);
    expect(sessionPostCount()).toBe(2);
  });

  it('does not auto-reconnect after a rejected handshake', async () => {
    const ws = await renderAndAwaitFirstSocket();

    act(() => ws.fireError());
    await screen.findByRole('button', { name: /retry/i });

    // Well past the 500ms auto-connect delay.
    await new Promise((r) => setTimeout(r, 700));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ticketPostCount()).toBe(1);
  });
});

describe('RemoteTerminal keepalive & silent-death watchdog (#2871)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Mount, run the 500ms auto-connect delay, and open the socket. */
  const openConnected = async (): Promise<MockWebSocket> => {
    renderTerminal();
    // Interleave microtask flushes (dynamic xterm imports → terminalReady)
    // with timer advances (the 500ms auto-connect delay) under fake timers.
    for (let i = 0; i < 5 && MockWebSocket.instances.length === 0; i++) {
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    }
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    fireConnected(ws);
    return ws;
  };

  const sentOfType = (ws: MockWebSocket, type: string) =>
    ws.sent.filter((raw) => {
      try {
        return (JSON.parse(raw) as { type?: string }).type === type;
      } catch {
        return false;
      }
    });

  it('sends client keepalive pings once the server confirms the session', async () => {
    const ws = await openConnected();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });

    expect(sentOfType(ws, 'ping').length).toBeGreaterThanOrEqual(1);
  });

  it('answers server pings with pongs and stays connected well past 60s', async () => {
    const ws = await openConnected();

    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      act(() => ws.fireMessage({ type: 'ping', timestamp: 0 }));
    }

    // 2+ minutes in: no disconnect overlay, socket untouched.
    expect(screen.queryByTestId('terminal-disconnect-overlay')).not.toBeInTheDocument();
    expect(ws.closeCalls).toBe(0);
    expect(sentOfType(ws, 'pong').length).toBeGreaterThanOrEqual(4);
  });

  it('surfaces prolonged server silence as a visible disconnect with a retry affordance', async () => {
    const ws = await openConnected();

    // No server frame at all past the 45s silence deadline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });

    expect(screen.getByTestId('terminal-disconnect-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-overlay-reconnect')).toBeInTheDocument();
    // The dead socket was torn down, not left dangling.
    expect(ws.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('shows the disconnect overlay when the server closes the socket abnormally (e.g. 4003 revoked)', async () => {
    const ws = await openConnected();

    act(() => ws.fireClose(4003));

    expect(screen.getByTestId('terminal-disconnect-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-overlay-reconnect')).toBeInTheDocument();
  });

  it('the overlay reconnect button actually reconnects after a watchdog teardown', async () => {
    await openConnected();

    // Kill the session via the silence watchdog, then click the overlay button.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });
    const reconnect = screen.getByTestId('terminal-overlay-reconnect');
    await act(async () => {
      reconnect.click();
    });
    // Flush the session + ticket fetches and the socket construction.
    for (let i = 0; i < 5 && MockWebSocket.instances.length < 2; i++) {
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
    }

    // A brand-new session and socket — the dead attempt is not reused.
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(sessionPostCount()).toBe(2);
    expect(ticketPostCount()).toBe(2);
  });
});
