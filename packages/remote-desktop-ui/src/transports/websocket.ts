/**
 * WebSocket JPEG-frame fallback transport for remote desktop.
 * Extracted from DesktopViewer.tsx — pure connection logic, no React.
 * React refs/state are threaded in via WebSocketDeps callbacks.
 */

import { buildWsUrl } from '../protocol';
import { createDesktopWsTicket } from '../api';
import type { AuthenticatedConnectionParams } from '../webrtc';
import type { TransportSession } from './types';
import { capabilitiesFor } from './types';

export interface WebSocketDeps {
  canvasElement: HTMLCanvasElement;
  // Lifecycle
  onConnected: (info: { hostname: string; osType: string | null }) => void;
  onDisconnected: () => void;
  onError: (message: string) => void;
  // Frames
  onFrame: (data: ArrayBuffer) => void;
}

export interface WebSocketSessionWrapper extends TransportSession {
  kind: 'websocket';
  canvasElement: HTMLCanvasElement;
  inputChannel: { send(json: string): void };
  /** For non-input messages like {type:'config', ...} */
  sendRaw(text: string): void;
}

/**
 * Connects a JPEG-over-WebSocket fallback session.
 *
 * Resolves a usable wrapper **only after the socket has opened**. It resolves
 * `null` when the ticket exchange fails, or when the server rejected the
 * handshake before the HTTP 101 upgrade (401/403/409/429). The browser
 * WebSocket API never exposes that status — the only observable signal is an
 * `error`/`close` that arrives with no preceding `open` — so a pre-open
 * failure is treated as one-shot: the attempt is disposed (timers cleared,
 * listeners detached, socket closed) and the burnt one-time ticket is
 * discarded. A retry must call this function again, which mints a brand new
 * ticket; the rejected URL is never replayed.
 *
 * Lifecycle callbacks describe an *established* session only. A pre-open
 * rejection is reported solely through the resolved `null`, so it can never
 * drive the session UI or the caller's auto-reconnect loop.
 * React stale-session guards belong in the caller.
 */
export async function connectWebSocket(
  auth: AuthenticatedConnectionParams,
  deps: WebSocketDeps,
): Promise<WebSocketSessionWrapper | null> {
  const wsTicket = await createDesktopWsTicket(auth.apiUrl, auth.accessToken, auth.sessionId);
  if (!wsTicket) {
    return null;
  }

  const wsUrl = buildWsUrl(auth.apiUrl, auth.sessionId, wsTicket);
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  let opened = false;
  let closed = false;
  let hadError = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const clearPing = () => {
    if (pingInterval !== null) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearPing();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };

  /**
   * Disposes an attempt the server refused before the upgrade. Detaching every
   * handler is what makes the attempt inert: a late `open`, frame, or `close`
   * from this socket must not touch the caller's state.
   */
  const disposeRejectedHandshake = () => {
    closed = true;
    clearPing();
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // Already closing/closed — nothing to unwind.
    }
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      deps.onFrame(event.data);
      return;
    }

    try {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      switch (msg.type) {
        case 'connected': {
          const device = msg.device as Record<string, unknown> | undefined;
          const hostname = (device?.hostname as string) || 'Unknown';
          const osType = (device?.osType as string | null) ?? null;
          deps.onConnected({ hostname, osType });
          break;
        }
        case 'pong':
          break;
        case 'error': {
          console.error('Server error:', msg.message);
          hadError = true;
          cleanup();
          deps.onError((msg.message as string) || 'Remote desktop error');
          break;
        }
      }
    } catch (err) {
      console.warn('Failed to parse websocket message:', err);
    }
  };

  const wrapper: WebSocketSessionWrapper = {
    kind: 'websocket',
    capabilities: capabilitiesFor('websocket'),
    canvasElement: deps.canvasElement,
    inputChannel: {
      send: (json: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', event: JSON.parse(json) as unknown }));
        }
      },
    },
    sendRaw: (text: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(text);
      }
    },
    close: cleanup,
  };

  return await new Promise<WebSocketSessionWrapper | null>((resolve) => {
    let settled = false;
    const settle = (value: WebSocketSessionWrapper | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    ws.onopen = () => {
      console.log('Desktop WebSocket connected');
      opened = true;
      // Keep-alive starts only once the upgrade succeeded, so a refused
      // handshake can never leave a ping timer behind.
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 15000);
      settle(wrapper);
    };

    ws.onclose = () => {
      if (!opened) {
        disposeRejectedHandshake();
        settle(null);
        return;
      }
      // If the caller already invoked cleanup() (closed=true), this is a
      // teardown close, not a network disconnection — skip disconnect callback.
      const wasCleanedUp = closed;
      cleanup();
      if (wasCleanedUp) return;
      if (!hadError) {
        deps.onDisconnected();
      }
    };

    ws.onerror = () => {
      if (!opened) {
        disposeRejectedHandshake();
        settle(null);
        return;
      }
      hadError = true;
      cleanup();
      deps.onError('WebSocket connection error');
    };
  });
}
