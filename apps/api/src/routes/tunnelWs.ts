import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { tunnelSessions, devices, users } from '../db/schema';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';
import { captureException } from '../services/sentry';

// Store active tunnel connections: Map<tunnelId, TunnelConnection>
interface TunnelConnection {
  userWs: WSContext;
  agentId: string;
  userId: string;
  deviceId: string;
  orgId: string;
  tunnelType: 'vnc' | 'proxy';
  startedAt: Date;
  pingInterval?: ReturnType<typeof setInterval>;
  lastPongAt: number;
}

const activeTunnelConnections = new Map<string, TunnelConnection>();

// Callback registry for tunnel data from agent: Map<tunnelId, callback>
type TunnelDataCallback = (data: Uint8Array) => void;
const tunnelDataCallbacks = new Map<string, TunnelDataCallback>();

// Tunnel ownership: tracks which agent owns each tunnel (populated on tunnel_open, before browser connects)
// Separate from activeTunnelConnections which is only populated when the browser WS attaches.
const tunnelAgentOwnership = new Map<string, string>(); // tunnelId → agentId

// Buffer for early frames: data arriving from agent before the browser WS connects.
// VNC servers send the RFB banner immediately on TCP connect, before the browser attaches.
const MAX_BUFFER_SIZE = 512 * 1024; // 512KB max buffer per tunnel
const earlyFrameBuffers = new Map<string, Uint8Array[]>();

// Server-side ping/pong constants
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// Rate limiting
const USER_WS_RATE_WINDOW_MS = 60_000;
const USER_WS_RATE_MAX = 10;
const userWsTimestamps = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - USER_WS_RATE_WINDOW_MS;
  let timestamps = userWsTimestamps.get(userId);
  if (timestamps) {
    timestamps = timestamps.filter(t => t > cutoff);
  } else {
    timestamps = [];
  }
  if (timestamps.length >= USER_WS_RATE_MAX) {
    userWsTimestamps.set(userId, timestamps);
    return true;
  }
  timestamps.push(now);
  userWsTimestamps.set(userId, timestamps);
  return false;
}

// Periodic cleanup
setInterval(() => {
  const cutoff = Date.now() - USER_WS_RATE_WINDOW_MS * 2;
  for (const [userId, timestamps] of userWsTimestamps) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1]! < cutoff) {
      userWsTimestamps.delete(userId);
    }
  }
}, 120_000);

/**
 * Register tunnel ownership (called when tunnel_open succeeds, before browser connects).
 */
export function registerTunnelOwnership(tunnelId: string, agentId: string): void {
  tunnelAgentOwnership.set(tunnelId, agentId);
  earlyFrameBuffers.set(tunnelId, []);
}

/**
 * Handle tunnel data arriving from the agent (binary 0x03 frames via agentWs).
 * Relays to browser WS if connected, otherwise buffers for later flush.
 */
export function handleTunnelDataFromAgent(tunnelId: string, data: Uint8Array): void {
  const callback = tunnelDataCallbacks.get(tunnelId);
  if (callback) {
    callback(data);
    return;
  }

  // Browser not connected yet — buffer early frames (e.g., VNC RFB banner).
  const buf = earlyFrameBuffers.get(tunnelId);
  if (buf) {
    const totalSize = buf.reduce((s, b) => s + b.length, 0) + data.length;
    if (totalSize <= MAX_BUFFER_SIZE) {
      buf.push(new Uint8Array(data));
    }
    // Silently drop if buffer is full — better than crashing.
  }
}

/**
 * Check if a tunnel is owned by a specific agent.
 * Uses the ownership map (populated on tunnel_open) rather than activeTunnelConnections
 * (which is only populated when the browser WS connects).
 */
export function isTunnelOwnedByAgent(tunnelId: string, agentId: string): boolean {
  const owner = tunnelAgentOwnership.get(tunnelId);
  if (owner) return owner === agentId;
  // Fallback to active connections for backwards compat
  const conn = activeTunnelConnections.get(tunnelId);
  if (!conn) return false;
  return conn.agentId === agentId;
}

/**
 * Validate one-time WS ticket and tunnel session access.
 */
