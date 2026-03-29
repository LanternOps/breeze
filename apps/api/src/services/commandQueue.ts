import { eq, and } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../db';
import { deviceCommands, devices, auditLogs } from '../db/schema';
import { sendCommandToAgent } from '../routes/agentWs';
import { captureException } from './sentry';
import { CommandTypes, AUDITED_COMMANDS } from './commandTypes';
import type { CommandType } from './commandTypes';

// Re-export for backward compatibility
export { CommandTypes, AUDITED_COMMANDS } from './commandTypes';
export type { CommandType } from './commandTypes';

export interface CommandPayload {
  [key: string]: unknown;
}

export interface CommandResult {
  status: 'completed' | 'failed' | 'timeout';
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs?: number;
  data?: unknown;
}

export interface QueuedCommand {
  id: string;
  deviceId: string;
  type: string;
  payload: CommandPayload | null;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  executedAt: Date | null;
  completedAt: Date | null;
  result: CommandResult | null;
}

// Use the directly-imported runOutsideDbContext, NOT db.runOutsideDbContext.
// The `db` proxy delegates property lookups to the active transaction when
// inside withDbAccessContext, so db.runOutsideDbContext resolves to
// tx.runOutsideDbContext (undefined), causing the fallback to run fn()
// inside the transaction — which is exactly what we're trying to avoid.
const runOutsideDbContextSafe = runOutsideDbContext;

export interface QueueCommandForExecutionResult {
  command?: QueuedCommand;
  error?: string;
}

/**
 * Queue a command for execution on a device
 */
export async function queueCommand(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  userId?: string
): Promise<QueuedCommand> {
  const [command] = await db
    .insert(deviceCommands)
    .values({
      deviceId,
      type,
      payload,
      status: 'pending',
      createdBy: userId || null,
    })
    .returning();

  // Audit log for mutating commands
  if (command && AUDITED_COMMANDS.has(type)) {
    const [device] = await db
      .select({ orgId: devices.orgId, hostname: devices.hostname })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (device) {
      db.insert(auditLogs)
        .values({
          orgId: device.orgId,
          actorType: userId ? 'user' : 'system',
          actorId: userId || '00000000-0000-0000-0000-000000000000',
          action: `agent.command.${type}`,
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname,
          details: { commandId: command.id, type, payload },
          result: 'success',
        })
        .execute()
        .catch((err) => {
          console.error('Failed to write audit log', {
            commandId: command.id,
            deviceId,
            type,
            error: err,
          });
          captureException(err);
        });
    }
  }

  return command as QueuedCommand;
}

/**
 * Wait for a command to complete with polling
 */
export async function waitForCommandResult(
  commandId: string,
  timeoutMs: number = 30000,
  pollIntervalMs: number = 500
): Promise<QueuedCommand> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId))
      .limit(1);

    if (!command) {
      throw new Error(`Command ${commandId} not found`);
    }

    // Check if command is complete
    if (command.status === 'completed' || command.status === 'failed') {
      return command as QueuedCommand;
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout - update command status
  await db
    .update(deviceCommands)
    .set({
      status: 'failed',
      completedAt: new Date(),
      result: {
        status: 'timeout',
        error: `Command timed out after ${timeoutMs}ms`
      }
    })
    .where(eq(deviceCommands.id, commandId));

  const [timedOutCommand] = await db
    .select()
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId))
    .limit(1);

  return timedOutCommand as QueuedCommand;
}

/**
 * Queue a command and attempt immediate dispatch to the agent websocket.
 */
export async function queueCommandForExecution(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  options: {
    userId?: string;
    preferHeartbeat?: boolean;
  } = {}
): Promise<QueueCommandForExecutionResult> {
  const { userId, preferHeartbeat = false } = options;

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return { error: 'Device not found' };
  }

  if (device.status !== 'online') {
    return { error: `Device is ${device.status}, cannot execute command` };
  }

  const command = await queueCommand(deviceId, type, payload, userId);

  if (device.agentId && !preferHeartbeat) {
    const sent = sendCommandToAgent(device.agentId, {
      id: command.id,
      type,
      payload
    });
    if (sent) {
      const executedAt = new Date();
      await db
        .update(deviceCommands)
        .set({ status: 'sent', executedAt })
        .where(eq(deviceCommands.id, command.id));

      return {
        command: {
          ...command,
          status: 'sent',
          executedAt
        } as QueuedCommand
      };
    }
  }

  return { command };
}

