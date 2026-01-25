import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { devices, deviceCommands } from '../db/schema';

// Store active WebSocket connections by agentId
// Map<agentId, WSContext>
const activeConnections = new Map<string, WSContext>();

// Message types from agent
const commandResultSchema = z.object({
  type: z.literal('command_result'),
  commandId: z.string().uuid(),
  status: z.enum(['completed', 'failed', 'timeout']),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().int(),
  error: z.string().optional()
});

const heartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  timestamp: z.number()
});

const agentMessageSchema = z.discriminatedUnion('type', [
  commandResultSchema,
  heartbeatMessageSchema
]);

// Command types sent to agent
export interface AgentCommand {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Validate agent token against the device
 * The token is the authToken returned during enrollment (brz_xxx format)
 * For now, we validate by checking if the agentId exists
 * In production, you would hash and compare the token
 */
async function validateAgentToken(agentId: string, token: string): Promise<boolean> {
  if (!token || !token.startsWith('brz_')) {
    return false;
  }

  // Look up the device by agentId
  const [device] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  // For now, just validate that the device exists and token format is valid
  // In production, store hashed tokens and compare
  return !!device;
}

/**
 * Update device status when WebSocket connects/disconnects
 */
async function updateDeviceStatus(agentId: string, status: 'online' | 'offline'): Promise<void> {
  try {
    await db
      .update(devices)
      .set({
        status,
        lastSeenAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(devices.agentId, agentId));
  } catch (error) {
    console.error(`Failed to update device status for ${agentId}:`, error);
  }
}

/**
 * Process command result from agent
 */
async function processCommandResult(
  agentId: string,
  result: z.infer<typeof commandResultSchema>
): Promise<void> {
  try {
    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, result.commandId))
      .limit(1);

    if (!command) {
      console.warn(`Command ${result.commandId} not found for agent ${agentId}`);
      return;
    }

    await db
      .update(deviceCommands)
      .set({
        status: result.status === 'completed' ? 'completed' : 'failed',
        completedAt: new Date(),
        result: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          error: result.error
        }
      })
      .where(eq(deviceCommands.id, result.commandId));

    console.log(`Command ${result.commandId} ${result.status} for agent ${agentId}`);
  } catch (error) {
    console.error(`Failed to process command result for ${agentId}:`, error);
  }
}

/**
 * Get pending commands for an agent
 */
async function getPendingCommands(agentId: string): Promise<AgentCommand[]> {
  try {
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) {
      return [];
    }

    const commands = await db
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.deviceId, device.id),
          eq(deviceCommands.status, 'pending')
        )
      )
      .orderBy(deviceCommands.createdAt)
      .limit(10);

    // Mark commands as sent
    for (const cmd of commands) {
      await db
        .update(deviceCommands)
        .set({ status: 'sent', executedAt: new Date() })
        .where(eq(deviceCommands.id, cmd.id));
    }

    return commands.map(cmd => ({
      id: cmd.id,
      type: cmd.type,
      payload: (cmd.payload as Record<string, unknown>) || {}
    }));
  } catch (error) {
    console.error(`Failed to get pending commands for ${agentId}:`, error);
    return [];
  }
}

/**
 * Create WebSocket handlers for a given agentId and token
 * This returns the handler object expected by upgradeWebSocket
 */
