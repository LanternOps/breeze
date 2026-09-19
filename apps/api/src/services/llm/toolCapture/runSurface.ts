/**
 * Deny-mode measurement with the shared base prompt as a constant term.
 * After A-W02, compose BASE + renderToolIndexByDomain(listChatSurfaceToolNames())
 * + AI_SYSTEM_PROMPT_TAIL here as well.
 *
 * Deny mode denies at the HANDLER level, not via `canUseTool`. `allowedTools`
 * bare-name entries pre-approve a tool before the SDK ever consults
 * `canUseTool` (the SDK's own `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning says
 * so), so a `canUseTool` callback here would never run and its only visible
 * effect would be that warning on every capture. Instead, every surface's
 * `createBreezeMcpServer`/`createScriptBuilderMcpServer` accepts an
 * `onPreToolUse` hook (`aiAgentSdkTools.ts` `makeToolHandler`) that can refuse
 * a call BEFORE `getAuth()` runs and BEFORE the handler body touches the DB —
 * `denyPreToolUse` below returns `{ allowed: false, error }`, which the SDK
 * publishes as an ordinary `isError: true` tool_result. The model sees a tool
 * error and nothing executes, with no thrown exception and no stack trace on
 * stderr. `denyAuth` is kept only as a construction-time trip wire: if a
 * server ever starts calling `getAuth()` eagerly instead of per-call, this
 * throws immediately with a clear message instead of silently succeeding.
 *
 * A `result` message whose `subtype` isn't `success` (e.g. `error_max_turns`,
 * because every tool call is refused so the model has nothing left to try
 * within the turn budget) is an EXPECTED end of a deny-mode run, not a
 * harness failure. The SDK's own transport wraps the CLI subprocess's
 * non-zero exit, after such a result, as a rejected async iterator — even
 * though the `result` message itself was already delivered to `onMessage`
 * before that rejection. The catch below unwraps that: if a `result` was
 * already observed, the rejection is discarded and the capture returns
 * normally; only a rejection with NO observed `result` (a real SDK/harness
 * failure before any result — bad key, transport crash, etc.) propagates.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AI_SYSTEM_PROMPT_BASE } from '../../aiAgentSystemPrompt';
import { createBreezeMcpServer, TOOL_TIERS, type PreToolUseCallback } from '../../aiAgentSdkTools';
import { createScriptBuilderMcpServer, SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';
import { createStreamObserver, type StreamObservation } from './streamObserver';
import type { CaptureSurface, CaptureSurfaceId } from './surfaces';

export interface RunSurfaceOptions {
  surface: CaptureSurface;
  prompt: string;
  model: string;
  env: Record<string, string>;
  resume?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface SurfaceCaptureResult {
  surface: CaptureSurfaceId;
  registeredToolCount: number;
  allowedToolCount: number;
  observation: StreamObservation;
}

const DENY_MESSAGE = 'tool-capture harness: execution disabled';

const denyAuth = () => { throw new Error('tool-capture: handlers never execute (deny mode)'); };

// Exported for runSurface.test.ts — the handler-level denial contract is
// what the query()-mocked test can exercise without the real SDK dispatch.
export const denyPreToolUse: PreToolUseCallback = async () => ({ allowed: false, error: DENY_MESSAGE });

export async function runSurfaceCapture(opts: RunSurfaceOptions): Promise<SurfaceCaptureResult> {
  const { surface } = opts;
  const mcpServer = surface.server === 'breeze'
    ? createBreezeMcpServer(denyAuth, denyPreToolUse, undefined, undefined, [], surface.onlyTools ? { onlyTools: surface.onlyTools } : undefined)
    : createScriptBuilderMcpServer(denyAuth, denyPreToolUse);
  const registeredToolCount = surface.server === 'breeze'
    ? (surface.onlyTools ? surface.onlyTools.size : Object.keys(TOOL_TIERS).length)
    : SCRIPT_BUILDER_MCP_TOOL_NAMES.length;
  const observer = createStreamObserver();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 90_000);
  timer.unref();
  let observation: StreamObservation;
  try {
    const session = query({
      prompt: opts.prompt,
      options: {
        systemPrompt: AI_SYSTEM_PROMPT_BASE,
        model: opts.model,
        maxTurns: opts.maxTurns ?? 2,
        tools: [],
        allowedTools: [...surface.allowedTools],
        mcpServers: { [surface.mcpServerName]: mcpServer },
        includePartialMessages: surface.includePartialMessages,
        env: opts.env,
        resume: opts.resume,
        persistSession: true,
        settingSources: [],
        thinking: { type: 'disabled' },
        abortController: abort,
        stderr: (data: string) => observer.onStderr(data),
      },
    });
    for await (const message of session) observer.onMessage(message);
    observation = observer.finish();
  } catch (err) {
    observation = observer.finish();
    // No `result` was ever observed: a genuine failure (bad key, transport
    // crash, harness bug) before the run produced anything — a real problem,
    // not an expected deny-mode ending. Propagate it.
    if (!observation.result) throw err;
  } finally {
    clearTimeout(timer);
  }
  return { surface: surface.id, registeredToolCount, allowedToolCount: surface.allowedTools.length, observation };
}
