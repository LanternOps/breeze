/**
 * Script Builder AI Tool Definitions
 *
 * Curated subset of Breeze AI tools for the script editor assistant.
 * Includes 2 custom apply tools (code + metadata) and 8 existing tools.
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { AuthContext } from '../middleware/auth';
import { dbAccessContextFromAuth } from '../middleware/auth';
import { executeTool } from './aiTools';
import { withDbAccessContext, runOutsideDbContext } from '../db';
import type { AiToolTier } from '@breeze/shared/types/ai';
import { scriptParameterDefinitionsSchema } from '@breeze/shared';
import { compactToolResultForChat } from './aiToolOutput';
import { captureException } from './sentry';
import type { PreToolUseCallback, PostToolUseCallback } from './aiAgentSdkTools';
import type { ToolExecutionContext } from './toolExecutionContext';
import { sanitizeThrownToolError } from './aiToolErrors';
import { normalizeScriptCode } from './scriptCodeNormalize';
import { aiRunContextInputShape } from './scriptRunRequest';

const TOOL_EXECUTION_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ============================================
// Tool Tier Map
// ============================================

export const SCRIPT_BUILDER_TOOL_TIERS: Record<string, AiToolTier> = {
  apply_script_code: 1,
  apply_script_metadata: 1,
  query_devices: 1,
  get_device_details: 1,
  manage_alerts: 1,
  list_scripts: 1,
  get_script_details: 1,
  list_script_templates: 1,
  get_script_execution_history: 1,
  get_script_execution: 1,
  execute_script_on_device: 3,
};

/** SDK MCP server name — the `<server>` in the `mcp__<server>__<tool>` names
 *  the model sees and the session allowlist is built from. */
export const SCRIPT_BUILDER_MCP_SERVER_NAME = 'script_builder';

/** The name a script-builder tool is exposed to the model (and allowlisted) as. */
export function scriptBuilderMcpToolName(toolName: string): string {
  return `mcp__${SCRIPT_BUILDER_MCP_SERVER_NAME}__${toolName}`;
}

export const SCRIPT_BUILDER_MCP_TOOL_NAMES = Object.keys(SCRIPT_BUILDER_TOOL_TIERS).map(
  scriptBuilderMcpToolName
);

/**
 * Registered tool name -> the `executeTool` handler that actually runs it, for
 * the tools whose model-facing name differs from their handler.
 *
 * Keys are the BARE names the `tool()` calls register (`execute_script_on_device`),
 * not the `mcp__script_builder__`-prefixed form — `scriptBuilderMcpToolName`
 * adds the prefix where the allowlist needs it.
 *
 * The two identities are NOT interchangeable and must not be conflated:
 *   - the registered name is what the model calls, and prefixed, what
 *     `scriptAi.ts` puts in the session's `allowedTools`
 *     (`SCRIPT_BUILDER_MCP_TOOL_NAMES`);
 *   - the handler name is what `TOOL_TIERS`, `TOOL_PERMISSIONS`,
 *     `toolInputSchemas` and the per-tool rate limits are keyed on.
 * `makeExistingHandler` below resolves through this map so each call site
 * names only its own tool. Previously the handler name was passed into
 * `makeExistingHandler` instead (the `tool()` name itself never changed),
 * which is how the session guardrail ended up checking `run_script` against
 * an allowlist that only holds
 * `mcp__script_builder__execute_script_on_device` (#4883).
 */
export const SCRIPT_BUILDER_HANDLER_BY_MCP_TOOL: Record<string, string> = {
  execute_script_on_device: 'run_script',
};

// ============================================
// Handler factory for existing tools
// ============================================

/**
 * @param registeredToolName the BARE name this tool is registered under in the
 *   `tool()` call below — the key `SCRIPT_BUILDER_TOOL_TIERS` uses and, once
 *   prefixed, what the session allowlist holds. (Not to be confused with
 *   `PreToolUseCallback`'s `mcpToolName`, which is the fully-qualified
 *   `mcp__script_builder__…` form this derives from it.) The `executeTool`
 *   handler it dispatches to is resolved from
 *   `SCRIPT_BUILDER_HANDLER_BY_MCP_TOOL`, and everything keyed on the handler
 *   (tier, RBAC, rate limit, schema, result compaction, audit) stays on that
 *   name — only the session-allowlist check gets the exposed name (#4883).
 */
