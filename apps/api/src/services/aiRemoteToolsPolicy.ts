/**
 * The per-device remote-tools policy, enforced on the AI dispatch path.
 *
 * The REST `/system-tools` routes refuse a device whose effective
 * `remote_access` configuration policy sets `remoteTools: false`
 * (`routes/systemTools/index.ts`, `checkRemoteAccess(deviceId, 'remoteTools')`).
 * AI tools (chat, AI agents, MCP) reach the same agent command families
 * through `services/aiDispatch.ts`, which did not check the policy, so a
 * device an operator had locked down could still be driven by an AI surface.
 *
 * This module is the single definition of which command types that policy
 * covers and the single check every AI dispatch entry point runs before it
 * reaches the device. It is deliberately central rather than per-tool: a new
 * tool cannot forget it, and `aiRemoteToolsPolicy.contract.test.ts` fails if
 * a `/system-tools` route dispatches a type missing from the set, or if an
 * `aiDispatch` entry point stops calling the check.
 *
 * Fail-closed: a policy lookup that throws is a refusal, never a pass
 * (`checkRemoteAccess` already denies on a resolution error; this also denies
 * if the call itself rejects).
 */
import { CommandTypes } from './commandTypes';
import { checkRemoteAccess } from './remoteAccessPolicy';
import { getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';

export const REMOTE_TOOLS_DISABLED_BY_POLICY = 'REMOTE_TOOLS_DISABLED_BY_POLICY' as const;

/**
 * Every command type the `/system-tools` routes dispatch (all of them sit
 * behind the route-level remote-tools policy middleware), plus the members of
 * the same families that are dispatched from outside those routes:
 *   - `file_mkdir` (file family; AI `file_operations`);
 *   - `manage_startup_item` (the startup-item family; AI `manage_startup_items`);
 *   - `terminal_start` (the terminal WS already gates it on `remoteTools`);
 *   - the disk-cleanup family: `filesystem_analysis` (a whole-volume file
 *     enumeration), `system_cleanup_list` / `system_cleanup_run`. Their REST
 *     routes (`routes/devices/filesystem*.ts`) and the startup-item routes
 *     (`routes/devices/bootMetrics.ts`) enforce the same policy through
 *     `checkDeviceRemoteToolsPolicy` below.
 *
 * Kept as literal values (not a spread of `CommandTypes`) so the contract
 * test can compare it against the route files and a rename cannot silently
 * shrink it.
 */
export const REMOTE_TOOLS_COMMAND_TYPES: ReadonlySet<string> = new Set<string>([
  // Processes (routes/systemTools/processes.ts)
  CommandTypes.LIST_PROCESSES,
  CommandTypes.GET_PROCESS,
  CommandTypes.KILL_PROCESS,
  // Services (routes/systemTools/services.ts)
  CommandTypes.LIST_SERVICES,
  CommandTypes.GET_SERVICE,
  CommandTypes.START_SERVICE,
  CommandTypes.STOP_SERVICE,
  CommandTypes.RESTART_SERVICE,
  // Event logs (routes/systemTools/eventLogs.ts)
  CommandTypes.EVENT_LOGS_LIST,
  CommandTypes.EVENT_LOGS_QUERY,
  CommandTypes.EVENT_LOG_GET,
  // Scheduled tasks (routes/systemTools/scheduledTasks.ts)
  CommandTypes.TASKS_LIST,
  CommandTypes.TASK_GET,
  CommandTypes.TASK_RUN,
  CommandTypes.TASK_ENABLE,
  CommandTypes.TASK_DISABLE,
  CommandTypes.TASK_HISTORY,
  // Registry (routes/systemTools/registry.ts)
  CommandTypes.REGISTRY_KEYS,
  CommandTypes.REGISTRY_VALUES,
  CommandTypes.REGISTRY_GET,
  CommandTypes.REGISTRY_SET,
  CommandTypes.REGISTRY_DELETE,
  CommandTypes.REGISTRY_KEY_CREATE,
  CommandTypes.REGISTRY_KEY_DELETE,
  // Files (routes/systemTools/fileBrowser.ts), plus file_mkdir
  CommandTypes.FILE_LIST,
  CommandTypes.FILE_LIST_DRIVES,
  CommandTypes.FILE_READ,
  CommandTypes.DIAG_FILE_LIST,
  CommandTypes.DIAG_FILE_READ,
  CommandTypes.FILE_WRITE,
  CommandTypes.FILE_DELETE,
  CommandTypes.FILE_MKDIR,
  CommandTypes.FILE_RENAME,
  CommandTypes.FILE_COPY,
  CommandTypes.FILE_TRASH_LIST,
  CommandTypes.FILE_TRASH_RESTORE,
  CommandTypes.FILE_TRASH_PURGE,
  // Startup items (same "remote tools" class; no /system-tools route)
  CommandTypes.MANAGE_STARTUP_ITEM,
  // Terminal (terminalWs.ts gates it on remoteTools)
  CommandTypes.TERMINAL_START,
  // Disk cleanup (routes/devices/filesystem.ts, filesystemSystemCleanup.ts)
  CommandTypes.FILESYSTEM_ANALYSIS,
  CommandTypes.SYSTEM_CLEANUP_LIST,
  CommandTypes.SYSTEM_CLEANUP_RUN,
]);

/** Case-insensitive, whitespace-trimmed: a casing variant must not slip past. */
export function isRemoteToolsCommandType(type: string): boolean {
  return typeof type === 'string' && REMOTE_TOOLS_COMMAND_TYPES.has(type.trim().toLowerCase());
}

export class RemoteToolsDisabledByPolicyError extends Error {
  readonly code = REMOTE_TOOLS_DISABLED_BY_POLICY;
  constructor(readonly deviceId: string, readonly commandType: string, reason: string) {
    super(`${REMOTE_TOOLS_DISABLED_BY_POLICY}: ${reason}`);
    this.name = 'RemoteToolsDisabledByPolicyError';
  }
}

export type AiRemoteToolsDecision =
  | { allowed: true }
  | { allowed: false; error: string; reason: string };

async function lookup(deviceId: string) {
  // Join an ambient context (request / agent run) rather than opening a
  // second pooled connection under it. With NO ambient context (the
  // context-free `WithSystemPrecheck` lane) the resolver needs a scope to see
  // the device's policy at all, so open a short system one, matching how
  // `executeCommandWithSystemPrecheck` runs its own precheck.
  if (getCurrentDbAccessContext()) {
    return checkRemoteAccess(deviceId, 'remoteTools');
  }
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () => checkRemoteAccess(deviceId, 'remoteTools'),
      'aiRemoteToolsPolicy.check',
    ));
}

