/**
 * Pairs a tool call's RESULT with the model's `tool_use` block (issue #7931).
 *
 * Two independent paths see every tool call, and they race:
 *
 *  - the session's background processor sees the `content_block_start`
 *    stream event (`noteStreamedToolUse`) — it knows the model's tool_use id;
 *  - our MCP handler runs the tool and then postToolUse / the client-tool
 *    handler records the result (`claimToolUseId`).
 *
 * The SDK dispatches the MCP call concurrently with the processor, so the
 * result side can run BEFORE the processor reaches the stream event. Pairing
 * by queue position (`toolUseIdQueue.shift()`) broke exactly then: the early
 * result got no id, every later result got its predecessor's id, and the id
 * left behind made the #3094 dropped-call fallback record a fake "rejected
 * before execution" result and flag the session.
 *
 * So the result side pairs by the id itself. The Claude Code CLI sends it on
 * every MCP `tools/call` as `params._meta['claudecode/toolUseId']`, and the
 * MCP server hands that to the tool handler as `extra._meta`
 * (`sdkToolUseIdFromExtra`). Only when a handler has no id does pairing fall
 * back to the oldest pending call with the same tool name.
 *
 * Invariant the dropped-call fallback relies on: an id in `toolUseIdQueue` is
 * a call whose stream event was seen and whose result has NOT been recorded.
 * A result that arrives first leaves a marker that stops its stream event
 * from ever entering the queue, whichever order the two arrive in.
 */
import type { ActiveSession } from './streamingSessionManager';
import type { PostToolUseCallback } from './aiAgentSdkTools';
import { captureMessage } from './sentry';

/** The `_meta` key the Claude Code CLI puts the model's tool_use id under on `tools/call`. */
export const SDK_TOOL_USE_ID_META_KEY = 'claudecode/toolUseId';

/**
 * Read the model's tool_use id from an MCP tool handler's `extra` argument.
 * Returns undefined for anything that is not a non-empty string.
 */
