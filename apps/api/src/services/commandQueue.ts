import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { deviceCommands, devices, auditLogs } from '../db/schema';
import { sendCommandToAgent } from '../routes/agentWs';

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
  TASK_HISTORY: 'task_history',

  // Registry (Windows)
  REGISTRY_KEYS: 'registry_keys',
  REGISTRY_VALUES: 'registry_values',
  REGISTRY_GET: 'registry_get',
  REGISTRY_SET: 'registry_set',
  REGISTRY_DELETE: 'registry_delete',
  REGISTRY_KEY_CREATE: 'registry_key_create',
  REGISTRY_KEY_DELETE: 'registry_key_delete',

  // File operations
  FILE_LIST: 'file_list',
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  FILE_DELETE: 'file_delete',
  FILE_MKDIR: 'file_mkdir',
  FILE_RENAME: 'file_rename',
  FILESYSTEM_ANALYSIS: 'filesystem_analysis',

  // Terminal
  TERMINAL_START: 'terminal_start',
  TERMINAL_DATA: 'terminal_data',
  TERMINAL_RESIZE: 'terminal_resize',
  TERMINAL_STOP: 'terminal_stop',

  // Script execution
  SCRIPT: 'script',

  // Patch management
  PATCH_SCAN: 'patch_scan',
  INSTALL_PATCHES: 'install_patches',
  ROLLBACK_PATCHES: 'rollback_patches',

  // Security
  SECURITY_COLLECT_STATUS: 'security_collect_status',
  SECURITY_SCAN: 'security_scan',
  SECURITY_THREAT_QUARANTINE: 'security_threat_quarantine',
  SECURITY_THREAT_REMOVE: 'security_threat_remove',
  SECURITY_THREAT_RESTORE: 'security_threat_restore',

  // Log shipping
  SET_LOG_LEVEL: 'set_log_level',

  // Screenshot (AI Vision)
  TAKE_SCREENSHOT: 'take_screenshot',

  // Computer control (AI Computer Use)
  COMPUTER_ACTION: 'computer_action',
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

export interface QueueCommandForExecutionResult {
  command?: QueuedCommand;
  error?: string;
}

// Commands that modify system state or access sensitive data (e.g., screen capture) and should always be audit-logged
const AUDITED_COMMANDS: Set<string> = new Set([
  CommandTypes.KILL_PROCESS,
  CommandTypes.START_SERVICE,
  CommandTypes.STOP_SERVICE,
  CommandTypes.RESTART_SERVICE,
  CommandTypes.TASK_RUN,
  CommandTypes.TASK_ENABLE,
  CommandTypes.TASK_DISABLE,
  CommandTypes.REGISTRY_SET,
  CommandTypes.REGISTRY_DELETE,
  CommandTypes.REGISTRY_KEY_CREATE,
  CommandTypes.REGISTRY_KEY_DELETE,
  CommandTypes.FILE_WRITE,
  CommandTypes.FILE_DELETE,
  CommandTypes.FILE_MKDIR,
  CommandTypes.FILE_RENAME,
  CommandTypes.TERMINAL_START,
  CommandTypes.SCRIPT,
  CommandTypes.PATCH_SCAN,
  CommandTypes.INSTALL_PATCHES,
  CommandTypes.ROLLBACK_PATCHES,
  CommandTypes.SECURITY_SCAN,
  CommandTypes.SECURITY_THREAT_QUARANTINE,
  CommandTypes.SECURITY_THREAT_REMOVE,
  CommandTypes.SECURITY_THREAT_RESTORE,
  CommandTypes.TAKE_SCREENSHOT,
  CommandTypes.COMPUTER_ACTION,
]);

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
        .catch((err) => console.error('Failed to write audit log:', err));
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
 * Execute a command and wait for result (convenience wrapper)
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
  const { timeoutMs = 30000, ...queueOptions } = options;
  const queueResult = await queueCommandForExecution(deviceId, type, payload, queueOptions);

  if (!queueResult.command) {
    return {
      status: 'failed',
      error: queueResult.error || 'Failed to queue command'
    };
  }

  // Wait for result
  const result = await waitForCommandResult(queueResult.command.id, timeoutMs);

  return result.result ?? {
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
