/**
 * W08 — what a refused agent WS upgrade looks like ON THE WIRE.
 *
 * Shipped agents (gorilla/websocket) treat a non-101 handshake as a failed
 * connect and back off 1 -> 60 s; they reconnect immediately after an ACCEPTED
 * socket closes. So a refusal must be an HTTP status line, never an upgrade.
 * And @hono/node-ws writes refusals itself as a bare status line, dropping the
 * response headers — the patch in patches/@hono__node-ws@1.3.2.patch forwards a
 * validated Retry-After so W09 agents get the delay hint.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import type { AdmissionDecision } from '../services/admission/admissionRuntime';
import { agentAdmission } from './agentAdmission';

const AGENT = 'a'.repeat(64);
let server: ServerType | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

async function start(decision: AdmissionDecision, onOpen: () => void) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.use('*', agentAdmission(() => ({ mode: 'enforce', decide: () => decision })));
  app.get('/api/v1/agent-ws/:id/ws', upgradeWebSocket(() => ({ onOpen })));
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
  });
  injectWebSocket(server!);
  return port;
}

function handshake(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1');
    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      if (raw.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(raw);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(raw));
    socket.write([
      `GET /api/v1/agent-ws/${AGENT}/ws HTTP/1.1`,
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'));
  });
}

describe('agent WS refusal on the wire', () => {
  it('is an HTTP 503 status line carrying Retry-After, and no socket ever opens (Review Focus 1)', async () => {
    const onOpen = vi.fn();
    const port = await start({ action: 'shed', reason: 'ws_bucket', retryAfterSec: 42 }, onOpen);
    const raw = await handshake(port);
    expect(raw).toMatch(/^HTTP\/1\.1 503 /);
    expect(raw).toMatch(/\r\nRetry-After: 42\r\n/);
    expect(raw).not.toMatch(/101 Switching Protocols/);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([99_999, Number.NaN, -3, 1.5])('a Retry-After the patch cannot validate (%s) leaves the 503 status line bare', async (retryAfterSec) => {
    const port = await start({ action: 'shed', reason: 'ws_bucket', retryAfterSec }, vi.fn());
    const raw = await handshake(port);
    expect(raw).toMatch(/^HTTP\/1\.1 503 /);
    expect(raw).not.toMatch(/Retry-After/i);
  });

  // #8318 wave D-1a. The parked refusal (routes/agentWs.ts) reaches the agent
  // only as this header: node-ws writes the refusal with Content-Length: 0.
  async function startRefusing(headerValue: string) {
    const app = new Hono();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    app.get(
      '/api/v1/agent-ws/:id/ws',
      async (c) => {
        c.header('X-Breeze-Refusal', headerValue);
        return c.json({ error: headerValue }, 403);
      },
      upgradeWebSocket(() => ({})),
    );
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
    });
    injectWebSocket(server!);
    return port;
  }

  it('forwards the parked refusal header on a refused upgrade (body is dropped)', async () => {
    const raw = await handshake(await startRefusing('device_pending_assignment'));
    expect(raw).toMatch(/^HTTP\/1\.1 403 /);
    expect(raw).toMatch(/\r\nX-Breeze-Refusal: device_pending_assignment\r\n/);
    expect(raw).toMatch(/\r\nContent-Length: 0\r\n/);
  });

  // Header values cannot carry CR/LF (the Headers API refuses them), so the
  // allow-list guards against any other text reaching the raw socket.
  it.each(['something_else', 'DEVICE_PENDING_ASSIGNMENT', 'device_pending_assignment; x=1'])(
    'drops a refusal header value outside the allow-list (%j)',
    async (value) => {
      const raw = await handshake(await startRefusing(value));
      expect(raw).toMatch(/^HTTP\/1\.1 403 /);
      expect(raw).not.toMatch(/X-Breeze-Refusal/i);
    },
  );

  it('an admitted upgrade still switches protocols', async () => {
    const onOpen = vi.fn();
    const port = await start({ action: 'admit' }, onOpen);
    const raw = await handshake(port);
    expect(raw).toMatch(/^HTTP\/1\.1 101 /);
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  });
});