export function sdkToolUseIdFromExtra(extra: unknown): string | undefined {
  if (!extra || typeof extra !== 'object') return undefined;
  const meta = (extra as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const id = (meta as Record<string, unknown>)[SDK_TOOL_USE_ID_META_KEY];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * `onPostToolUse` with this call's SDK tool_use id bound in, so every
 * postToolUse an MCP handler makes for one call carries the id without each
 * call site threading it. `extra` is the handler's second argument.
 */
export function postToolUseForCall(
  onPostToolUse: PostToolUseCallback | undefined,
  extra: unknown,
): PostToolUseCallback | undefined {
  if (!onPostToolUse) return undefined;
  const toolUseId = sdkToolUseIdFromExtra(extra);
  return (toolName, input, output, isError, durationMs, sealed, handoff) =>
    onPostToolUse(toolName, input, output, isError, durationMs, sealed, handoff, toolUseId);
}

type CorrelationState = Pick<
  ActiveSession,
  'toolUseIdQueue' | 'toolUseNames' | 'resultedToolUseIds' | 'resultedWithoutIdByName'
>;

/**
 * Processor side: the model's tool_use block started streaming. Registers the
 * call as pending (so the dropped-call fallback can find it) unless its result
 * was already recorded. Returns true when the call is now pending.
 */
export function noteStreamedToolUse(session: CorrelationState, toolUseId: string, toolName: string): boolean {
  if (session.resultedToolUseIds?.delete(toolUseId)) return false;
  const unpaired = session.resultedWithoutIdByName?.get(toolName) ?? 0;
  if (unpaired > 0) {
    // A same-name call already recorded its result without an id: this is
    // that call (or a sibling whose own result is also id-less). Either way
    // it ran, so it must never look like a dropped call.
    if (unpaired === 1) session.resultedWithoutIdByName!.delete(toolName);
    else session.resultedWithoutIdByName!.set(toolName, unpaired - 1);
    return false;
  }
  session.toolUseIdQueue.push(toolUseId);
  session.toolUseNames?.set(toolUseId, toolName);
  return true;
}

/**
 * Result side: the call ran and its result is being recorded. Returns the id
 * to record the result under, or undefined when no id can be known.
 *
 * With the SDK's id: removes it from the pending set, or — if its stream event
 * has not been processed yet — marks it so that event is not queued later.
 *
 * Without one: takes the oldest pending call with the same tool name. Sessions
 * that do not track names (tests, legacy callers) keep the old head-of-queue
 * pairing. If nothing is pending yet, the result is recorded without an id and
 * a per-name marker keeps the later stream event out of the pending set.
 */
export function claimToolUseId(
  session: CorrelationState,
  toolName: string,
  sdkToolUseId?: string,
): string | undefined {
  if (sdkToolUseId) {
    const idx = session.toolUseIdQueue.indexOf(sdkToolUseId);
    if (idx !== -1) {
      session.toolUseIdQueue.splice(idx, 1);
      session.toolUseNames?.delete(sdkToolUseId);
    } else {
      (session.resultedToolUseIds ??= new Set()).add(sdkToolUseId);
    }
    return sdkToolUseId;
  }

  const names = session.toolUseNames;
  if (!names) return session.toolUseIdQueue.shift();

  reportMissingSdkToolUseId(session, toolName);

  const idx = session.toolUseIdQueue.findIndex((id) => names.get(id) === toolName);
  if (idx !== -1) {
    const [id] = session.toolUseIdQueue.splice(idx, 1);
    names.delete(id!);
    return id;
  }
  const byName = (session.resultedWithoutIdByName ??= new Map());
  byName.set(toolName, (byName.get(toolName) ?? 0) + 1);
  return undefined;
}

const scopesWarnedMissingId = new WeakSet<object>();

/**
 * Every tool call is expected to carry the SDK id; without it, two parallel
 * calls of the same tool can be mis-paired. Warns and reports to Sentry once
 * per `scope` (a chat session, or one agent run's correlation state), so a CLI
 * change that stops sending the id is loud without flooding the logs.
 */
export function reportMissingSdkToolUseId(
  scope: object,
  toolName: string,
  surface: 'session' | 'agent_run' = 'session',
): void {
  if (scopesWarnedMissingId.has(scope)) return;
  scopesWarnedMissingId.add(scope);
  const where = surface === 'agent_run' ? 'agent run (#8163)' : 'session (#7931)';
  console.warn(
    `[AI-SDK] tool call ${toolName} arrived without the SDK tool_use id (_meta['${SDK_TOOL_USE_ID_META_KEY}']) — pairing results by tool name for this ${where}`,
  );
  captureMessage(
    surface === 'agent_run' ? 'AI agent-run tool call without SDK tool_use id' : 'AI tool call without SDK tool_use id',
    { eventCode: 'ai_tool_use_id_missing', level: 'warning' },
  );
}

/**
 * Dropped-call fallback (#3094): if `toolUseId` is still pending, the SDK fed
 * the model a result for a call our handler never recorded. Removes it and
 * returns its tool name; returns undefined for any call that was recorded.
 */
export function takeDroppedToolUse(session: CorrelationState, toolUseId: string): { toolName: string } | undefined {
  const idx = session.toolUseIdQueue.indexOf(toolUseId);
  if (idx === -1) return undefined;
  session.toolUseIdQueue.splice(idx, 1);
  const toolName = session.toolUseNames?.get(toolUseId) ?? 'unknown_tool';
  session.toolUseNames?.delete(toolUseId);
  return { toolName };
}

/**
 * Turn end: drop result-first markers whose stream event never came (e.g. a
 * call the CLI timed out). Pending ids are left alone — they are only
 * resolved by a result or by the dropped-call fallback.
 */
export function resetToolUseCorrelationMarkers(session: CorrelationState): void {
  session.resultedToolUseIds?.clear();
  session.resultedWithoutIdByName?.clear();
}
