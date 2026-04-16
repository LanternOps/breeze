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
 * Returns null if the ticket exchange fails.
 * Lifecycle callbacks fire unconditionally; React stale-session guards belong in the caller.
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

  let closed = false;
  let hadError = false;

  // Ping keep-alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 15000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pingInterval);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };

  ws.onopen = () => {
    console.log('Desktop WebSocket connected');
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

  ws.onclose = () => {
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
    hadError = true;
    cleanup();
    deps.onError('WebSocket connection error');
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

  return wrapper;
}
