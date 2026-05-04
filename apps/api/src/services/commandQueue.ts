import { eq, and, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { deviceCommands, devices, auditLogs } from '../db/schema';
import { sendCommandToAgent, isAgentConnected } from '../routes/agentWs';
import { captureException } from './sentry';
import { recordBackupCommandTimeout, recordRestoreTimeout } from './backupMetrics';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from './commandDispatch';
import { commandAuditDetails } from './commandAudit';

// Sentinel error string for the WS-pre-check fast-fail path. The fileBrowser
// route (and any other interactive caller) matches on this substring to map
// the failure to a "transiently unreachable" UI message distinct from offline.
export const DEVICE_UNREACHABLE_ERROR =
  'Device is not currently reachable over the live connection. Please try again in a moment.';

// Number of times we attempt sendCommandToAgent before releasing the claim
// and short-circuiting with DEVICE_UNREACHABLE_ERROR. With a 500 ms gap this
// gives a transient WS hiccup ~1s of grace before the user sees a failure.
// Exported so tests can derive the expected call count.
export const SEND_RETRY_ATTEMPTS = 3;
export const SEND_RETRY_DELAY_MS = 500;

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
  FILE_COPY: 'file_copy',
  FILE_TRASH_LIST: 'file_trash_list',
  FILE_TRASH_RESTORE: 'file_trash_restore',
  FILE_TRASH_PURGE: 'file_trash_purge',
  FILE_LIST_DRIVES: 'file_list_drives',

  // Terminal
  TERMINAL_START: 'terminal_start',
  TERMINAL_DATA: 'terminal_data',
  TERMINAL_RESIZE: 'terminal_resize',
  TERMINAL_STOP: 'terminal_stop',

  // Script execution
  SCRIPT: 'script',

  // Software management
  SOFTWARE_UNINSTALL: 'software_uninstall',
  CIS_BENCHMARK: 'cis_benchmark',
  APPLY_CIS_REMEDIATION: 'apply_cis_remediation',

  // Patch management
  PATCH_SCAN: 'patch_scan',
  INSTALL_PATCHES: 'install_patches',
  ROLLBACK_PATCHES: 'rollback_patches',
  COLLECT_RELIABILITY_METRICS: 'collect_reliability_metrics',

  // Security
  SECURITY_COLLECT_STATUS: 'security_collect_status',
  SECURITY_SCAN: 'security_scan',
  SECURITY_THREAT_QUARANTINE: 'security_threat_quarantine',
  SECURITY_THREAT_REMOVE: 'security_threat_remove',
  SECURITY_THREAT_RESTORE: 'security_threat_restore',
  SENSITIVE_DATA_SCAN: 'sensitive_data_scan',
  ENCRYPT_FILE: 'encrypt_file',
  SECURE_DELETE_FILE: 'secure_delete_file',
  QUARANTINE_FILE: 'quarantine_file',

  // Peripheral control — pushes full active policy set to agent
  PERIPHERAL_POLICY_SYNC: 'peripheral_policy_sync',

  // Log shipping
  SET_LOG_LEVEL: 'set_log_level',

  // Screenshot (AI Vision)
  TAKE_SCREENSHOT: 'take_screenshot',

  // Computer control (AI Computer Use)
  COMPUTER_ACTION: 'computer_action',

  // Boot performance
  COLLECT_BOOT_PERFORMANCE: 'collect_boot_performance',
  MANAGE_STARTUP_ITEM: 'manage_startup_item',

  // Audit policy compliance
  COLLECT_AUDIT_POLICY: 'collect_audit_policy',
  APPLY_AUDIT_POLICY_BASELINE: 'apply_audit_policy_baseline',

  // Safe mode reboot (Windows only)
  REBOOT_SAFE_MODE: 'reboot_safe_mode',
  // Self-uninstall (remote wipe)
  SELF_UNINSTALL: 'self_uninstall',
  // Backup
  BACKUP_RUN: 'backup_run',
  BACKUP_STOP: 'backup_stop',
  BACKUP_RESTORE: 'backup_restore',
  BACKUP_VERIFY: 'backup_verify',
  BACKUP_TEST_RESTORE: 'backup_test_restore',
  BACKUP_CLEANUP: 'backup_cleanup',
  // VSS
  VSS_STATUS: 'vss_status',
  VSS_WRITER_LIST: 'vss_writer_list',
  // MSSQL
  MSSQL_DISCOVER: 'mssql_discover',
  MSSQL_BACKUP: 'mssql_backup',
  MSSQL_RESTORE: 'mssql_restore',
  MSSQL_VERIFY: 'mssql_verify',
  // Hyper-V
  HYPERV_DISCOVER: 'hyperv_discover',
  HYPERV_BACKUP: 'hyperv_backup',
  HYPERV_RESTORE: 'hyperv_restore',
  HYPERV_CHECKPOINT: 'hyperv_checkpoint',
  HYPERV_VM_STATE: 'hyperv_vm_state',
  // System state & BMR
  SYSTEM_STATE_COLLECT: 'system_state_collect',
  HARDWARE_PROFILE: 'hardware_profile',
  VM_RESTORE_FROM_BACKUP: 'vm_restore_from_backup',
  VM_RESTORE_ESTIMATE: 'vm_restore_estimate',
  VM_INSTANT_BOOT: 'vm_instant_boot',
  BMR_RECOVER: 'bmr_recover',
  // Vault
  VAULT_SYNC: 'vault_sync',
  VAULT_STATUS: 'vault_status',
  VAULT_CONFIGURE: 'vault_configure',
  // Incident response
  COLLECT_EVIDENCE: 'collect_evidence',
  EXECUTE_CONTAINMENT: 'execute_containment',
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

// Backup-related command types — used to guard backup-specific Prometheus metrics
const BACKUP_COMMAND_TYPES = new Set([
  'backup_run', 'backup_stop', 'backup_restore', 'backup_verify',
  'backup_test_restore', 'backup_cleanup', 'vm_restore_from_backup',
  'vm_instant_boot', 'bmr_recover', 'mssql_backup', 'mssql_restore',
  'hyperv_backup', 'hyperv_restore',
]);

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
  CommandTypes.FILE_COPY,
  CommandTypes.FILE_TRASH_RESTORE,
  CommandTypes.FILE_TRASH_PURGE,
  CommandTypes.TERMINAL_START,
  CommandTypes.SCRIPT,
  CommandTypes.PATCH_SCAN,
  CommandTypes.INSTALL_PATCHES,
  CommandTypes.ROLLBACK_PATCHES,
  CommandTypes.SOFTWARE_UNINSTALL,
  CommandTypes.CIS_BENCHMARK,
  CommandTypes.APPLY_CIS_REMEDIATION,
  CommandTypes.SECURITY_SCAN,
  CommandTypes.SECURITY_THREAT_QUARANTINE,
  CommandTypes.SECURITY_THREAT_REMOVE,
  CommandTypes.SECURITY_THREAT_RESTORE,
  CommandTypes.SENSITIVE_DATA_SCAN,
  CommandTypes.ENCRYPT_FILE,
  CommandTypes.SECURE_DELETE_FILE,
  CommandTypes.QUARANTINE_FILE,
  CommandTypes.TAKE_SCREENSHOT,
  CommandTypes.COMPUTER_ACTION,
  CommandTypes.MANAGE_STARTUP_ITEM,
  CommandTypes.APPLY_AUDIT_POLICY_BASELINE,
  // Peripheral control — pushes full active policy set to agent
  CommandTypes.PERIPHERAL_POLICY_SYNC,
  // Safe mode reboot
  CommandTypes.REBOOT_SAFE_MODE,
  // Self-uninstall (remote wipe)
  CommandTypes.SELF_UNINSTALL,
  CommandTypes.BACKUP_RUN,
  CommandTypes.BACKUP_STOP,
  CommandTypes.BACKUP_RESTORE,
  CommandTypes.BACKUP_VERIFY,
  CommandTypes.BACKUP_TEST_RESTORE,
  // VSS
  CommandTypes.VSS_WRITER_LIST,
  // MSSQL
  CommandTypes.MSSQL_BACKUP,
  CommandTypes.MSSQL_RESTORE,
  CommandTypes.MSSQL_VERIFY,
  // Hyper-V
  CommandTypes.HYPERV_BACKUP,
  CommandTypes.HYPERV_RESTORE,
  CommandTypes.HYPERV_CHECKPOINT,
  CommandTypes.HYPERV_VM_STATE,
  // BMR
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
  CommandTypes.BMR_RECOVER,
  // Vault
  CommandTypes.VAULT_SYNC,
  CommandTypes.VAULT_CONFIGURE,
  // Incident response
  CommandTypes.COLLECT_EVIDENCE,
  CommandTypes.EXECUTE_CONTAINMENT,
]);

