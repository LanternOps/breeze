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
 *
 * This module is API-ROLE-AFFINE BY DESIGN (wave 3.5b, #4084): `pending` is an
 * in-process correlation map keyed by command id, resolved only by a
 * command_result arriving on THIS process's WebSocket. There is no
 * cross-process equivalent — a worker-role process could enqueue a relay send
 * via dispatchCommandToAgent, but it could never observe the result, so this
 * helper is never given a cross-process path. Its callers never leave the api
 * role (see the plan's Global Constraints — "no cross-process
 * agentCommandAwait" is a deliberate scope cut, not an oversight).
 */

import { sendCommandToAgent } from '../routes/agentWs';
import { breezeRole } from '../config/env';

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
 * Node's http.Server `requestTimeout` default (ms). `serve(...)` in index.ts
 * does not override it, so it is the only bound on a proxied request's body
 * read (`await c.req.arrayBuffer()` in routes/tunnelHttp.ts path mode).
 */
const NODE_DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
/**
 * Agent round-trip timeout for a proxied request. Restated from
 * `HTTP_REQUEST_TIMEOUT_MS` in routes/tunnelHttpCore.ts (which imports this
 * module, so importing it here would be circular); keep the two in sync.
 */
const PROXIED_REQUEST_TIMEOUT_MS = 25_000;
const TOMBSTONE_SLACK_MS = 5_000;

/**
 * Cancellation tombstones: a prefix cancelled by `cancelPendingAgentCommandsByPrefix`
 * keeps refusing NEW sends with that prefix for a while. Closes the window where
 * a request passed its gates but had not yet registered in `pending` when Close
 * swept. The longest such gap is the request body read, bounded only by the
 * server's requestTimeout, plus the agent round-trip timeout; after that the
 * request would have been killed anyway.
 */
export const CANCELLED_PREFIX_TOMBSTONE_TTL_MS =
  NODE_DEFAULT_REQUEST_TIMEOUT_MS + PROXIED_REQUEST_TIMEOUT_MS + TOMBSTONE_SLACK_MS;
const cancelledPrefixes = new Map<string, { error: string; expiresAt: number }>();

function findCancelledPrefix(commandId: string): string | null {
  const now = Date.now();
  let found: string | null = null;
  for (const [prefix, t] of cancelledPrefixes) {
    if (t.expiresAt <= now) { cancelledPrefixes.delete(prefix); continue; }
    if (found === null && commandId.startsWith(prefix)) found = t.error;
  }
  return found;
}

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
  // Wave 3.5b (#4084): fail LOUDLY in the worker role rather than resolving
  // {status:'failed', error:'agent offline'} for every call — that would be
  // indistinguishable from a real offline agent and would hide the actual
  // bug (this helper called from a process with no sockets and no way to
  // ever see the result).
  if (breezeRole() === 'worker') {
    throw new Error(
      '[BREEZE_ROLE] sendCommandToAgentAwaitResult is socket-local and api-role-affine '
      + '(its correlation map cannot resolve cross-process) — it cannot run in the worker role',
    );
  }
  const cancelledError = findCancelledPrefix(command.id);
  if (cancelledError !== null) {
    return Promise.resolve({ status: 'failed', error: cancelledError });
  }
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

/**
 * Resolve every in-flight awaited command whose id starts with `prefix` as
 * `{status:'failed', error}`, and tombstone the prefix so sends racing this call
 * (not yet registered in `pending`) are refused too. Used by tunnel Close (spec 2026-10-06 §4) to
 * cancel that tunnel's proxied requests. Process-local like the rest of this
 * module: a request in flight on ANOTHER api replica is not reached (single
 * api replica per region today — plan G9).
 */
export function cancelPendingAgentCommandsByPrefix(prefix: string, error: string): number {
  findCancelledPrefix(''); // lazy prune of expired tombstones
  cancelledPrefixes.set(prefix, { error, expiresAt: Date.now() + CANCELLED_PREFIX_TOMBSTONE_TTL_MS });
  let cancelled = 0;
  for (const [id, entry] of pending) {
    if (!id.startsWith(prefix)) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve({ status: 'failed', error });
    cancelled += 1;
  }
  return cancelled;
}

/** Test-only: drop all cancellation tombstones so they cannot leak between tests. */
export function __resetCancelledPrefixTombstonesForTests(): void {
  cancelledPrefixes.clear();
}
