/**
 * Unknown-argument refusal on the Agent SDK surfaces (#11861): chat, Wisp,
 * helper, script builder, Office/client tools and agent runs.
 *
 * `validateToolInput` cannot see an unknown key on these surfaces: the SDK's
 * in-process MCP server parses every call against the tool's advertised Zod
 * shape BEFORE the handler runs, and a plain shape STRIPS unknown keys. The
 * handler (and `executeTool`) only ever receives the stripped arguments, so
 * `query_devices({ filter })` ran unfiltered with no signal to anyone.
 *
 * The fix keeps the advertised schemas byte-identical (no `additionalProperties`
 * added to any tool definition, so the token cost and `tools/list` output do
 * not move) and refuses at the one place that still sees the model's raw
 * arguments: a `PreToolUse` hook. Every production SDK server is built through
 * `createArgCheckedSdkMcpServer`, which records each registered tool's shape;
 * `unknownToolArgsHooks` turns the servers handed to `query()` into a hook that
 * denies a call carrying a key that shape does not define, naming the key and
 * the accepted ones (`aiToolUnknownKeys.ts`), so the model can retry.
 *
 * A denied call never reaches the handler: it files no approval and runs
 * nothing, the same as a call the SDK's own schema check refuses today.
 *
 * Coverage (aiSdkToolArgGuard.test.ts): a source scan holds every production
 * `createSdkMcpServer` and `query()` to this module; the surface_turn verify
 * harness builds through an injected SDK and passes
 * `unknownToolArgsHooksForTools`; two offline measurement harnesses (tool
 * capture, provider fidelity) are exempt — they never run a production turn.
 * A server handed to the hook that this module did not record, or a check that
 * throws, is never silent: the first is reported, the second denies the call.
 */
import { createSdkMcpServer, type HookCallbackMatcher, type HookInput, type HookJSONOutput, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { findUnknownInputKeys, formatUnknownKeyFinding } from './aiToolUnknownKeys';
import { captureException, captureMessage } from './sentry';

type SdkServerOptions = Parameters<typeof createSdkMcpServer>[0];
type SdkServer = ReturnType<typeof createSdkMcpServer>;

/** Server instance → tool name → the schema the SDK validates that tool's calls with. */
const advertisedSchemas = new WeakMap<object, ReadonlyMap<string, z.ZodType>>();

function schemaOf(inputSchema: unknown): z.ZodType | undefined {
  if (!inputSchema || typeof inputSchema !== 'object') return undefined;
  // A Zod schema passed whole (the SDK accepts one) is used as-is; a raw shape
  // is what the SDK wraps in a plain (stripping) object.
  if ('_zod' in inputSchema) return inputSchema as z.ZodType;
  return z.object(inputSchema as z.ZodRawShape);
}

type ToolDecl = { name: string; inputSchema: unknown };

function schemaMap(tools: ReadonlyArray<ToolDecl>): Map<string, z.ZodType> {
  const schemas = new Map<string, z.ZodType>();
  for (const t of tools) {
    const schema = schemaOf(t.inputSchema);
    if (schema) schemas.set(t.name, schema);
  }
  return schemas;
}

/**
 * `createSdkMcpServer`, recording each tool's advertised input schema so
 * `unknownToolArgsHooks` can refuse unknown arguments for it.
 */
export function createArgCheckedSdkMcpServer(options: SdkServerOptions): SdkServer {
  const server = createSdkMcpServer(options);
  // A test double of the SDK may hand back a non-object; there is nothing to key on.
  if (server && typeof server === 'object') advertisedSchemas.set(server, schemaMap(options.tools ?? []));
  return server;
}

/** The refusal text for a call, or null when every argument is defined. */
export function unknownToolArgsRefusal(schema: z.ZodType, input: unknown): string | null {
  const findings = findUnknownInputKeys(schema, input);
  if (findings.length === 0) return null;
  return `Invalid input: ${findings.map(formatUnknownKeyFinding).join('; ')}`;
}

function hooksFor(servers: Array<{ name: string; schemas: ReadonlyMap<string, z.ZodType> }>): { PreToolUse: HookCallbackMatcher[] } {
  // Longest prefix first, so `mcp__a_b__x` never resolves against server `a`.
  const byPrefix = servers
    .map((s) => ({ prefix: `mcp__${s.name}__`, schemas: s.schemas }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  const hook = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    // Only an in-process server this process registered; a configured server
    // that happens to share the name is not ours to judge.
    if (input.mcp_server && input.mcp_server.source !== 'sdk') return {};
    const server = byPrefix.find((s) => input.tool_name.startsWith(s.prefix));
    const schema = server?.schemas.get(input.tool_name.slice(server.prefix.length));
    if (!schema) return {};
    let refusal: string | null;
    try {
      refusal = unknownToolArgsRefusal(schema, input.tool_input);
    } catch (err) {
      // A throwing hook is non-blocking to the SDK: the call would run with the
      // keys stripped, the very failure this guards. Deny instead.
      console.error(`[aiSdkToolArgGuard] argument check threw for ${input.tool_name}:`, err);
      try {
        captureException(err, undefined, { op: 'ai.tool_arg_guard', toolName: input.tool_name });
      } catch { /* the console line above stands */ }
      refusal = 'Invalid input: the arguments could not be checked; retry the call with only the documented arguments.';
    }
    if (!refusal) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: refusal,
      },
    };
  };
  return { PreToolUse: [{ hooks: [hook] }] };
}

/**
 * The `query({ hooks })` value for a set of MCP servers: a `PreToolUse` hook
 * that denies a call to a recorded server's tool when it carries an argument
 * the tool does not define. Every non-MCP tool passes through untouched. An
 * in-process (`type: 'sdk'`) server this module did not record — one not built
 * by `createArgCheckedSdkMcpServer`, or a copy of one — cannot be checked; it
 * is reported (error log + Sentry) rather than skipped in silence.
 */
export function unknownToolArgsHooks(
  mcpServers: Readonly<Record<string, McpServerConfig>>,
): { PreToolUse: HookCallbackMatcher[] } {
  return hooksFor(Object.entries(mcpServers).flatMap(([name, config]) => {
    const schemas = config && typeof config === 'object' ? advertisedSchemas.get(config) : undefined;
    if (schemas) return [{ name, schemas }];
    if ((config as { type?: unknown } | undefined)?.type === 'sdk') {
      console.error(`[aiSdkToolArgGuard] MCP server "${name}" was not built by createArgCheckedSdkMcpServer; its tools' unknown arguments are not refused`);
      // Reporting must never fail the session it reports on.
      try {
        captureMessage('AI tool argument guard: unrecorded SDK MCP server', { eventCode: 'ai_tool_arg_guard_unrecorded_server', level: 'error' });
      } catch { /* the console line above stands */ }
    }
    return [];
  }));
}

/**
 * The same hook from tool declarations directly, for a caller that builds its
 * server through an injected SDK module (the surface_turn verify harness).
 */
export function unknownToolArgsHooksForTools(
  servers: Readonly<Record<string, ReadonlyArray<ToolDecl>>>,
): { PreToolUse: HookCallbackMatcher[] } {
  return hooksFor(Object.entries(servers).map(([name, tools]) => ({ name, schemas: schemaMap(tools) })));
}