function makeExistingHandler(
  registeredToolName: string,
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  const toolName = SCRIPT_BUILDER_HANDLER_BY_MCP_TOOL[registeredToolName] ?? registeredToolName;
  const exposedToolName = scriptBuilderMcpToolName(registeredToolName);

  return async (args: Record<string, unknown>) => {
    const startTime = Date.now();
    let verifiedContext: ToolExecutionContext | undefined;

    if (onPreToolUse) {
      let check: Awaited<ReturnType<PreToolUseCallback>>;
      try {
        check = await onPreToolUse(toolName, args, exposedToolName);
      } catch (err) {
        captureException(err);
        console.error(`[ScriptBuilder] PreToolUse threw for ${toolName}:`, err);
        check = { allowed: false, error: 'Internal guardrails error.' };
      }
      if (!check.allowed) {
        const safeError = compactToolResultForChat(toolName, JSON.stringify({ error: check.error }));
        if (onPostToolUse) {
          try { await onPostToolUse(toolName, args, safeError, true, 0); }
          catch (err) { captureException(err); console.error('[ScriptBuilder] PostToolUse failed:', err); }
        }
        return { content: [{ type: 'text' as const, text: safeError }], isError: true };
      }
      // Carry the exact script/variable material verified for approval, as
      // the Fleet AI handler does. Re-reading it would reopen the gap between
      // verifying the approved digest and dispatching the script.
      verifiedContext = check.intentId
        ? { ...check.context, actionIntentId: check.intentId }
        : check.context;
    }

    try {
      const auth = getAuth();
      // Reconstruct the user's DB access context so tool execution runs
      // under the same RLS scope the originating request did. Wrap in
      // runOutsideDbContext first because withDbAccessContext short-circuits
      // when an AsyncLocalStorage store already exists — and the SDK MCP
      // dispatch chain leaves a stale store behind, which would cause the
      // inner call to inherit whatever scope happened to be on the stack.
      // Built via the canonical `dbAccessContextFromAuth` (#2822): the literal
      // this replaced omitted `accessiblePartnerIds` / `currentPartnerId` /
      // `userId`, and since `runOutsideDbContext` discards the ambient context
      // first, that partial object was the only context Postgres saw — leaving
      // `breeze_has_partner_access` FALSE for every script-builder tool call,
      // even a partner-scope admin's. Partner-wide scripts, script categories
      // and tags all read as empty with a 200.
      const result = await withTimeout(
        runOutsideDbContext(() =>
          withDbAccessContext(
            dbAccessContextFromAuth(auth),
            () => verifiedContext
              ? executeTool(toolName, args, auth, { context: verifiedContext })
              : executeTool(toolName, args, auth),
          ),
        ),
        TOOL_EXECUTION_TIMEOUT_MS,
        toolName,
      );
      const compactResult = compactToolResultForChat(toolName, result);
      const durationMs = Date.now() - startTime;

      if (onPostToolUse) {
        try { await onPostToolUse(toolName, args, compactResult, false, durationMs); }
        catch (err) { captureException(err); console.error('[ScriptBuilder] PostToolUse failed:', err); }
      }

      return { content: [{ type: 'text' as const, text: compactResult }] };
    } catch (err) {
      captureException(err);
      const errorMsg = sanitizeThrownToolError(toolName, err);
      const durationMs = Date.now() - startTime;
      const safeError = compactToolResultForChat(toolName, JSON.stringify({ error: errorMsg }));

      if (onPostToolUse) {
        try { await onPostToolUse(toolName, args, safeError, true, durationMs); }
        catch (e) { captureException(e); console.error('[ScriptBuilder] PostToolUse failed:', e); }
      }

      return { content: [{ type: 'text' as const, text: safeError }], isError: true };
    }
  };
}

// ============================================
// Apply tool handlers (emit SSE events, no DB execution)
// ============================================

// Exported for scriptBuilderTools.applyNormalize.test.ts, which pins that the
// normalized (not raw) code is what reaches onPostToolUse — the object the SSE
// tool_result re-attach delivers to the editor.
export function makeApplyHandler(
  toolName: string,
  onPostToolUse?: PostToolUseCallback,
) {
  return async (args: Record<string, unknown>) => {
    const startTime = Date.now();
    // Scrub typographic Unicode (curly quotes, em-dashes, NBSP) the model
    // sometimes emits — it breaks script parsing on-device (PowerShell 5.1
    // ANSI mis-decode; literal chars in bash syntax positions). The editor
    // receives `args` via the SSE tool_result re-attach in
    // aiAgentSdk.createSessionPostToolUse.
    if (typeof args.code === 'string') {
      args = { ...args, code: normalizeScriptCode(args.code) };
    }
    const code = typeof args.code === 'string' ? args.code : undefined;
    const output = compactToolResultForChat(toolName, JSON.stringify({
      applied: true,
      toolName,
      language: args.language,
      ...(code ? { codeOmitted: true, codeChars: code.length } : {}),
    }));
    const durationMs = Date.now() - startTime;

    if (onPostToolUse) {
      try { await onPostToolUse(toolName, args, output, false, durationMs); }
      catch (err) { captureException(err); console.error('[ScriptBuilder] PostToolUse failed:', err); }
    }

    return { content: [{ type: 'text' as const, text: output }] };
  };
}

// ============================================
// MCP Server Factory
// ============================================