/**
 * Execute a command and wait for result (convenience wrapper).
 *
 * When called from routes protected by authMiddleware, the entire request
 * handler runs inside a long-lived PostgreSQL transaction (via
 * withDbAccessContext).  If the device_commands INSERT stays inside that
 * transaction it is invisible to the WebSocket handler that processes the
 * agent's response (separate transaction) — so the result is silently
 * dropped and waitForCommandResult times out after 30 s.
 *
 * Fix: fetch the device (needs RLS → runs in the auth transaction), then
 * break out of the DB context for the device_commands lifecycle.
 * device_commands has no org_id column so RLS does not apply.
 */
export async function executeCommand(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  options: {
    userId?: string;
    timeoutMs?: number;
    preferHeartbeat?: boolean;
  } = {}
): Promise<CommandResult> {
  const { timeoutMs = 30000, userId, preferHeartbeat = false } = options;

  // 1. Verify device inside the auth transaction (RLS-protected).
  const [device] = await db
    .select({
      id: devices.id,
      status: devices.status,
      agentId: devices.agentId,
      orgId: devices.orgId,
      hostname: devices.hostname,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return { status: 'failed', error: 'Device not found' };
  }

  if (device.status !== 'online') {
    return { status: 'failed', error: `Device is ${device.status}, cannot execute command` };
  }

  // 2. Queue, dispatch, and poll OUTSIDE the auth transaction so the
  //    INSERT commits immediately and is visible to the WS handler.
  return runOutsideDbContextSafe(async () => {
    // Validate userId for FK constraint: device_commands.created_by references users.id.
    // Helper sessions use a synthetic auth where auth.user.id is actually the device ID
    // (no real user record exists). Detect this by checking if userId equals deviceId.
    const safeUserId = userId && userId !== deviceId ? userId : null;

    // Insert command (device_commands — no RLS)
    const [command] = await db
      .insert(deviceCommands)
      .values({
        deviceId,
        type,
        payload,
        status: 'pending',
        createdBy: safeUserId,
      })
      .returning();

    if (!command) {
      return { status: 'failed' as const, error: 'Failed to create command' };
    }

    // Audit log for mutating commands (fire-and-forget).
    // Uses device info fetched in step 1 to avoid an RLS-gated query.
    if (AUDITED_COMMANDS.has(type)) {
      db.insert(auditLogs)
        .values({
          orgId: device.orgId,
          actorType: safeUserId ? 'user' : 'system',
          actorId: safeUserId || '00000000-0000-0000-0000-000000000000',
          action: `agent.command.${type}`,
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname,
          details: { commandId: command.id, type, payload },
          result: 'success',
        })
        .execute()
        .catch((err) => {
          console.error('Failed to write audit log', {
            commandId: command.id,
            deviceId,
            type,
            orgId: device.orgId,
            error: err,
          });
          captureException(err);
        });
    }

    // Dispatch via WebSocket
    if (device.agentId && !preferHeartbeat) {
      const sent = sendCommandToAgent(device.agentId, {
        id: command.id,
        type,
        payload,
      });
      if (sent) {
        await db
          .update(deviceCommands)
          .set({ status: 'sent', executedAt: new Date() })
          .where(eq(deviceCommands.id, command.id));
      }
    }

    // Poll for result
    const result = await waitForCommandResult(command.id, timeoutMs);

    return result.result ?? {
      status: 'failed' as const,
      error: 'Command did not complete',
    };
  });
}

/**
 * Get pending commands for a device (used by heartbeat endpoint)
 */
export async function getPendingCommands(
  deviceId: string,
  limit: number = 10
): Promise<QueuedCommand[]> {
  const commands = await db
    .select()
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.status, 'pending')
      )
    )
    .orderBy(deviceCommands.createdAt)
    .limit(limit);

  return commands as QueuedCommand[];
}

/**
 * Mark commands as sent (called after returning to agent)
 */
export async function markCommandsSent(commandIds: string[]): Promise<void> {
  if (commandIds.length === 0) return;

  for (const id of commandIds) {
    await db
      .update(deviceCommands)
      .set({
        status: 'sent',
        executedAt: new Date()
      })
      .where(eq(deviceCommands.id, id));
  }
}

/**
 * Submit command result (called by agent)
 */
export async function submitCommandResult(
  commandId: string,
  result: CommandResult
): Promise<void> {
  await db
    .update(deviceCommands)
    .set({
      status: result.status === 'completed' ? 'completed' : 'failed',
      completedAt: new Date(),
      result
    })
    .where(eq(deviceCommands.id, commandId));
}
