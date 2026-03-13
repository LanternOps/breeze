import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { remoteSessions, devices, users } from '../db/schema';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { sendCommandToAgent, isAgentConnected } from './agentWs';

// Zod validation for terminal user messages
const terminalMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), data: z.string().max(16384) }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(500) }),
  z.object({ type: z.literal('ping') }),
]);

// Store active terminal sessions
// Map<sessionId, { userWs: WSContext, agentId: string, userId: string }>
interface TerminalSession {
  userWs: WSContext;
  agentId: string;
  userId: string;
  deviceId: string;
  startedAt: Date;
  pingInterval?: ReturnType<typeof setInterval>;
  lastPongAt: number;
}

const activeTerminalSessions = new Map<string, TerminalSession>();

// Store pending terminal output to relay back to user
// Map<sessionId, callback>
type TerminalOutputCallback = (data: string) => void;
const terminalOutputCallbacks = new Map<string, TerminalOutputCallback>();

// Server-side ping/pong constants for stale connection detection
const PING_INTERVAL_MS = 30_000; // Send ping every 30 seconds
const PONG_TIMEOUT_MS = 10_000; // Close if no pong within 10 seconds

// In-memory sliding window rate limiter for user WS upgrades
const USER_WS_RATE_WINDOW_MS = 60_000; // 1 minute window
const USER_WS_RATE_MAX_CONNECTIONS = 10; // max 10 connections per user per minute
const userWsConnTimestamps = new Map<string, number[]>();

function isUserTerminalWsRateLimited(userId: string): boolean {
  const now = Date.now();
  const cutoff = now - USER_WS_RATE_WINDOW_MS;
  let timestamps = userWsConnTimestamps.get(userId);

  if (timestamps) {
    timestamps = timestamps.filter(t => t > cutoff);
  } else {
    timestamps = [];
  }

  if (timestamps.length >= USER_WS_RATE_MAX_CONNECTIONS) {
    userWsConnTimestamps.set(userId, timestamps);
    return true;
  }

  timestamps.push(now);
  userWsConnTimestamps.set(userId, timestamps);
  return false;
}

// Periodic cleanup of stale rate-limit entries
setInterval(() => {
  const cutoff = Date.now() - USER_WS_RATE_WINDOW_MS * 2;
  for (const [userId, timestamps] of userWsConnTimestamps) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1]! < cutoff) {
      userWsConnTimestamps.delete(userId);
    }
  }
}, 120_000);

/**
 * Validate one-time WS ticket and session access
 */
