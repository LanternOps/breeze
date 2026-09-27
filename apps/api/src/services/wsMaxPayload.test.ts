import { createServer } from 'node:http';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installPerRouteMaxPayload,
  resolveWsMaxPayload,
  WS_MAX_PAYLOAD_AGENT_BYTES,
  WS_MAX_PAYLOAD_DEFAULT_BYTES,
  WS_MAX_PAYLOAD_TUNNEL_BYTES,
} from './wsMaxPayload';

describe('resolveWsMaxPayload', () => {
  it('gives the small default tier to terminal, desktop-ws and event-stream routes', () => {
    expect(resolveWsMaxPayload('/api/v1/remote/sessions/abc/ws')).toBe(WS_MAX_PAYLOAD_DEFAULT_BYTES);
    expect(resolveWsMaxPayload('/api/v1/desktop-ws')).toBe(WS_MAX_PAYLOAD_DEFAULT_BYTES);
    expect(resolveWsMaxPayload('/api/v1/events')).toBe(WS_MAX_PAYLOAD_DEFAULT_BYTES);
  });

  it('gives tunnel-ws a larger limit for its relayed data frames', () => {
    expect(resolveWsMaxPayload('/api/v1/tunnel-ws/session-1')).toBe(WS_MAX_PAYLOAD_TUNNEL_BYTES);
  });

  it('gives agent-ws the largest limit for batched ingest payloads', () => {
    expect(resolveWsMaxPayload('/api/v1/agent-ws')).toBe(WS_MAX_PAYLOAD_AGENT_BYTES);
  });

  it('is far below the ws library default of 100 MiB on every route', () => {
    const ONE_HUNDRED_MIB = 100 * 1024 * 1024;
    for (const pathname of ['/api/v1/remote/sessions/x/ws', '/api/v1/tunnel-ws/x', '/api/v1/agent-ws']) {
      expect(resolveWsMaxPayload(pathname)).toBeLessThan(ONE_HUNDRED_MIB);
    }
  });
});

describe('installPerRouteMaxPayload', () => {
  function fakeWss(initialMaxPayload: number) {
    const options: { maxPayload?: number } = { maxPayload: initialMaxPayload };
    const handleUpgrade = vi.fn((_req: unknown, _socket: unknown, _head: unknown, cb: (...a: unknown[]) => void) => {
      // The real ws library reads `this.options.maxPayload` synchronously
      // inside this call — assert it landed on the SAME object the route
      // handler reads from, at the moment this fires.
      cb(options.maxPayload);
    });
    const wss = { options, handleUpgrade } as unknown as {
      options: { maxPayload?: number };
      handleUpgrade: (...a: unknown[]) => unknown;
    };
    return wss;
  }

  it('sets the resolved per-route limit before delegating to the original handleUpgrade, with no fixed value left over between requests', () => {
    const wss = fakeWss(100 * 1024 * 1024);
    installPerRouteMaxPayload(wss as unknown as Parameters<typeof installPerRouteMaxPayload>[0]);

    const seen: unknown[] = [];
    wss.handleUpgrade(
      { url: '/api/v1/agent-ws' },
      {},
      Buffer.alloc(0),
      (payload: unknown) => seen.push(payload),
    );
    wss.handleUpgrade(
      { url: '/api/v1/remote/sessions/abc/ws' },
      {},
      Buffer.alloc(0),
      (payload: unknown) => seen.push(payload),
    );
    wss.handleUpgrade(
      { url: '/api/v1/tunnel-ws/x' },
      {},
      Buffer.alloc(0),
      (payload: unknown) => seen.push(payload),
    );

    expect(seen).toEqual([
      WS_MAX_PAYLOAD_AGENT_BYTES,
      WS_MAX_PAYLOAD_DEFAULT_BYTES,
      WS_MAX_PAYLOAD_TUNNEL_BYTES,
    ]);
  });
});

describe('agent-ws frame acceptance against a real ws server', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  /**
   * Boots a real `@hono/node-ws`-backed server on an ephemeral port with
   * `installPerRouteMaxPayload` wired exactly as `index.ts` wires it, and
   * connects a real client `WebSocket` (Node's built-in global) to
   * `/api/v1/agent-ws/probe`. Returns once the socket is open.
   */
  async function connectToAgentWs(): Promise<{ socket: WebSocket; port: number }> {
    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
    installPerRouteMaxPayload(wss);
    app.get(
      '/api/v1/agent-ws/probe',
      upgradeWebSocket(() => ({
        onMessage(_evt, ws) {
          ws.send('accepted');
        },
      })),
    );

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    injectWebSocket(server);
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a network address');
    }
    const { port } = address;

    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agent-ws/probe`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket failed to open')), { once: true });
    });

    cleanup = async () => {
      socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    return { socket, port };
  }

  it('accepts a frame just over 12 MiB (the old ceiling)', async () => {
    const { socket } = await connectToAgentWs();
    const justOver12MiB = 12 * 1024 * 1024 + 1024;

    const result = await new Promise<'message' | 'closed'>((resolve) => {
      socket.addEventListener('message', () => resolve('message'), { once: true });
      socket.addEventListener('close', () => resolve('closed'), { once: true });
      socket.send(new Uint8Array(justOver12MiB));
    });

    expect(result).toBe('message');
    expect(socket.readyState).toBe(WebSocket.OPEN);
  }, 20_000);

  it('rejects a frame over the new ceiling with close code 1009', async () => {
    const { socket } = await connectToAgentWs();
    const overNewCeiling = WS_MAX_PAYLOAD_AGENT_BYTES + 1024 * 1024;

    const closeCode = await new Promise<number>((resolve) => {
      socket.addEventListener('close', (evt) => resolve((evt as CloseEvent).code), { once: true });
      socket.send(new Uint8Array(overNewCeiling));
    });

    expect(closeCode).toBe(1009);
  }, 20_000);
});
