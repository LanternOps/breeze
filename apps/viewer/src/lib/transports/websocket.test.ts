import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { connectWebSocket, type WebSocketDeps } from './websocket';
import { createDesktopWsTicket } from '../api';
import type { AuthenticatedConnectionParams } from '../webrtc';

vi.mock('../api', () => ({
  createDesktopWsTicket: vi.fn(),
}));

const mintTicket = vi.mocked(createDesktopWsTicket);

/**
 * Manual WebSocket double. Nothing happens until the test drives it, so a
 * handshake that is rejected *before* the HTTP 101 upgrade can be reproduced
 * faithfully: the browser only ever surfaces `error`/`close` with no preceding
 * `open`, and never exposes the 401/403/409/429 the server actually sent.
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  binaryType = 'blob';
  readyState: number = MockWebSocket.CONNECTING;
  sent: unknown[] = [];
  closeCalls = 0;

  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;

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

  // -- test drivers ---------------------------------------------------------
  fireOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  fireMessage(data: unknown) {
    this.onmessage?.({ data });
  }

  fireError() {
    this.onerror?.({});
  }

  fireClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  /** True once every handler slot has been detached. */
  get isDetached() {
    return (
      this.onopen === null && this.onmessage === null && this.onerror === null && this.onclose === null
    );
  }
}

const auth: AuthenticatedConnectionParams = {
  sessionId: 'sess-1',
  apiUrl: 'https://api.example.com',
  accessToken: 'tok-1',
  deviceId: 'dev-1',
};

function makeDeps() {
  return {
    canvasElement: document.createElement('canvas'),
    onConnected: vi.fn<(info: { hostname: string; osType: string | null }) => void>(),
    onDisconnected: vi.fn<() => void>(),
    onError: vi.fn<(message: string) => void>(),
    onFrame: vi.fn<(data: ArrayBuffer) => void>(),
  } satisfies WebSocketDeps;
}

const latestSocket = () => MockWebSocket.instances[MockWebSocket.instances.length - 1]!;

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
  mintTicket.mockReset();
  let n = 0;
  mintTicket.mockImplementation(async () => `ticket-${++n}`);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('connectWebSocket — rejected handshake (no open)', () => {
  it('resolves null when the ticket cannot be minted and never opens a socket', async () => {
    mintTicket.mockResolvedValueOnce(null);
    const deps = makeDeps();

    await expect(connectWebSocket(auth, deps)).resolves.toBeNull();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('resolves null when the socket errors before open', async () => {
    const deps = makeDeps();
    const pending = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestSocket();
    ws.fireError();

    await expect(pending).resolves.toBeNull();
  });

  it('resolves null when the socket closes before open', async () => {
    const deps = makeDeps();
    const pending = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestSocket();
    ws.fireClose();

    await expect(pending).resolves.toBeNull();
  });

  it('sends no byte, runs no ping timer, and detaches every listener after a pre-open rejection', async () => {
    const deps = makeDeps();
    const pending = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestSocket();
    ws.fireError();
    await pending;

    // No keep-alive ping (or anything else) may reach a socket that never opened.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ws.sent).toEqual([]);
    expect(ws.closeCalls).toBeGreaterThan(0);
    expect(ws.isDetached).toBe(true);
  });

  it('does not report a pre-open rejection through the session lifecycle callbacks', async () => {
    const deps = makeDeps();
    const pending = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);

    latestSocket().fireError();
    await pending;

    // The caller learns about the rejection from the resolved `null`. Firing
    // onDisconnected/onError here would drive the *session* UI (and the
    // auto-reconnect loop) from a connection that never existed.
    expect(deps.onConnected).not.toHaveBeenCalled();
    expect(deps.onDisconnected).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('makes a late open/message from the rejected attempt inert', async () => {
    const deps = makeDeps();
    const pending = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestSocket();
    ws.fireError();
    await pending;

    // A stale attempt must never drive the current UI or transport.
    ws.fireOpen();
    ws.fireMessage(JSON.stringify({ type: 'connected', device: { hostname: 'h', osType: 'windows' } }));
    ws.fireMessage(new ArrayBuffer(8));
    await vi.advanceTimersByTimeAsync(120_000);

    expect(deps.onConnected).not.toHaveBeenCalled();
    expect(deps.onFrame).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([]);
  });

  it('mints a brand new ticket on retry and never replays the rejected URL', async () => {
    const deps = makeDeps();

    const first = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = latestSocket();
    firstSocket.fireError();
    await expect(first).resolves.toBeNull();

    expect(mintTicket).toHaveBeenCalledTimes(1);

    const second = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);

    // The fresh ticket request must precede the replacement socket.
    expect(mintTicket).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances).toHaveLength(2);
    const secondSocket = latestSocket();
    expect(secondSocket).not.toBe(firstSocket);
    expect(secondSocket.url).not.toBe(firstSocket.url);
    expect(secondSocket.url).toContain('ticket=ticket-2');

    secondSocket.fireOpen();
    await expect(second).resolves.not.toBeNull();
  });
});

describe('connectWebSocket — established session (post-open behaviour preserved)', () => {
  it('resolves the wrapper only after open', async () => {
    const deps = makeDeps();
    let settled = false;
    const pending = connectWebSocket(auth, deps).then((w) => {
      settled = true;
      return w;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(false);

    latestSocket().fireOpen();
    const wrapper = await pending;

    expect(settled).toBe(true);
    expect(wrapper?.kind).toBe('websocket');
  });

  it('starts the keep-alive ping only after open', async () => {
    const deps = makeDeps();
    const pending = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestSocket();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.sent).toEqual([]);

    ws.fireOpen();
    await pending;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws.sent).toEqual([JSON.stringify({ type: 'ping' })]);
  });

  it('still reports frames, connect and disconnect once the session is open', async () => {
    const deps = makeDeps();
    const pending = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestSocket();
    ws.fireOpen();
    const wrapper = await pending;
    expect(wrapper).not.toBeNull();

    ws.fireMessage(JSON.stringify({ type: 'connected', device: { hostname: 'host-a', osType: 'macos' } }));
    expect(deps.onConnected).toHaveBeenCalledWith({ hostname: 'host-a', osType: 'macos' });

    const frame = new ArrayBuffer(4);
    ws.fireMessage(frame);
    expect(deps.onFrame).toHaveBeenCalledWith(frame);

    wrapper!.inputChannel.send(JSON.stringify({ type: 'mousemove' }));
    expect(ws.sent).toContainEqual(
      JSON.stringify({ type: 'input', event: { type: 'mousemove' } }),
    );

    ws.fireClose();
    expect(deps.onDisconnected).toHaveBeenCalledTimes(1);
  });

  it('reports a server-side error frame after open', async () => {
    const deps = makeDeps();
    const pending = connectWebSocket(auth, deps);
    await vi.advanceTimersByTimeAsync(0);

    const ws = latestSocket();
    ws.fireOpen();
    await pending;

    ws.fireMessage(JSON.stringify({ type: 'error', message: 'agent gone' }));
    expect(deps.onError).toHaveBeenCalledWith('agent gone');
    expect(ws.closeCalls).toBeGreaterThan(0);
  });
});
