/**
 * Deny-mode measurement with the surface's production static prompt where available.
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
import { agentSdkWireOptions } from '../../aiModels/modelWireOptions';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { composeStaticSystemPrompt } from '../../aiToolIndex';
import { buildScriptBuilderSystemPrompt } from '../../scriptBuilderPrompt';
import { buildHelperSystemPrompt } from '../../helperAiAgent';
import { buildAgentRunSystemPrompt } from '../../aiAgents/runnerPrompt';
import { HELPER_CAPTURE_FIXTURE, AGENT_CAPTURE_FIXTURE, AGENT_ANALYSIS_CAPTURE_FIXTURE } from './promptFixtures';
import { buildOutcomeSdkTools } from '../../aiAgents/outcomeTools';
import { buildBreezeSdkTools, listChatSurfaceToolNames, createBreezeMcpServer, type PreToolUseCallback } from '../../aiAgentSdkTools';
import { createScriptBuilderMcpServer, SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';
import { createStreamObserver, type StreamObservation } from './streamObserver';
import { SDK_CHILD_HOST_CONTEXT_GUARDS } from '../sdkChildEnvGuards';
import { resolveToolSearchPolicy, type ToolSearchOverride, type ToolSearchPolicy } from '../../aiToolSearchPolicy';
import { buildTenantSdkTools, tenantMcpToolNames } from '../../toolSources/sdkBridge';
import type { TenantToolDescriptor } from '../../toolSources/resolver';
import type { CaptureSurface, CaptureSurfaceId } from './surfaces';

export interface RunSurfaceOptions {
  surface: CaptureSurface;
  prompt: string;
  model: string;
  env: Record<string, string>;
  resume?: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** Stands in for the `AI_TOOL_SEARCH` operator override; default auto. */
  toolSearchOverride?: ToolSearchOverride;
  /**
   * Tenant (BYO MCP) tools, registered through the production
   * `buildTenantSdkTools` bridge and appended to `allowedTools` exactly as
   * `streamingSessionManager` does for a chat session. Chat only: no other
   * surface resolves tenant tools in production. See `tenantFixtures.ts`.
   */
  tenantTools?: readonly TenantToolDescriptor[];
  /**
   * Replaces the surface's static prompt — an agent golden task passes the
   * production `buildAgentRunSystemPrompt(ctx)` for its own run context.
   */
  systemPrompt?: string;
  /**
   * Replaces the surface's `toolSearch` opt-in, so the eval can measure a
   * surface that does not opt in today as if it did (#7428). The rest of the
   * production policy (host, override, turn budget) still applies.
   */
  surfaceSearch?: boolean;
}

export interface SurfaceCaptureResult {
  surface: CaptureSurfaceId;
  registeredToolCount: number;
  /** Sorted, distinct tool names the server actually registered for this
   *  capture — makes the JSONL self-explaining instead of forcing a reader
   *  to cross-reference registeredToolCount against the live registry. */
  registeredToolNames: string[];
  allowedToolCount: number;
  /** Qualified names of the tenant tools registered for this capture, in registration order. */
  tenantToolNames: string[];
  observation: StreamObservation;
}

const DENY_MESSAGE = 'tool-capture harness: execution disabled';

const denyAuth = () => { throw new Error('tool-capture: handlers never execute (deny mode)'); };

// Exported for runSurface.test.ts — the handler-level denial contract is
// what the query()-mocked test can exercise without the real SDK dispatch.
export const denyPreToolUse: PreToolUseCallback = async () => ({ allowed: false, error: DENY_MESSAGE });

/**
 * Env forced onto every capture child. `buildClaudeSdkChildEnv` forwards HOME,
 * so on a developer machine the CLI would read the operator's own
 * `~/.claude/projects/<repo>/memory/MEMORY.md` and prepend it to every first
 * user message (`settingSources: []` does not cover auto-memory). That is not
 * production context: it inflated each captured request by ~9.7k tokens,
 * varied run to run as the memory changed, and sent private notes to whatever
 * `--base-url` was under test (#7429). It is the production guard set
 * (`SDK_CHILD_HOST_CONTEXT_GUARDS`), forced here rather than trusted to the
 * caller's env, so a capture always runs with production's child env guards
 * (CLAUDE.md off, thinking display `updates` off).
 */
export const CAPTURE_CHILD_ENV_ISOLATION = SDK_CHILD_HOST_CONTEXT_GUARDS;

/** Org the tenant bridge would dispatch under; never reached, handlers are denied first. */
const CAPTURE_TENANT_ORG_ID = 'capture-org';

/**
 * A fresh production chat session's turn budget (`ai_sessions.max_turns`
 * default), for surfaces without their own `turnBudget`. The policy's
 * low-budget rule is judged against this, not against the harness's own
 * `maxTurns`, which the eval caps artificially low to score the first call.
 */
const CAPTURE_SESSION_TURN_BUDGET = 50;