async function validateTunnelAccess(
  tunnelId: string,
  ticket: string | undefined
): Promise<{ valid: boolean; error?: string; session?: typeof tunnelSessions.$inferSelect; agentId?: string; userId?: string }> {
  if (!ticket) {
    return { valid: false, error: 'Missing connection ticket' };
  }

  const ticketRecord = await consumeWsTicket(ticket);
  if (!ticketRecord) {
    return { valid: false, error: 'Invalid or expired connection ticket' };
  }

  if (ticketRecord.sessionId !== tunnelId || ticketRecord.sessionType !== 'tunnel') {
    return { valid: false, error: 'Connection ticket does not match tunnel session' };
  }

  // Check user exists and is active
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, ticketRecord.userId))
    .limit(1);

  if (!user || user.status !== 'active') {
    return { valid: false, error: 'User not found or inactive' };
  }

  // Get tunnel session with device info
  const [result] = await db
    .select({
      session: tunnelSessions,
      device: devices
    })
    .from(tunnelSessions)
    .innerJoin(devices, eq(tunnelSessions.deviceId, devices.id))
    .where(eq(tunnelSessions.id, tunnelId))
    .limit(1);

  if (!result) {
    return { valid: false, error: 'Tunnel session not found' };
  }

  const { session, device } = result;

  if (session.userId !== user.id) {
    return { valid: false, error: 'Tunnel session does not belong to this user' };
  }

  if (!['pending', 'connecting', 'active'].includes(session.status)) {
    return { valid: false, error: `Tunnel session is ${session.status}` };
  }

  if (device.status !== 'online') {
    return { valid: false, error: 'Device is not online' };
  }

  return { valid: true, session, agentId: device.agentId ?? undefined, userId: user.id };
}

function cleanupTunnelConnection(tunnelId: string) {
  const conn = activeTunnelConnections.get(tunnelId);
  if (conn?.pingInterval) {
    clearInterval(conn.pingInterval);
  }
  activeTunnelConnections.delete(tunnelId);
  tunnelDataCallbacks.delete(tunnelId);
  tunnelAgentOwnership.delete(tunnelId);
  earlyFrameBuffers.delete(tunnelId);
}

/**
 * Create WebSocket handlers for a tunnel session.
 */
