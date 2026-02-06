import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db } from '../db';
import { devices, deviceCommands, scriptExecutions, scriptExecutionBatches } from '../db/schema';
import { handleTerminalOutput } from './terminalWs';

// Store active WebSocket connections by agentId
// Map<agentId, WSContext>
const activeConnections = new Map<string, WSContext>();

// Message types from agent
const commandResultSchema = z.object({
  type: z.literal('command_result'),
  commandId: z.string(),
  status: z.enum(['completed', 'failed', 'timeout']),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().int().optional(),
  error: z.string().optional(),
  result: z.any().optional()
});

const heartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  timestamp: z.number()
});

const terminalOutputSchema = z.object({
  type: z.literal('terminal_output'),
  sessionId: z.string(),
  data: z.string()
});

const agentMessageSchema = z.discriminatedUnion('type', [
  commandResultSchema,
  heartbeatMessageSchema,
  terminalOutputSchema
]);

// Command types sent to agent
export interface AgentCommand {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Validate agent token by hashing it and comparing against the stored hash.
 */
async function validateAgentToken(agentId: string, token: string): Promise<boolean> {
  if (!token || !token.startsWith('brz_')) {
    return false;
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const [device] = await db
    .select({ id: devices.id, agentTokenHash: devices.agentTokenHash })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device || !device.agentTokenHash) {
    return false;
  }

  return device.agentTokenHash === tokenHash;
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

    // Agent sends structured data in `result` field (parsed JSON) rather than
    // `stdout` (raw string). Convert it back to a JSON string for storage.
    const stdout = result.stdout ??
      (result.result !== undefined ? JSON.stringify(result.result) : undefined);

    await db
      .update(deviceCommands)
      .set({
        status: result.status === 'completed' ? 'completed' : 'failed',
        completedAt: new Date(),
        result: {
          status: result.status,
          exitCode: result.exitCode,
          stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          error: result.error
        }
      })
      .where(eq(deviceCommands.id, result.commandId));

    console.log(`Command ${result.commandId} ${result.status} for agent ${agentId}`);

    // If this was a script command, update the scriptExecutions record
    if (command.type === 'script') {
      const payload = command.payload as Record<string, unknown> | null;
      const executionId = payload?.executionId as string | undefined;
      if (executionId) {
        let scriptStatus: string;
        if (result.status === 'completed') {
          scriptStatus = result.exitCode && result.exitCode !== 0 ? 'failed' : 'completed';
        } else if (result.status === 'timeout') {
          scriptStatus = 'timeout';
        } else {
          scriptStatus = 'failed';
        }

        await db
          .update(scriptExecutions)
          .set({
            status: scriptStatus,
            completedAt: new Date(),
            exitCode: result.exitCode ?? null,
            stdout: stdout ?? null,
            stderr: result.stderr ?? null,
            errorMessage: result.error ?? null,
          })
          .where(eq(scriptExecutions.id, executionId));

        // Update batch counters if this is part of a batch
        const batchId = payload?.batchId as string | undefined;
        if (batchId) {
          const counterField = scriptStatus === 'completed' ? 'devicesCompleted' : 'devicesFailed';
          await db
            .update(scriptExecutionBatches)
            .set({
              [counterField]: sql`${scriptExecutionBatches[counterField]} + 1`
            })
            .where(eq(scriptExecutionBatches.id, batchId));
        }
      }
    }
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

        // Handle terminal_output messages directly (high-frequency streaming
        // data that doesn't need full schema validation)
        if (message.type === 'terminal_output' && typeof message.sessionId === 'string' && typeof message.data === 'string') {
          handleTerminalOutput(message.sessionId, message.data);
          return;
        }

        // Handle command_result for terminal commands (non-UUID IDs)
        if (message.type === 'command_result' && typeof message.commandId === 'string' && message.commandId.startsWith('term-')) {
          // Terminal command results don't map to DB records - just acknowledge
          ws.send(JSON.stringify({
            type: 'ack',
            commandId: message.commandId
          }));
          return;
        }

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
      updateDeviceStatus(agentId, 'offline');
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
    // Send command directly - agent expects {id, type, payload} at top level
    ws.send(JSON.stringify(command));
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