/** The tool-search decision production would make for this surface and child env. */
export function captureToolSearchPolicy(
  surface: CaptureSurface,
  env: Record<string, string>,
  override: ToolSearchOverride = 'auto',
  surfaceSearch: boolean = surface.toolSearch,
): ToolSearchPolicy {
  return resolveToolSearchPolicy({
    surfaceSearch,
    childEnv: env,
    remainingTurns: surface.turnBudget ?? CAPTURE_SESSION_TURN_BUDGET,
    override,
  });
}

/** Shared by capture and report byte counts, including failed SDK runs. */
export function getCaptureSystemPrompt(surface: CaptureSurface): string {
  switch (surface.id) {
    case 'chat':
      return composeStaticSystemPrompt(listChatSurfaceToolNames());
    case 'script-builder':
      return buildScriptBuilderSystemPrompt();
    case 'helper-basic':
    case 'helper-standard':
    case 'helper-extended':
      if (!surface.helperPermissionLevel) throw new Error(`Missing Helper permission level: ${surface.id}`);
      return buildHelperSystemPrompt({ ...HELPER_CAPTURE_FIXTURE, permissionLevel: surface.helperPermissionLevel });
    case 'agent-full':
    case 'agent-full-remediation':
      // Production runLoop.driveSdkLoop uses this pure builder with run context.
      return buildAgentRunSystemPrompt(AGENT_CAPTURE_FIXTURE);
    case 'agent-analysis':
      return buildAgentRunSystemPrompt(AGENT_ANALYSIS_CAPTURE_FIXTURE);
  }
}

export async function runSurfaceCapture(opts: RunSurfaceOptions): Promise<SurfaceCaptureResult> {
  const { surface } = opts;
  const tenantTools = [...(opts.tenantTools ?? [])];
  if (tenantTools.length > 0 && surface.id !== 'chat') {
    throw new Error(`tool-capture: tenant tools are only resolved on the chat surface, not ${surface.id}`);
  }
  // Same bridge as streamingSessionManager's default factory. The getAuth thunk
  // is denyAuth: denyPreToolUse refuses first, so a tenant handler never runs.
  const tenantSdkTools = buildTenantSdkTools(tenantTools, denyAuth, () => CAPTURE_TENANT_ORG_ID);
  const tenantToolNames = tenantSdkTools.map((t) => t.name);
  // An agent profile's outcome tools ride on `extraTools`, as in runLoop; they
  // are validate-only and never reach a handler that touches the DB. A surface
  // has either outcome tools (agent) or tenant tools (chat), never both.
  const outcomeTools = buildOutcomeSdkTools(surface.outcomeTools ?? []);
  const mcpServer = surface.server === 'breeze'
    ? createBreezeMcpServer(denyAuth, denyPreToolUse, undefined, undefined, [...outcomeTools, ...tenantSdkTools], surface.onlyTools ? { onlyTools: surface.onlyTools } : undefined)
    : createScriptBuilderMcpServer(denyAuth, denyPreToolUse);
  // Derived from the tools the server actually registers (buildBreezeSdkTools),
  // not TOOL_TIERS — TOOL_TIERS is a system-prompt promotion index, and the
  // registry also includes env-gated tool sets (M365, Google Workspace, script
  // authoring) that TOOL_TIERS does not enumerate. See runSurface.test.ts.
  const registeredToolNames = surface.server === 'breeze'
    ? [...new Set(buildBreezeSdkTools(denyAuth, denyPreToolUse)
        .map((t) => t.name)
        .filter((name) => !surface.onlyTools || surface.onlyTools.has(name))
        .concat(outcomeTools.map((t) => t.name), tenantToolNames))].sort()
    : [...SCRIPT_BUILDER_MCP_TOOL_NAMES].sort();
  const allowedTools = [...surface.allowedTools, ...tenantMcpToolNames(tenantTools)];
  const registeredToolCount = registeredToolNames.length;
  const toolSearch = captureToolSearchPolicy(surface, opts.env, opts.toolSearchOverride, opts.surfaceSearch);
  const observer = createStreamObserver();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 90_000);
  timer.unref();
  let observation: StreamObservation;
  try {
    const session = query({
      prompt: opts.prompt,
      options: {
        systemPrompt: opts.systemPrompt ?? getCaptureSystemPrompt(surface),
        model: opts.model,
        maxTurns: opts.maxTurns ?? 2,
        tools: toolSearch.tools,
        allowedTools,
        mcpServers: { [surface.mcpServerName]: mcpServer },
        includePartialMessages: surface.includePartialMessages,
        env: { ...opts.env, ...CAPTURE_CHILD_ENV_ISOLATION, ...toolSearch.env },
        resume: opts.resume,
        persistSession: true,
        settingSources: [],
        // #7587, #7599: same per-model thinking/effort as production chat (agentSdkWireOptions).
        ...agentSdkWireOptions(opts.model),
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
  return { surface: surface.id, registeredToolCount, registeredToolNames, allowedToolCount: allowedTools.length, tenantToolNames, observation };
}