export function createAgentWsHandlers(agentId: string, token: string | undefined) {
  // Pre-validate token
  let isValid = false;
  const validationPromise = token
    ? validateAgentToken(agentId, token).then(result => { isValid = result; })
    : Promise.resolve();

  return {
    onOpen: async (_event: unknown, ws: WSContext) => {
      await validationPromise;

      if (!isValid) {
        console.warn(`WebSocket connection rejected for agent ${agentId}: invalid token`);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'AUTH_FAILED',
          message: 'Invalid or missing authentication token'
        }));
        ws.close(4001, 'Authentication failed');
        return;
      }

      // Store connection
      activeConnections.set(agentId, ws);
      console.log(`Agent ${agentId} connected via WebSocket. Active connections: ${activeConnections.size}`);

      // Update device status
      await updateDeviceStatus(agentId, 'online');

      // Send welcome message with any pending commands
      const pendingCommands = await getPendingCommands(agentId);
      ws.send(JSON.stringify({
        type: 'connected',
        agentId,
        timestamp: Date.now(),
        pendingCommands
      }));
    },

    onMessage: async (event: MessageEvent, ws: WSContext) => {
      try {
        const data = typeof event.data === 'string'
          ? event.data
          : event.data.toString();

        const message = JSON.parse(data);
        const parsed = agentMessageSchema.safeParse(message);

        if (!parsed.success) {
          console.warn(`Invalid message from agent ${agentId}:`, parsed.error.errors);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'INVALID_MESSAGE',
            message: 'Invalid message format',
            details: parsed.error.errors
          }));
          return;
        }

        switch (parsed.data.type) {
          case 'command_result':
            await processCommandResult(agentId, parsed.data);
            ws.send(JSON.stringify({
              type: 'ack',
              commandId: parsed.data.commandId
            }));
            break;

          case 'heartbeat':
            // Update last seen timestamp
            await updateDeviceStatus(agentId, 'online');

            // Check for pending commands and send them
            const pendingCommands = await getPendingCommands(agentId);
            ws.send(JSON.stringify({
              type: 'heartbeat_ack',
              timestamp: Date.now(),
              commands: pendingCommands
            }));
            break;
        }
      } catch (error) {
        console.error(`Error processing message from agent ${agentId}:`, error);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'PROCESSING_ERROR',
          message: 'Failed to process message'
        }));
      }
    },

    onClose: async (_event: unknown, _ws: WSContext) => {
      // Remove from active connections
      activeConnections.delete(agentId);
      console.log(`Agent ${agentId} disconnected. Active connections: ${activeConnections.size}`);

      // Update device status to offline
      await updateDeviceStatus(agentId, 'offline');
    },

    onError: (event: unknown, _ws: WSContext) => {
      console.error(`WebSocket error for agent ${agentId}:`, event);
      activeConnections.delete(agentId);
    }
  };
}

/**
 * Create the agent WebSocket routes
 * The upgradeWebSocket function must be passed from the main app
 */
export function createAgentWsRoutes(upgradeWebSocket: Function): Hono {
  const app = new Hono();

  // WebSocket route for agent connections
  // GET /api/v1/agent-ws/:id/ws?token=xxx
  app.get(
    '/:id/ws',
    upgradeWebSocket((c: { req: { param: (key: string) => string; query: (key: string) => string | undefined } }) => {
      const agentId = c.req.param('id');
      const token = c.req.query('token');
      return createAgentWsHandlers(agentId, token);
    })
  );

  return app;
}

/**
 * Send a command to a connected agent via WebSocket
 * Returns true if the command was sent, false if agent is not connected
 */
export function sendCommandToAgent(agentId: string, command: AgentCommand): boolean {
  const ws = activeConnections.get(agentId);
  if (!ws) {
    return false;
  }

  try {
    ws.send(JSON.stringify({
      messageType: 'command',
      command
    }));
    return true;
  } catch (error) {
    console.error(`Failed to send command to agent ${agentId}:`, error);
    activeConnections.delete(agentId);
    return false;
  }
}

/**
 * Check if an agent is connected via WebSocket
 */
export function isAgentConnected(agentId: string): boolean {
  return activeConnections.has(agentId);
}

/**
 * Get all connected agent IDs
 */
export function getConnectedAgentIds(): string[] {
  return Array.from(activeConnections.keys());
}

/**
 * Get the count of connected agents
 */
export function getConnectedAgentCount(): number {
  return activeConnections.size;
}

/**
 * Broadcast a message to all connected agents
 */
export function broadcastToAgents(
  message: Record<string, unknown>,
  filter?: (agentId: string) => boolean
): number {
  let sent = 0;
  const payload = JSON.stringify(message);

  for (const [agentId, ws] of activeConnections) {
    if (filter && !filter(agentId)) {
      continue;
    }

    try {
      ws.send(payload);
      sent++;
    } catch (error) {
      console.error(`Failed to broadcast to agent ${agentId}:`, error);
      activeConnections.delete(agentId);
    }
  }

  return sent;
}
