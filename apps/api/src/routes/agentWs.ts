import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db } from '../db';
import { devices, deviceCommands, discoveryJobs, scriptExecutions, scriptExecutionBatches } from '../db/schema';
import { handleTerminalOutput } from './terminalWs';
import { handleDesktopFrame, isDesktopSessionOwnedByAgent } from './desktopWs';
import { enqueueDiscoveryResults, type DiscoveredHostResult } from '../jobs/discoveryWorker';
import { enqueueSnmpPollResults, type SnmpMetricResult } from '../jobs/snmpWorker';
import { isRedisAvailable } from '../services/redis';

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
 * Handle command results for commands dispatched directly via WebSocket
 * (without a deviceCommands DB record). This covers discovery scans
 * and SNMP polls which use their own job tracking tables.
 */
async function processOrphanedCommandResult(
  agentId: string,
  result: z.infer<typeof commandResultSchema>
): Promise<void> {
  // Check if this is a discovery job result
  const [discoveryJob] = await db
    .select({ id: discoveryJobs.id, orgId: discoveryJobs.orgId, siteId: discoveryJobs.siteId })
    .from(discoveryJobs)
    .where(eq(discoveryJobs.id, result.commandId))
    .limit(1);

  if (discoveryJob) {
    console.log(`[AgentWs] Processing discovery result for job ${discoveryJob.id} from agent ${agentId}`);
    try {
      const discoveryData = result.result as {
        jobId?: string;
        hosts?: DiscoveredHostResult[];
        hostsScanned?: number;
        hostsDiscovered?: number;
      } | undefined;

      if (result.status !== 'completed' || !discoveryData?.hosts) {
        const errorMsg = result.error || result.stderr || `Agent returned status: ${result.status}`;
        await db
          .update(discoveryJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errors: { message: errorMsg },
            updatedAt: new Date()
          })
          .where(eq(discoveryJobs.id, discoveryJob.id));
        console.warn(`[AgentWs] Discovery job ${discoveryJob.id} failed: ${errorMsg}`);
        return;
      }

      if (isRedisAvailable()) {
        await enqueueDiscoveryResults(
          discoveryJob.id,
          discoveryJob.orgId,
          discoveryJob.siteId,
          discoveryData.hosts,
          discoveryData.hostsScanned ?? 0,
          discoveryData.hostsDiscovered ?? 0
        );
      } else {
        console.warn(`[AgentWs] Redis unavailable, cannot process ${discoveryData.hosts.length} discovery hosts for job ${discoveryJob.id}`);
        await db
          .update(discoveryJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            hostsDiscovered: discoveryData.hostsDiscovered ?? 0,
            hostsScanned: discoveryData.hostsScanned ?? 0,
            errors: { message: 'Results received but could not be processed: job queue unavailable' },
            updatedAt: new Date()
          })
          .where(eq(discoveryJobs.id, discoveryJob.id));
      }
    } catch (err) {
      console.error(`[AgentWs] Failed to process discovery results for ${agentId}:`, err);
    }
    return;
  }

  // Check if this is an SNMP poll result
  const snmpData = result.result as {
    deviceId?: string;
    metrics?: SnmpMetricResult[];
  } | undefined;

  if (snmpData?.deviceId && snmpData.metrics && snmpData.metrics.length > 0) {
    console.log(`[AgentWs] Processing SNMP poll result for device ${snmpData.deviceId} from agent ${agentId}`);
    try {
      if (isRedisAvailable()) {
        await enqueueSnmpPollResults(snmpData.deviceId, snmpData.metrics);
      } else {
        console.warn(`[AgentWs] Redis unavailable, dropping ${snmpData.metrics.length} SNMP metrics for device ${snmpData.deviceId}`);
        const { snmpDevices } = await import('../db/schema');
        await db
          .update(snmpDevices)
          .set({ lastPolled: new Date(), lastStatus: 'warning' })
          .where(eq(snmpDevices.id, snmpData.deviceId));
      }
    } catch (err) {
      console.error(`[AgentWs] Failed to process SNMP poll results for ${agentId}:`, err);
    }
    return;
  }

  console.warn(`[AgentWs] Command ${result.commandId} not found in deviceCommands or discovery jobs for agent ${agentId}`);
}

/**
 * Process command result from agent
 */