// User-interactive command types — the UI is actively waiting on the result
// and a 15–30 s silent timeout is a bad experience. For these, executeCommand
// pre-checks the WS pool and short-circuits with DEVICE_UNREACHABLE_ERROR if
// no live connection exists, instead of queueing and waiting for the timeout.
const INTERACTIVE_COMMAND_TYPES: Set<string> = new Set([
  CommandTypes.FILE_LIST,
  CommandTypes.FILE_LIST_DRIVES,
  CommandTypes.FILE_READ,
  CommandTypes.FILE_WRITE,
  CommandTypes.FILE_DELETE,
  CommandTypes.FILE_MKDIR,
  CommandTypes.FILE_RENAME,
  CommandTypes.FILE_COPY,
  CommandTypes.FILE_TRASH_LIST,
  CommandTypes.FILE_TRASH_RESTORE,
  CommandTypes.FILE_TRASH_PURGE,
  CommandTypes.TERMINAL_START,
  CommandTypes.TERMINAL_DATA,
  CommandTypes.TERMINAL_RESIZE,
  CommandTypes.TERMINAL_STOP,
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

  // Audit log for mutating commands — fire-and-forget under a system-scope
  // connection outside any caller tx, matching `services/auditService.ts`.
  // Both the `devices` lookup and the `audit_logs` insert must run under
  // system scope: BullMQ workers (e.g. `jobs/softwareRemediationWorker.ts`,
  // `jobs/cisJobs.ts`, `jobs/peripheralJobs.ts`) call `queueCommand` with no
  // request DB context, so an org-scoped `devices` SELECT would be rejected
  // by RLS and the audit block would silently no-op before ever reaching
  // the insert. `runOutsideDbContext` escapes any caller tx so a failed
  // audit can't poison the caller's transaction.
  if (command && AUDITED_COMMANDS.has(type)) {
    const commandId = command.id;
    runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [device] = await db
          .select({ orgId: devices.orgId, hostname: devices.hostname })
          .from(devices)
          .where(eq(devices.id, deviceId))
          .limit(1);

        if (!device) {
          return;
        }

        await db.insert(auditLogs).values({
          orgId: device.orgId,
          actorType: userId ? 'user' : 'system',
          actorId: userId || '00000000-0000-0000-0000-000000000000',
          action: `agent.command.${type}`,
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname,
          details: commandAuditDetails(commandId, type, payload),
          result: 'success',
        });
      })
    ).catch((err) => {
      console.error('Failed to write audit log', {
        commandId,
        deviceId,
        type,
        error: err,
      });
      captureException(err);
    });
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
  let lastObservedCommand: QueuedCommand | null = null;

  while (Date.now() - startTime < timeoutMs) {
    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId))
      .limit(1);

    if (!command) {
      throw new Error(`Command ${commandId} not found`);
    }

    lastObservedCommand = command as QueuedCommand;

    // Check if command is complete
    if (command.status === 'completed' || command.status === 'failed') {
      return command as QueuedCommand;
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout - update command status
  const completedAt = new Date();
  const [timedOutUpdate] = await db
    .update(deviceCommands)
    .set({
      status: 'failed',
      completedAt,
      result: {
        status: 'timeout',
        error: `Command timed out after ${timeoutMs}ms`
      }
    })
    .where(and(
      eq(deviceCommands.id, commandId),
      inArray(deviceCommands.status, ['pending', 'sent']),
    ))
    .returning({
      id: deviceCommands.id,
      status: deviceCommands.status,
    });

  const timedOutType = lastObservedCommand?.type;
  if (timedOutUpdate && timedOutType) {
    if (BACKUP_COMMAND_TYPES.has(timedOutType)) {
      recordBackupCommandTimeout(timedOutType, 'sync_wait');
    }
    if (
      timedOutType === CommandTypes.BACKUP_RESTORE
      || timedOutType === CommandTypes.VM_RESTORE_FROM_BACKUP
      || timedOutType === CommandTypes.VM_INSTANT_BOOT
      || timedOutType === CommandTypes.BMR_RECOVER
    ) {
      recordRestoreTimeout(timedOutType);
    }
  }

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
    const claimed = await claimPendingCommandForDelivery(command.id);
    if (claimed) {
      const sent = sendCommandToAgent(device.agentId, {
        id: command.id,
        type,
        payload
      });
      if (sent) {
        return {
          command: {
            ...command,
            status: 'sent',
            executedAt: claimed.executedAt
          } as QueuedCommand
        };
      }
      await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
    }
  }

  return { command };
}