async function validateTerminalAccess(
  sessionId: string,
  ticket: string | undefined
): Promise<{ valid: boolean; error?: string; session?: typeof remoteSessions.$inferSelect; device?: typeof devices.$inferSelect; userId?: string }> {
  if (!ticket) {
    return { valid: false, error: 'Missing connection ticket' };
  }

  const ticketRecord = await consumeWsTicket(ticket);
  if (!ticketRecord) {
    return { valid: false, error: 'Invalid or expired connection ticket' };
  }

  if (ticketRecord.sessionId !== sessionId || ticketRecord.sessionType !== 'terminal') {
    return { valid: false, error: 'Connection ticket does not match terminal session' };
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

  // Get session with device info
  const [result] = await db
    .select({
      session: remoteSessions,
      device: devices
    })
    .from(remoteSessions)
    .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
    .where(eq(remoteSessions.id, sessionId))
    .limit(1);

  if (!result) {
    return { valid: false, error: 'Session not found' };
  }

  const { session, device } = result;

  // Check session is for terminal
  if (session.type !== 'terminal') {
    return { valid: false, error: 'Session is not a terminal session' };
  }

  // Check session belongs to this user
  if (session.userId !== user.id) {
    return { valid: false, error: 'Session does not belong to this user' };
  }

  // Check session status
  if (!['pending', 'connecting', 'active'].includes(session.status)) {
    return { valid: false, error: `Session is ${session.status}` };
  }

  // Check device is online
  if (device.status !== 'online') {
    return { valid: false, error: 'Device is not online' };
  }

  return { valid: true, session, device, userId: user.id };
}

/**
 * Handle terminal output from agent
 * Called by agentWs when it receives terminal data
 */
export function handleTerminalOutput(sessionId: string, data: string): void {
  const callback = terminalOutputCallbacks.get(sessionId);
  if (callback) {
    callback(data);
  }
}

/**
 * Register a callback for terminal output
 */
export function registerTerminalOutputCallback(sessionId: string, callback: TerminalOutputCallback): void {
  terminalOutputCallbacks.set(sessionId, callback);
}

/**
 * Unregister terminal output callback
 */
export function unregisterTerminalOutputCallback(sessionId: string): void {
  terminalOutputCallbacks.delete(sessionId);
}

/**
 * Get active terminal session
 */
export function getActiveTerminalSession(sessionId: string): TerminalSession | undefined {
  return activeTerminalSessions.get(sessionId);
}

/**
 * Create WebSocket handlers for terminal session
 */
function createTerminalWsHandlers(sessionId: string, ticket: string | undefined) {
  let validationResult: Awaited<ReturnType<typeof validateTerminalAccess>> | null = null;
  const validationPromise = validateTerminalAccess(sessionId, ticket).then(result => {
    validationResult = result;
  });

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      console.log(`Terminal WebSocket onOpen for session ${sessionId}`);
      await validationPromise;
      console.log(`Terminal validation result:`, validationResult?.valid, validationResult?.error);

      if (!validationResult || !validationResult.valid) {
        console.warn(`Terminal WebSocket rejected for session ${sessionId}: ${validationResult?.error}`);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'AUTH_FAILED',
          message: validationResult?.error || 'Authentication failed'
        }));
        ws.close(4001, 'Authentication failed');
        return;
      }

      const { session, device, userId } = validationResult;
      if (!session || !device || !userId) {
        ws.close(4001, 'Invalid session data');
        return;
      }

      // Check if agent is connected
      console.log(`Checking if agent ${device.agentId} is connected...`);
      if (!isAgentConnected(device.agentId)) {
        console.warn(`Agent ${device.agentId} is not connected via WebSocket`);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'AGENT_OFFLINE',
          message: 'Agent is not connected via WebSocket'
        }));
        ws.close(4002, 'Agent offline');
        return;
      }
      console.log(`Agent ${device.agentId} is connected`);

      // Rate limit user WS connections
      if (isUserTerminalWsRateLimited(userId)) {
        console.warn(`Terminal WebSocket rate limited for user ${userId}`);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'RATE_LIMITED',
          message: 'Too many connection attempts'
        }));
        ws.close(4029, 'Rate limited');
        return;
      }

      // Store the terminal session
      const now = Date.now();
      activeTerminalSessions.set(sessionId, {
        userWs: ws,
        agentId: device.agentId,
        userId,
        deviceId: device.id,
        startedAt: new Date(),
        lastPongAt: now,
      });

      // Register callback for terminal output
      registerTerminalOutputCallback(sessionId, (data: string) => {
        try {
          ws.send(JSON.stringify({ type: 'output', data }));
        } catch (error) {
          console.error(`Failed to send terminal output to session ${sessionId}:`, error);
        }
      });

      console.log(`Terminal session ${sessionId} connected for device ${device.hostname}`);

      // Update session status
      await db
        .update(remoteSessions)
        .set({
          status: 'active',
          startedAt: new Date()
        })
        .where(eq(remoteSessions.id, sessionId));

      // Send connected message to user
      ws.send(JSON.stringify({
        type: 'connected',
        sessionId,
        device: {
          hostname: device.hostname,
          osType: device.osType
        }
      }));

      // Send terminal_start command to agent
      const startCommand = {
        id: `term-start-${sessionId}`,
        type: 'terminal_start',
        payload: {
          sessionId,
          cols: 80,
          rows: 24,
          shell: device.osType === 'windows' ? 'powershell' : undefined
        }
      };

      const sent = sendCommandToAgent(device.agentId, startCommand);
      if (!sent) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'AGENT_SEND_FAILED',
          message: 'Failed to send start command to agent'
        }));
      }

      // Start server-side ping/pong for stale connection detection
      const pingInterval = setInterval(() => {
        const termSess = activeTerminalSessions.get(sessionId);
        if (!termSess) {
          clearInterval(pingInterval);
          return;
        }
        const elapsed = Date.now() - termSess.lastPongAt;
        if (elapsed > PING_INTERVAL_MS + PONG_TIMEOUT_MS) {
          console.warn(`Terminal session ${sessionId} pong timeout (${elapsed}ms), closing`);
          clearInterval(pingInterval);
          ws.close(4008, 'Pong timeout');
          return;
        }
        try {
          ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        } catch (err) {
          console.warn(`[TerminalWs] Ping send failed for session ${sessionId}, cleaning up`, err);
          clearInterval(pingInterval);
        }
      }, PING_INTERVAL_MS);

      const currentSession = activeTerminalSessions.get(sessionId);
      if (currentSession) {
        currentSession.pingInterval = pingInterval;
      }
    },

    onMessage: async (event: MessageEvent, ws: WSContext) => {
      const termSession = activeTerminalSessions.get(sessionId);
      if (!termSession) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'SESSION_NOT_FOUND',
          message: 'Terminal session not found'
        }));
        return;
      }

      try {
        const data = typeof event.data === 'string' ? event.data : event.data.toString();
        const raw = JSON.parse(data);

        // Handle pong responses for server-initiated ping (not in discriminatedUnion)
        if (raw?.type === 'pong') {
          termSession.lastPongAt = Date.now();
          return;
        }

        const parsed = terminalMessageSchema.safeParse(raw);
        if (!parsed.success) {
          console.warn(`Invalid terminal message from session ${sessionId}:`, parsed.error.errors);
          return;
        }
        const message = parsed.data;

        switch (message.type) {
          case 'data':
            // Send terminal input to agent
            sendCommandToAgent(termSession.agentId, {
              id: `term-data-${Date.now()}`,
              type: 'terminal_data',
              payload: {
                sessionId,
                data: message.data
              }
            });
            break;

          case 'resize':
            // Send resize command to agent
            sendCommandToAgent(termSession.agentId, {
              id: `term-resize-${Date.now()}`,
              type: 'terminal_resize',
              payload: {
                sessionId,
                cols: message.cols,
                rows: message.rows
              }
            });
            break;

          case 'ping':
            // Client-initiated ping — respond with pong and update timestamp
            termSession.lastPongAt = Date.now();
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
        }
      } catch (error) {
        console.error(`Error processing terminal message for session ${sessionId}:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'MESSAGE_ERROR',
          message: 'Failed to process message'
        }));
      }
    },

    onClose: async (_event: unknown, _ws: WSContext) => {
      const termSession = activeTerminalSessions.get(sessionId);

      if (termSession) {
        // Clear ping interval
        if (termSession.pingInterval) {
          clearInterval(termSession.pingInterval);
        }

        // Send terminal_stop command to agent
        sendCommandToAgent(termSession.agentId, {
          id: `term-stop-${sessionId}`,
          type: 'terminal_stop',
          payload: { sessionId }
        });

        // Clean up
        activeTerminalSessions.delete(sessionId);
        unregisterTerminalOutputCallback(sessionId);

        // Update session status
        const endedAt = new Date();
        const startedAt = termSession.startedAt;
        const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

        await db
          .update(remoteSessions)
          .set({
            status: 'disconnected',
            endedAt,
            durationSeconds
          })
          .where(eq(remoteSessions.id, sessionId));

        console.log(`Terminal session ${sessionId} disconnected (duration: ${durationSeconds}s)`);
      }
    },

    onError: async (event: unknown, _ws: WSContext) => {
      console.error(`Terminal WebSocket error for session ${sessionId}:`, event);
      const termSession = activeTerminalSessions.get(sessionId);
      if (termSession?.pingInterval) {
        clearInterval(termSession.pingInterval);
      }
      activeTerminalSessions.delete(sessionId);
      unregisterTerminalOutputCallback(sessionId);

      // Update session status in database to match onClose behavior
      if (termSession) {
        try {
          const endedAt = new Date();
          const durationSeconds = Math.round((endedAt.getTime() - termSession.startedAt.getTime()) / 1000);

          await db
            .update(remoteSessions)
            .set({
              status: 'disconnected',
              endedAt,
              durationSeconds
            })
            .where(eq(remoteSessions.id, sessionId));

          console.log(`Terminal session ${sessionId} errored and cleaned up (duration: ${durationSeconds}s)`);
        } catch (dbError) {
          console.error(`Failed to update session ${sessionId} status after error:`, dbError);
        }
      }
    }
  };
}

/**
 * Create terminal WebSocket routes
 */
export function createTerminalWsRoutes(upgradeWebSocket: Function): Hono {
  const app = new Hono();

  // WebSocket route for terminal sessions
  // GET /api/v1/remote/sessions/:id/ws?ticket=xxx
  app.get(
    '/:id/ws',
    upgradeWebSocket((c: { req: { param: (key: string) => string; query: (key: string) => string | undefined } }) => {
      const sessionId = c.req.param('id');
      const ticket = c.req.query('ticket');
      return createTerminalWsHandlers(sessionId, ticket);
    })
  );

  return app;
}

/**
 * Get count of active terminal sessions
 */
export function getActiveTerminalSessionCount(): number {
  return activeTerminalSessions.size;
}

/**
 * Get all active terminal session IDs
 */
export function getActiveTerminalSessionIds(): string[] {
  return Array.from(activeTerminalSessions.keys());
}
