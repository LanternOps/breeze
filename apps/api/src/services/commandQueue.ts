import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands, devices } from '../db/schema';

// Command types for system tools
export const CommandTypes = {
  // Process management
  LIST_PROCESSES: 'list_processes',
  GET_PROCESS: 'get_process',
  KILL_PROCESS: 'kill_process',

  // Service management
  LIST_SERVICES: 'list_services',
  GET_SERVICE: 'get_service',
  START_SERVICE: 'start_service',
  STOP_SERVICE: 'stop_service',
  RESTART_SERVICE: 'restart_service',

  // Event logs (Windows)
  EVENT_LOGS_LIST: 'event_logs_list',
  EVENT_LOGS_QUERY: 'event_logs_query',
  EVENT_LOG_GET: 'event_log_get',

  // Scheduled tasks (Windows)
  TASKS_LIST: 'tasks_list',
  TASK_GET: 'task_get',
  TASK_RUN: 'task_run',
  TASK_ENABLE: 'task_enable',
  TASK_DISABLE: 'task_disable',

  // Registry (Windows)
  REGISTRY_KEYS: 'registry_keys',
  REGISTRY_VALUES: 'registry_values',
  REGISTRY_GET: 'registry_get',
  REGISTRY_SET: 'registry_set',
  REGISTRY_DELETE: 'registry_delete',
} as const;

export type CommandType = typeof CommandTypes[keyof typeof CommandTypes];

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
 * Execute a command and wait for result (convenience wrapper)
 */
export async function executeCommand(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  options: {
    userId?: string;
    timeoutMs?: number;
  } = {}
): Promise<CommandResult> {
  const { userId, timeoutMs = 30000 } = options;

  // Verify device exists and is online
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return {
      status: 'failed',
      error: 'Device not found'
    };
  }

  if (device.status !== 'online') {
    return {
      status: 'failed',
      error: `Device is ${device.status}, cannot execute command`
    };
  }

  // Queue the command
  const command = await queueCommand(deviceId, type, payload, userId);

  // Wait for result
  const result = await waitForCommandResult(command.id, timeoutMs);

  if (result.status === 'completed' && result.result) {
    return result.result;
  }

  if (result.status === 'failed' && result.result) {
    return result.result;
  }

  return {
    status: 'failed',
    error: 'Command did not complete'
  };
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