export async function queueBackupStopCommand(
  deviceId: string,
  options: {
    userId?: string;
  } = {}
): Promise<QueueCommandForExecutionResult> {
  return runOutsideDbContextSafe(() =>
    withSystemDbAccessContext(async () => {
      const result = await queueCommandForExecution(
        deviceId,
        CommandTypes.BACKUP_STOP,
        { reason: 'cancelled' },
        options
      );

      if (result.error) {
        return result;
      }

      if (result.command?.status !== 'sent' && result.command?.id) {
        await db
          .delete(deviceCommands)
          .where(
            and(
              eq(deviceCommands.id, result.command.id),
              eq(deviceCommands.status, 'pending')
            )
          );
        return {
          error: 'Backup stop could not be dispatched immediately',
        };
      }

      return result;
    })
  );
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
    /**
     * Which polling consumer on the device picks up this command.
     * - 'agent' (default): the long-lived Go agent. Has a WS connection, so
     *   executeCommand dispatches over WS for low latency.
     * - 'watchdog': the separate breeze-watchdog process. Has NO WebSocket —
     *   it polls via heartbeat (`claimPendingCommandsForDevice(..., 'watchdog')`
     *   in routes/agents/heartbeat.ts). When targetRole is 'watchdog' we
     *   MUST skip the WS dispatch path entirely and just write the row;
     *   otherwise the command is sent to the agent WS (wrong consumer) and
     *   the row's default target_role='agent' hides it from the heartbeat
     *   claim query, leaving it pending forever.
     *
     * NOTE: because the watchdog polls every heartbeat (~5–10s per device,
     * sometimes slower), callers targeting the watchdog should pass a larger
     * timeoutMs than they would for an agent command.
     */
    targetRole?: 'agent' | 'watchdog';
  } = {}
): Promise<CommandResult> {
  const {
    timeoutMs = 30000,
    userId,
    preferHeartbeat = false,
    targetRole = 'agent',
  } = options;
  // Watchdog-targeted commands have no WS consumer; the WS pre-check /
  // dispatch path below must be skipped entirely for them. The heartbeat
  // poll path in routes/agents/heartbeat.ts picks them up.
  const dispatchViaWs = targetRole === 'agent' && !preferHeartbeat;

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

  // Fast-fail interactive commands when the WS is known-dead. The user is
  // actively waiting in the UI; queueing and burning the full timeout when
  // we already know the connection is gone wastes ~15–30 s and surfaces a
  // misleading error. Non-interactive callers (and the heartbeat fallback)
  // can still queue normally.
  if (
    device.agentId &&
    dispatchViaWs &&
    INTERACTIVE_COMMAND_TYPES.has(type) &&
    !isAgentConnected(device.agentId)
  ) {
    // Log so ops can correlate spikes of unreachable-fast-fails with WS pool
    // health. This is the single most useful signal for diagnosing recurrences
    // of issue #391 — without it the failure is invisible until users complain.
    console.warn('[commandQueue] interactive command fast-fail (WS not connected)', {
      deviceId,
      agentId: device.agentId,
      type,
    });
    return { status: 'failed' as const, error: DEVICE_UNREACHABLE_ERROR };
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
        targetRole,
      })
      .returning();

    if (!command) {
      return { status: 'failed' as const, error: 'Failed to create command' };
    }

    // Audit log for mutating commands (fire-and-forget).
    // Uses device info fetched in step 1 to avoid an RLS-gated query.
    if (AUDITED_COMMANDS.has(type)) {
      withDbAccessContext(
        { scope: 'organization', orgId: device.orgId, accessibleOrgIds: [device.orgId] },
        () =>
          db
            .insert(auditLogs)
            .values({
              orgId: device.orgId,
              actorType: safeUserId ? 'user' : 'system',
              actorId: safeUserId || '00000000-0000-0000-0000-000000000000',
              action: `agent.command.${type}`,
              resourceType: 'device',
              resourceId: deviceId,
              resourceName: device.hostname,
              details: commandAuditDetails(command.id, type, payload),
              result: 'success',
            })
            .execute()
      )
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

    // Dispatch via WebSocket. Retry briefly on send failure: a transient WS
    // hiccup (e.g. mid-reconnect) can fail a single send even when the
    // connection comes back ~hundreds of ms later. Retrying gives the pool a
    // chance to recover before we fall through to the multi-second timeout.
    // Watchdog-targeted commands skip this entirely — the watchdog has no WS
    // and is picked up by the heartbeat claim query in heartbeat.ts.
    if (device.agentId && dispatchViaWs) {
      const claimed = await claimPendingCommandForDelivery(command.id);
      if (claimed) {
        let sent = false;
        for (let attempt = 0; attempt < SEND_RETRY_ATTEMPTS; attempt++) {
          sent = sendCommandToAgent(device.agentId, {
            id: command.id,
            type,
            payload,
          });
          if (sent) {
            if (attempt > 0) {
              console.warn('[commandQueue] sendCommandToAgent recovered after retry', {
                commandId: command.id,
                deviceId,
                agentId: device.agentId,
                type,
                attempt: attempt + 1,
              });
            }
            break;
          }
          console.warn('[commandQueue] sendCommandToAgent failed, will retry', {
            commandId: command.id,
            deviceId,
            agentId: device.agentId,
            type,
            attempt: attempt + 1,
            maxAttempts: SEND_RETRY_ATTEMPTS,
          });
          if (attempt < SEND_RETRY_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS));
          }
        }
        if (!sent) {
          await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
          console.warn('[commandQueue] sendCommandToAgent exhausted retries', {
            commandId: command.id,
            deviceId,
            agentId: device.agentId,
            type,
            attempts: SEND_RETRY_ATTEMPTS,
          });
          // All retries exhausted with no successful send. For interactive
          // commands the user is staring at a spinner — short-circuit with
          // the unreachable error rather than burning the full poll timeout.
          // For non-interactive commands, fall through to polling: the agent
          // may still pick the command up via the heartbeat path before the
          // timeout fires, in which case the user gets a real result.
          if (INTERACTIVE_COMMAND_TYPES.has(type)) {
            return { status: 'failed' as const, error: DEVICE_UNREACHABLE_ERROR };
          }
        }
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
      .where(and(
        eq(deviceCommands.id, id),
        eq(deviceCommands.status, 'pending'),
      ));
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
    .where(and(
      eq(deviceCommands.id, commandId),
      eq(deviceCommands.status, 'sent'),
    ));
}