async function processCommandResult(
  agentId: string,
  result: z.infer<typeof commandResultSchema>
): Promise<void> {
  try {
    const [ownedCommand] = await db
      .select({
        command: deviceCommands,
        deviceId: devices.id
      })
      .from(deviceCommands)
      .innerJoin(devices, eq(deviceCommands.deviceId, devices.id))
      .where(
        and(
          eq(deviceCommands.id, result.commandId),
          eq(devices.agentId, agentId)
        )
      )
      .limit(1);

    if (!ownedCommand) {
      // Discovery and SNMP commands are dispatched directly via WebSocket
      // without creating a deviceCommands record. Handle them here.
      await processOrphanedCommandResult(agentId, result);
      return;
    }
    const command = ownedCommand.command;

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
      .where(
        and(
          eq(deviceCommands.id, result.commandId),
          eq(deviceCommands.deviceId, ownedCommand.deviceId)
        )
      );

    console.log(`Command ${result.commandId} ${result.status} for agent ${agentId}`);

    // If this was a discovery command, process the results
    if (command.type === 'network_discovery') {
      try {
        const discoveryData = result.result as {
          jobId?: string;
          hosts?: DiscoveredHostResult[];
          hostsScanned?: number;
          hostsDiscovered?: number;
        } | undefined;

        if (discoveryData?.jobId && discoveryData.hosts) {
          // Look up the job to get orgId and siteId
          const [job] = await db
            .select({ orgId: discoveryJobs.orgId, siteId: discoveryJobs.siteId })
            .from(discoveryJobs)
            .where(eq(discoveryJobs.id, discoveryData.jobId))
            .limit(1);

          if (job && isRedisAvailable()) {
            await enqueueDiscoveryResults(
              discoveryData.jobId,
              job.orgId,
              job.siteId,
              discoveryData.hosts,
              discoveryData.hostsScanned ?? 0,
              discoveryData.hostsDiscovered ?? 0
            );
          } else if (job) {
            // Redis not available — mark job failed so user knows results weren't processed
            console.warn(`[AgentWs] Redis unavailable, cannot process ${discoveryData.hosts.length} discovery hosts for job ${discoveryData.jobId}`);
            await db
              .update(discoveryJobs)
              .set({
                status: 'failed',
                completedAt: new Date(),
                hostsDiscovered: discoveryData.hostsDiscovered ?? 0,
                hostsScanned: discoveryData.hostsScanned ?? 0,
                errors: { message: 'Results received but could not be processed: job queue unavailable' },
                updatedAt: new Date()
              })
              .where(eq(discoveryJobs.id, discoveryData.jobId));
          }
        }
      } catch (err) {
        console.error(`[AgentWs] Failed to process discovery results for ${agentId}:`, err);
      }
    }

    // If this was an SNMP poll command, process the metric results
    if (command.type === 'snmp_poll') {
      try {
        const snmpData = result.result as {
          deviceId?: string;
          metrics?: SnmpMetricResult[];
        } | undefined;

        if (snmpData?.deviceId && snmpData.metrics && snmpData.metrics.length > 0) {
          if (isRedisAvailable()) {
            await enqueueSnmpPollResults(snmpData.deviceId, snmpData.metrics);
          } else {
            // Redis not available — log warning about dropped metrics and mark status
            console.warn(`[AgentWs] Redis unavailable, dropping ${snmpData.metrics.length} SNMP metrics for device ${snmpData.deviceId}`);
            const { snmpDevices } = await import('../db/schema');
            await db
              .update(snmpDevices)
              .set({ lastPolled: new Date(), lastStatus: 'warning' })
              .where(eq(snmpDevices.id, snmpData.deviceId));
          }
        }
      } catch (err) {
        console.error(`[AgentWs] Failed to process SNMP poll results for ${agentId}:`, err);
      }
    }

    // If this was a script command, update the scriptExecutions record
    if (command.type === 'script') {
      try {
        const payload = command.payload as Record<string, unknown> | null;
        const executionId = payload?.executionId as string | undefined;
        if (executionId) {
          let scriptStatus: 'completed' | 'failed' | 'timeout';
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
      } catch (err) {
        console.error(`[AgentWs] Failed to process script result for ${agentId}:`, err);
      }
    }
  } catch (error) {
    console.error(`[AgentWs] Failed to process command result for ${agentId}:`, error);
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
        // Binary fast-path for desktop frames: [0x02][36-byte sessionId][JPEG data]
        if (event.data instanceof ArrayBuffer || Buffer.isBuffer(event.data)) {
          const buf = Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data);
          if (buf.length > 37 && buf[0] === 0x02) {
            const sessionId = buf.subarray(1, 37).toString('utf8');
            if (!isDesktopSessionOwnedByAgent(sessionId, agentId)) {
              return; // agent does not own this desktop session
            }
            const frameData = buf.subarray(37);
            handleDesktopFrame(sessionId, new Uint8Array(frameData));
            return;
          }
        }

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

        // Handle command_result for terminal/desktop commands (non-UUID IDs)
        if (message.type === 'command_result' && typeof message.commandId === 'string' &&
            (message.commandId.startsWith('term-') || message.commandId.startsWith('desk-'))) {
          // Ephemeral command results don't map to DB records - just acknowledge
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
    upgradeWebSocket((c: { req: { param: (key: string) => string; query: (key: string) => string | undefined; header: (key: string) => string | undefined } }) => {
      const agentId = c.req.param('id');
      // Accept token from query param (?token=brz_...) or Authorization header (Bearer brz_...)
      let token = c.req.query('token');
      if (!token) {
        const authHeader = c.req.header('Authorization');
        if (authHeader?.startsWith('Bearer ')) {
          token = authHeader.slice(7);
        }
      }
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
