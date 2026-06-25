/**
 * Promise-correlated agent command await helper.
 *
 * Sends a command to a connected agent and awaits its result over the
 * WebSocket command-result channel, correlating by command id. The caller
 * gets back a typed Promise instead of having to wire up a callback manually.
 *
 * Usage:
 *   const result = await sendCommandToAgentAwaitResult(agentId, command, 30_000);
 *
 * The companion `resolvePendingAgentCommand` is called from the agentWs
 * processCommandResult dispatcher whenever a command_result message arrives,
 * so any in-flight awaited command resolves automatically.
 */

import { sendCommandToAgent } from '../routes/agentWs';

export type AgentCommandAwaitResult = {
  status: string;
  result?: unknown;
  // Agents put structured command output as a JSON string in `stdout`
  // (Go CommandResult.Stdout via NewSuccessResult) — e.g. http_request returns
  // {status,headers,bodyB64,truncated}. Forwarded so awaited callers can read it.
  stdout?: string;
  error?: string;
};

type PendingEntry = {
  resolve: (value: AgentCommandAwaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingEntry>();

/**
 * Send a command to an agent and await its result.
 *
 * Resolves with the result payload when `resolvePendingAgentCommand` is called
 * for the same command id. Resolves with `{status:'failed'}` if the agent is
 * offline (sendCommandToAgent returns false) or if timeoutMs elapses.
 */
export function sendCommandToAgentAwaitResult(
  agentId: string,
  command: { id: string; type: string; payload: Record<string, unknown> },
  timeoutMs: number,
): Promise<AgentCommandAwaitResult> {
  const sent = sendCommandToAgent(agentId, command);
  if (!sent) {
    return Promise.resolve({ status: 'failed', error: 'agent offline' });
  }

  return new Promise<AgentCommandAwaitResult>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(command.id)) {
        resolve({ status: 'failed', error: 'timeout waiting for agent command result' });
      }
    }, timeoutMs);

    pending.set(command.id, { resolve, timer });
  });
}

/**
 * Resolve a pending awaited command by id.
 *
 * Called from agentWs.processCommandResult for every incoming command_result
 * message. Is a no-op when nobody is awaiting that id (the common case for
 * non-awaited fire-and-forget commands).
 *
 * Returns true if a pending entry was found and resolved, false otherwise.
 * Callers use this to short-circuit further dispatch when the result has been
 * fully consumed by an awaiting promise (e.g. http_request proxy commands that
 * have no device_commands row and would otherwise trigger needless DB lookups
 * plus a console.warn per result).
 */
export function resolvePendingAgentCommand(
  commandId: string,
  result: AgentCommandAwaitResult,
): boolean {
  const entry = pending.get(commandId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(commandId);
  entry.resolve(result);
  return true;
}