export type RemoteToolsPolicyDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * The per-device remote-tools policy, for callers that already know the
 * operation is a remote-tools one (REST routes that dispatch these command
 * types). Fail-closed, and safe with or without an ambient DB context -- which
 * matters for the self-managed-context routes (cleanup-execute,
 * system-cleanup/*), where a bare `checkRemoteAccess` would run unscoped, see
 * no policy and fall back to the permissive default.
 *
 * Callers resolve the device through their tenant/site check FIRST, so the
 * answer never reveals whether another tenant's device exists.
 */
export async function checkDeviceRemoteToolsPolicy(deviceId: string): Promise<RemoteToolsPolicyDecision> {
  try {
    const result = await lookup(deviceId);
    if (result.allowed === true) return { allowed: true };
    return { allowed: false, reason: result.reason ?? 'Remote tools are disabled by configuration policy' };
  } catch (err) {
    console.error(
      `[aiRemoteToolsPolicy] policy lookup failed for device ${deviceId}; refusing:`,
      err instanceof Error ? err.message : err,
    );
    return { allowed: false, reason: 'Unable to verify the remote tools policy for this device' };
  }
}

/**
 * Decide whether an AI surface may dispatch `type` to `deviceId`. Types
 * outside `REMOTE_TOOLS_COMMAND_TYPES` are allowed without a lookup.
 */
export async function checkAiRemoteToolsPolicy(
  deviceId: string,
  type: string,
): Promise<AiRemoteToolsDecision> {
  if (!isRemoteToolsCommandType(type)) return { allowed: true };
  const decision = await checkDeviceRemoteToolsPolicy(deviceId);
  if (decision.allowed) return { allowed: true };
  return { allowed: false, reason: decision.reason, error: `${REMOTE_TOOLS_DISABLED_BY_POLICY}: ${decision.reason}` };
}

/** Throwing form, for entry points with no refusal channel in their result. */
export async function assertAiRemoteToolsAllowed(deviceId: string, type: string): Promise<void> {
  const decision = await checkAiRemoteToolsPolicy(deviceId, type);
  if (!decision.allowed) throw new RemoteToolsDisabledByPolicyError(deviceId, type, decision.reason);
}
