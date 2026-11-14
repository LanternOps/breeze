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
 */
import { createSdkMcpServer, type HookCallbackMatcher, type HookInput, type HookJSONOutput, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { findUnknownInputKeys, formatUnknownKeyFinding } from './aiToolUnknownKeys';

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
 * `unknownToolArgsHooks` can refuse unknown arguments for it. Every production
 * SDK server goes through here (aiSdkToolArgGuard.test.ts scans for it).
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
    const refusal = unknownToolArgsRefusal(schema, input.tool_input);
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
 * the tool does not define. Servers not built by `createArgCheckedSdkMcpServer`
 * (none in production) and every non-MCP tool pass through untouched.
 */
export function unknownToolArgsHooks(
  mcpServers: Readonly<Record<string, McpServerConfig>>,
): { PreToolUse: HookCallbackMatcher[] } {
  return hooksFor(Object.entries(mcpServers).flatMap(([name, config]) => {
    const schemas = advertisedSchemas.get(config as object);
    return schemas ? [{ name, schemas }] : [];
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
