/**
 * The ONLY door AI code may use to reach a device (#5022 W01, spec OD-1).
 *
 * `AuthContext.aiOrigin` is the in-process carrier, but no insert chokepoint
 * receives an AuthContext -- `queueCommand` takes a userId plus an options bag,
 * `insertQueuedCommandInTransaction` takes a small input object,
 * `dispatchPreparedCommand` takes ExecuteCommandOptions -- and the AI handlers
 * already reduce auth to `auth.user.id` before calling them. So the origin has
 * to be passed explicitly.
 *
 * Every function here takes `auth` and `toolName` as REQUIRED positional
 * arguments and throws when the origin is absent, which converts "remember to
 * pass it" into a runtime failure plus (with `aiDispatch.contract.test.ts`) a
 * source scan -- the only control this repo has a good record with. Code review
 * has caught registration-shaped omissions 0/5 times here; contract tests have
 * caught them 5/5.
 */
import {
  executeCommand,
  executeCommandWithSystemPrecheck,
  queueCommand,
  queueCommandForExecution,
  insertQueuedCommandInTransaction,
  type ExecuteCommandOptions,
  type CommandPayload,
  type CommandType,
  type CommandResult,
  type QueuedCommand,
  type QueueCommandForExecutionResult,
} from './commandQueue';
import {
  dispatchDeviceCommand,
  type DispatchDeviceCommandInput,
  type DispatchDeviceCommandResult,
} from './dispatchDeviceCommand';
import {
  dispatchScriptToDevice,
  type DispatchScriptInput,
  type DispatchScriptResult,
} from './scriptDispatch';
import type { AiOriginRef } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';

/** The only part of an AuthContext this module reads. */
type AiAuth = Pick<AuthContext, 'aiOrigin'>;

/** Transaction handle accepted by `insertQueuedCommandInTransaction`. */
type CommandQueueTx = Parameters<typeof insertQueuedCommandInTransaction>[0];
type QueuedCommandInput = Parameters<typeof insertQueuedCommandInTransaction>[1];

export class MissingAiOriginError extends Error {
  constructor(toolName: string) {
    super(
      `[aiDispatch] tool "${toolName}" reached the device with no AuthContext.aiOrigin. `
        + 'Every AI surface must mint one (agentAuthContext / streamingSessionManager / '
        + 'mcpToolExecutionLedger). Dispatching unattributed device work is refused.',
    );
    this.name = 'MissingAiOriginError';
  }
}

export function requireAiOrigin(auth: AiAuth, toolName: string): AiOriginRef {
  if (!auth.aiOrigin) throw new MissingAiOriginError(toolName);
  return auth.aiOrigin;
}

export async function aiExecuteCommand(
  auth: AiAuth,
  toolName: string,
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  options: Omit<ExecuteCommandOptions, 'aiOrigin'> = {},
): Promise<CommandResult> {
  const aiOrigin = requireAiOrigin(auth, toolName);
  return executeCommand(deviceId, type, payload, { ...options, aiOrigin });
}

/** Context-free dispatch with a short, tenant-bound device precheck. */
export async function aiExecuteCommandWithSystemPrecheck(
  auth: AiAuth,
  toolName: string,
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload,
  options: Omit<Parameters<typeof executeCommandWithSystemPrecheck>[3], 'aiOrigin'>,
): Promise<CommandResult> {
  return executeCommandWithSystemPrecheck(deviceId, type, payload, {
    ...options, aiOrigin: requireAiOrigin(auth, toolName),
  });
}

export async function aiQueueCommandForExecution(
  auth: AiAuth,
  toolName: string,
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  options: Omit<Parameters<typeof queueCommandForExecution>[3] & object, 'aiOrigin'> = {},
): Promise<QueueCommandForExecutionResult> {
  const aiOrigin = requireAiOrigin(auth, toolName);
  return queueCommandForExecution(deviceId, type, payload, { ...options, aiOrigin });
}

/**
 * The bare `queueCommand` lane. Distinct from `aiQueueCommandForExecution`,
 * which additionally resolves the offline policy and attempts a live push;
 * callers that only want the row written (a fan-out over many findings, where
 * per-device delivery is the reaper's problem) use this one.
 */
export async function aiQueueCommand(
  auth: AiAuth,
  toolName: string,
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  userId?: string,
  options: Omit<Parameters<typeof queueCommand>[4] & object, 'aiOrigin'> = {},
): Promise<QueuedCommand> {
  const aiOrigin = requireAiOrigin(auth, toolName);
  return queueCommand(deviceId, type, payload, userId, { ...options, aiOrigin });
}

export async function aiDispatchDeviceCommand(
  auth: AiAuth,
  toolName: string,
  input: Omit<DispatchDeviceCommandInput, 'aiOrigin'>,
): Promise<DispatchDeviceCommandResult> {
  const aiOrigin = requireAiOrigin(auth, toolName);
  return dispatchDeviceCommand({ ...input, aiOrigin });
}

export async function aiDispatchScriptToDevice(
  auth: AiAuth & Partial<Pick<AuthContext, 'user'>>,
  toolName: string,
  input: Omit<DispatchScriptInput, 'aiOrigin' | 'principalActorId'>,
): Promise<DispatchScriptResult> {
  const aiOrigin = requireAiOrigin(auth, toolName);
  // #5022 W01: `ai.script.executed` takes its actor from the authenticated
  // PRINCIPAL. For an autonomous run that principal is the agent, whose id is
  // an `ai_agents.id` -- legal in `audit_logs.actor_id` (no FK to `users`),
  // unlike `device_commands.created_by`. Supplied here rather than at every
  // call site so a caller cannot get the pairing wrong.
  const principalActorId = aiOrigin.kind === 'ai_agent' ? (auth.user?.id ?? null) : null;
  return dispatchScriptToDevice({ ...input, aiOrigin, principalActorId });
}

/**
 * Transaction-scoped variant. Takes the origin POSITIONALLY rather than an
 * AuthContext: the callers on this lane (peripheral policy reconciliation) run
 * under a caller-owned transaction and thread an optional origin down from a
 * job or a tool, not a live request context.
 */
export async function aiInsertQueuedCommandInTransaction(
  origin: AiOriginRef,
  tx: CommandQueueTx,
  input: Omit<QueuedCommandInput, 'aiOrigin'>,
): Promise<QueuedCommand> {
  return insertQueuedCommandInTransaction(tx, { ...input, aiOrigin: origin });
}
