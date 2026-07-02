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
const makeTerminalStub = () => ({
  loadAddon() {},
  open() {},
  write() {},
  writeln() {},
  onData() {
    return { dispose() {} };
  },
  onResize() {
    return { dispose() {} };
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

// --- WebSocket mock ---------------------------------------------------------
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Fire open asynchronously so handlers assigned after construction win.
    queueMicrotask(() => this.onopen?.({}));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000 });
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
      return makeResponse({ ticket: 'TKT-abc' });
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
});