// Exported so scriptBuilderTools.guard.test.ts can pin the timeoutSeconds cap
// to the agent executor's MaxTimeout (3600) — see #2398.
export const applyScriptMetadataInputShape = {
  name: z.string().max(255).optional().describe('Script name'),
  description: z.string().max(2000).optional().describe('Script description'),
  category: z.enum(['Maintenance', 'Security', 'Monitoring', 'Deployment', 'Backup', 'Network', 'User Management', 'Software', 'Custom']).optional(),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
  // The one definition schema (#3409 PR3) — same shape, same env-var collision
  // rule, and the same 64-parameter cap the API itself now enforces, so the
  // builder can no longer propose a definition list the save endpoint rejects.
  parameters: scriptParameterDefinitionsSchema.optional(),
  runAs: z.enum(['system', 'user', 'elevated']).optional(),
  // 3600 = agent executor MaxTimeout — higher values are silently clamped
  // on-device, so don't let the builder propose them (#2398).
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
};

/**
 * The tool definitions this MCP server exposes.
 *
 * Exported so scriptBuilderTools.guard.test.ts can drive each registered
 * handler and pin what it hands the session guardrail — the wiring that
 * silently denied every execute_script_on_device call (#4883).
 */
export function buildScriptBuilderTools(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  const uuid = z.string().guid();

  return [
    // --- Apply tools (script-builder-only) ---
    tool(
      'apply_script_code',
      'Write or replace the script code in the editor. Use this to deliver code to the user instead of putting it in a chat message.',
      {
        code: z.string().describe('The full script code to write into the editor'),
        language: z.enum(['powershell', 'bash', 'python', 'cmd']).describe('The scripting language'),
      },
      makeApplyHandler('apply_script_code', onPostToolUse)
    ),

    tool(
      'apply_script_metadata',
      'Set script metadata fields in the editor form (name, description, category, OS targets, parameters, etc.). Only include fields you want to change.',
      applyScriptMetadataInputShape,
      makeApplyHandler('apply_script_metadata', onPostToolUse)
    ),

    // --- Context tools (reuse existing handlers) ---
    tool(
      'query_devices',
      'Search and filter devices. Use to find devices by OS, status, or name for tailoring scripts.',
      {
        status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
        osType: z.enum(['windows', 'macos', 'linux']).optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('query_devices', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_device_details',
      'Get device details including hardware, OS, network, and installed software.',
      { deviceId: uuid },
      makeExistingHandler('get_device_details', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_alerts',
      'Query alerts for a device or org. Use to understand what issue a script should address.',
      {
        action: z.literal('list'),
        alertId: uuid.optional(),
        status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        deviceId: uuid.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('manage_alerts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_scripts',
      'Search the existing script library. Use to find similar scripts or avoid duplicates.',
      {
        search: z.string().max(200).optional(),
        category: z.string().optional(),
        language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
        osType: z.enum(['windows', 'macos', 'linux']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('list_scripts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_script_details',
      'Get full details of an existing script including code, parameters, and execution settings.',
      { scriptId: uuid },
      makeExistingHandler('get_script_details', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_script_templates',
      'Browse available script templates for common tasks.',
      {
        search: z.string().max(200).optional(),
        category: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('list_script_templates', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_script_execution_history',
      'View past execution results for a script. Use to understand success rates and common failures.',
      {
        scriptId: uuid.describe('The script ID to get execution history for'),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('get_script_execution_history', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_script_execution',
      'Fetch one script execution by ID with status, exit code, stdout, and stderr. Use for runs started outside the current tool call (the editor Test Run button, or an execution id from get_script_execution_history) — not to re-check an execute_script_on_device call that already returned.',
      {
        executionId: uuid.describe('The execution ID to fetch'),
      },
      makeExistingHandler('get_script_execution', getAuth, onPreToolUse, onPostToolUse)
    ),

    // --- Execution tool (requires approval) ---
    tool(
      'execute_script_on_device',
      'Run a saved script on one or more devices. The script must be saved first. Requires user approval.',
      {
        scriptId: uuid.describe('The saved script ID to execute'),
        deviceIds: z.array(uuid).min(1).max(10).describe('Target device IDs'),
        parameters: z.record(z.string(), z.unknown()).optional(),
        // #4888 — the same run-context pair the `run_script` handler this tool
        // dispatches to accepts. Adding fields here does NOT disturb the #4883
        // name split: the tool stays registered as `execute_script_on_device`
        // (what the model calls and what the session allowlist holds) while
        // `SCRIPT_BUILDER_HANDLER_BY_MCP_TOOL` still routes it to the
        // `run_script` handler, whose tier, RBAC and input schema own these
        // fields.
        ...aiRunContextInputShape,
      },
      makeExistingHandler('execute_script_on_device', getAuth, onPreToolUse, onPostToolUse)
    ),
  ];
}

export function createScriptBuilderMcpServer(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  return createSdkMcpServer({
    name: SCRIPT_BUILDER_MCP_SERVER_NAME,
    tools: buildScriptBuilderTools(getAuth, onPreToolUse, onPostToolUse),
  });
}