function createTunnelWsHandlers(tunnelId: string, ticket: string | undefined) {
  let validationResult: Awaited<ReturnType<typeof validateTunnelAccess>> | null = null;
  const validationPromise = validateTunnelAccess(tunnelId, ticket).then(result => {
    validationResult = result;
  });

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      try {
        await validationPromise;

        if (!validationResult || !validationResult.valid) {
          console.warn(`[TunnelWs] Rejected tunnel ${tunnelId}: ${validationResult?.error}`);
          ws.send(JSON.stringify({ type: 'error', message: validationResult?.error ?? 'Validation failed' }));
          ws.close(4001, validationResult?.error ?? 'Validation failed');
          return;
        }

        const { session, agentId, userId } = validationResult;
        if (!session || !agentId || !userId) {
          ws.close(4001, 'Missing session data');
          return;
        }

        if (isRateLimited(userId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Too many tunnel connections' }));
          ws.close(4029, 'Rate limited');
          return;
        }

        if (!isAgentConnected(agentId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Agent is not connected' }));
          ws.close(4002, 'Agent offline');
          return;
        }

        // Register data callback: agent data → user WebSocket
        tunnelDataCallbacks.set(tunnelId, (data: Uint8Array) => {
          try {
            ws.send(data);
          } catch (err) {
            console.warn(`[TunnelWs] Failed to relay data for tunnel ${tunnelId}, cleaning up:`, err);
            cleanupTunnelConnection(tunnelId);
            try { ws.close(4005, 'Relay error'); } catch { /* already closing */ }
          }
        });

        // Flush any early frames buffered before the browser connected
        // (e.g., VNC RFB banner sent by the server on TCP connect).
        const buffered = earlyFrameBuffers.get(tunnelId);
        if (buffered && buffered.length > 0) {
          for (const frame of buffered) {
            try { ws.send(frame); } catch { break; }
          }
        }
        earlyFrameBuffers.delete(tunnelId);

        // Store connection
        const connection: TunnelConnection = {
          userWs: ws,
          agentId,
          userId,
          deviceId: session.deviceId,
          orgId: session.orgId,
          tunnelType: session.type,
          startedAt: new Date(),
          lastPongAt: Date.now(),
        };
        activeTunnelConnections.set(tunnelId, connection);

        // Server-side ping to detect stale connections
        connection.pingInterval = setInterval(() => {
          const conn = activeTunnelConnections.get(tunnelId);
          if (!conn) return;

          if (Date.now() - conn.lastPongAt > PING_INTERVAL_MS + PONG_TIMEOUT_MS) {
            console.warn(`[TunnelWs] Stale tunnel connection ${tunnelId}, closing`);
            cleanupTunnelConnection(tunnelId);
            ws.close(4003, 'Connection timeout');
            return;
          }

          try {
            ws.send(JSON.stringify({ type: 'ping' }));
          } catch {
            cleanupTunnelConnection(tunnelId);
          }
        }, PING_INTERVAL_MS);

        // Only transition to active if the tunnel_open succeeded (status = connecting).
        // If the agent already failed, session.status will be 'failed' and we should not override.
        const [currentSession] = await db
          .select({ status: tunnelSessions.status })
          .from(tunnelSessions)
          .where(eq(tunnelSessions.id, tunnelId))
          .limit(1);

        if (currentSession?.status === 'failed') {
          ws.send(JSON.stringify({ type: 'error', message: 'Tunnel failed to open on agent' }));
          cleanupTunnelConnection(tunnelId);
          ws.close(4004, 'Tunnel open failed');
          return;
        }

        await db
          .update(tunnelSessions)
          .set({ status: 'active', startedAt: new Date() })
          .where(eq(tunnelSessions.id, tunnelId));

        ws.send(JSON.stringify({ type: 'connected', tunnelId }));
      } catch (error) {
        console.error(`[TunnelWs] Error in onOpen for tunnel ${tunnelId}:`, error);
        captureException(error);
        ws.close(4000, 'Internal error');
      }
    },

    onMessage: async (event: MessageEvent, ws: WSContext) => {
      const conn = activeTunnelConnections.get(tunnelId);
      if (!conn) {
        ws.close(4001, 'No active tunnel connection');
        return;
      }

      try {
        // Binary data — relay directly to agent
        if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
          const buf = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;

          // Size limit: 1MB per frame
          if (buf.length > 1_000_000) {
            console.warn(`[TunnelWs] Dropping oversized user frame for tunnel ${tunnelId}: ${buf.length} bytes`);
            return;
          }

          const b64 = Buffer.from(buf).toString('base64');
          const sent = sendCommandToAgent(conn.agentId, {
            id: `tun-data-${Date.now()}`,
            type: 'tunnel_data',
            payload: { tunnelId, data: b64 },
          });
          if (!sent) {
            console.warn(`[TunnelWs] Agent ${conn.agentId} disconnected, cannot relay for tunnel ${tunnelId}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Agent disconnected' }));
            cleanupTunnelConnection(tunnelId);
            ws.close(4002, 'Agent offline');
            return;
          }
          return;
        }

        // Text data — JSON messages (ping/pong)
        const text = typeof event.data === 'string' ? event.data : event.data.toString();
        let msg: { type: string };
        try {
          msg = JSON.parse(text);
        } catch {
          return; // Ignore malformed JSON
        }

        if (msg.type === 'pong') {
          conn.lastPongAt = Date.now();
        } else if (msg.type === 'data' && 'data' in msg) {
          // Text-mode data relay (base64-encoded)
          const dataMsg = msg as { type: string; data: string };
          const sent = sendCommandToAgent(conn.agentId, {
            id: `tun-data-${Date.now()}`,
            type: 'tunnel_data',
            payload: { tunnelId, data: dataMsg.data },
          });
          if (!sent) {
            console.warn(`[TunnelWs] Agent ${conn.agentId} disconnected, cannot relay for tunnel ${tunnelId}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Agent disconnected' }));
            cleanupTunnelConnection(tunnelId);
            ws.close(4002, 'Agent offline');
            return;
          }
        }
      } catch (error) {
        console.error(`[TunnelWs] Error handling message for tunnel ${tunnelId}:`, error);
        captureException(error);
      }
    },

    onClose: async () => {
      console.log(`[TunnelWs] Tunnel ${tunnelId} WebSocket closed`);

      // Read the connection BEFORE cleanup removes it from the map.
      const conn = activeTunnelConnections.get(tunnelId);
      cleanupTunnelConnection(tunnelId);

      // Notify agent to close the TCP connection
      if (conn) {
        sendCommandToAgent(conn.agentId, {
          id: `tun-close-${Date.now()}`,
          type: 'tunnel_close',
          payload: { tunnelId },
        });
      }

      // Update session status
      try {
        await db
          .update(tunnelSessions)
          .set({
            status: 'disconnected',
            endedAt: new Date(),
          })
          .where(eq(tunnelSessions.id, tunnelId));
      } catch (err) {
        console.error(`[TunnelWs] Failed to update tunnel ${tunnelId} status on close:`, err);
      }
    },

    onError: (error: unknown) => {
      console.error(`[TunnelWs] Error for tunnel ${tunnelId}:`, error);
      captureException(error);
      cleanupTunnelConnection(tunnelId);
    },
  };
}

/**
 * Create tunnel WebSocket routes.
 * Pattern: GET /api/v1/tunnel-ws/:tunnelId/ws?ticket=xxx
 */
export function createTunnelWsRoutes(upgradeWebSocket: (createEvents: () => ReturnType<typeof createTunnelWsHandlers>) => any) {
  const routes = new Hono();

  routes.get('/:tunnelId/ws', (c) => {
    const tunnelId = c.req.param('tunnelId');
    const ticket = c.req.query('ticket');

    if (!tunnelId) {
      return c.json({ error: 'Missing tunnelId' }, 400);
    }

    const wsHandler = upgradeWebSocket(() => createTunnelWsHandlers(tunnelId, ticket));
    return wsHandler(c, c.req.raw);
  });

  return routes;
}
