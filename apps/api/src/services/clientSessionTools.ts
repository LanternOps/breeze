/**
 * Client-declared session tools — a GENERIC bridge that lets a session client
 * (e.g. the tray Helper) declare its own tools at session creation and execute
 * them itself, while the Agent SDK loop on the server drives them.
 *
 * This mirrors the AI-for-Office tool bridge (clientAiToolBridge.ts +
 * clientAiTools.ts) but carries NO product vocabulary: the declarations, their
 * schemas, and the HTTP execution path all live in the client. The server only:
 *   1. validates the declarations (zod),
 *   2. builds an SDK MCP server from them (createSdkMcpServer/tool()),
 *   3. on each model tool call, publishes a `client_tool_request` SSE event and
 *      parks a resolver, then awaits the client's POST /tool-results (or a 60s
 *      timeout).
 *
 * The pending map is in-process memory by design — the SDK session is a child
 * subprocess of this API instance and each session is pinned to one instance,
 * the same affinity the technician approval endpoint already relies on. Entries
 * are keyed by toolUseId (not secrets: a cross-session guard rejects a post that
 * carries another session's id) and are drained on session teardown.
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { ActiveSession } from './streamingSessionManager';

// ============================================
// Declaration validation (zod)
// ============================================

/** Generic namespace for the SDK MCP server built from client declarations. */
export const CLIENT_DECLARED_MCP_SERVER_NAME = 'client_tools';
export const MAX_CLIENT_DECLARED_TOOLS = 8;
export const MAX_CLIENT_DECLARED_SCHEMA_DEPTH = 3;
export const CLIENT_DECLARED_TOOL_TIMEOUT_MS = 60_000;

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

/**
 * A JSON Schema node. Intentionally a flat, NON-recursive record: the wire
 * schema is validated structurally (depth capped at MAX_CLIENT_DECLARED_SCHEMA_DEPTH)
 * and walked at runtime, so a recursive compile-time type buys nothing and only
 * risks exploding the type checker.
 */
export type JsonSchemaNode = Record<string, unknown>;

export interface ClientToolDeclaration {
  name: string;
  description: string;
  inputSchema: JsonSchemaNode;
}

/**
 * Max nesting depth of a JSON Schema node. A flat object of scalar properties is
 * depth 2 (the object is 1, each property node is 2); one level of nested object
 * is depth 3. Anything deeper than MAX_CLIENT_DECLARED_SCHEMA_DEPTH is rejected
 * so a client cannot smuggle an unbounded/pathological schema into the model.
 */
export function jsonSchemaDepth(node: unknown, depth = 1): number {
  if (!node || typeof node !== 'object') return depth;
  const n = node as Record<string, unknown>;
  let max = depth;
  if (n.properties && typeof n.properties === 'object') {
    for (const child of Object.values(n.properties as Record<string, unknown>)) {
      max = Math.max(max, jsonSchemaDepth(child, depth + 1));
    }
  }
  if (n.items && typeof n.items === 'object') {
    max = Math.max(max, jsonSchemaDepth(n.items, depth + 1));
  }
  return max;
}

const jsonSchemaObjectSchema = z
  .record(z.string(), z.unknown())
  .refine((s) => s.type === 'object', { message: 'inputSchema.type must be "object"' })
  .refine((s) => jsonSchemaDepth(s) <= MAX_CLIENT_DECLARED_SCHEMA_DEPTH, {
    message: `inputSchema must be at most ${MAX_CLIENT_DECLARED_SCHEMA_DEPTH} levels deep`,
  });

export const clientToolDeclarationSchema = z.object({
  name: z.string().regex(TOOL_NAME_RE, 'invalid tool name'),
  description: z.string().min(1).max(2048),
  inputSchema: jsonSchemaObjectSchema,
});

export const clientToolsSchema = z
  .array(clientToolDeclarationSchema)
  .max(MAX_CLIENT_DECLARED_TOOLS)
  .superRefine((tools, ctx) => {
    const seen = new Set<string>();
    for (const t of tools) {
      if (seen.has(t.name)) {
        ctx.addIssue({ code: 'custom', message: `duplicate tool name: ${t.name}` });
      }
      seen.add(t.name);
    }
  });

// ============================================
// JSON Schema → Zod raw shape (for the SDK's tool())
// ============================================

/**
 * The SDK's tool() takes a Zod raw shape and re-derives the wire JSON Schema
 * from it (zod v4 toJSONSchema). The client sends JSON Schema, so convert the
 * supported subset back to zod so the model sees the right parameter names,
 * types, descriptions, and required-ness. Unknown constructs degrade to
 * z.unknown() rather than throwing — the client, not the server, owns semantics.
 */
function jsonSchemaNodeToZodType(node: Record<string, unknown>): z.ZodTypeAny {
  const description = typeof node.description === 'string' ? node.description : undefined;
  let t: z.ZodTypeAny;

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.filter((v): v is string => typeof v === 'string');
    t = values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
  } else {
    switch (node.type) {
      case 'string':
        t = z.string();
        break;
      case 'number':
        t = z.number();
        break;
      case 'integer':
        t = z.number().int();
        break;
      case 'boolean':
        t = z.boolean();
        break;
      case 'array':
        t = z.array(
          node.items && typeof node.items === 'object'
            ? jsonSchemaNodeToZodType(node.items as Record<string, unknown>)
            : z.unknown(),
        );
        break;
      case 'object':
        t = z.object(jsonSchemaObjectToZodShape(node));
        break;
      default:
        t = z.unknown();
    }
  }

  return description ? t.describe(description) : t;
}

export function jsonSchemaObjectToZodShape(schema: Record<string, unknown>): z.ZodRawShape {
  // Mutable accumulator: ZodRawShape's index signature is read-only.
  const shape: Record<string, z.ZodType> = {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== 'object') continue;
    let t = jsonSchemaNodeToZodType(prop as Record<string, unknown>);
    if (!required.has(key)) t = t.optional();
    shape[key] = t;
  }
  return shape;
}

// ============================================
// Pending-call bridge (park → publish → resolve/timeout)
// ============================================

export interface ClientToolDispatchResult {
  output?: unknown;
  error?: string;
}

export type ResolveClientDeclaredOutcome = 'resolved' | 'duplicate' | 'not_found';

interface PendingClientDeclaredTool {
  sessionId: string;
  /** The declared tool name for this call, kept so a resolved result can be
   *  persisted with its tool name (recovered via peekClientDeclaredToolName). */
  toolName: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ClientToolDispatchResult) => void;
}

const pending = new Map<string, PendingClientDeclaredTool>();
/** toolUseId → owning sessionId, kept only to answer a duplicate post with 409. */
const resolvedIds = new Map<string, string>();

/**
 * Park a resolver for one model tool call and publish `client_tool_request`.
 * The returned promise settles when the client posts a result, or after
 * CLIENT_DECLARED_TOOL_TIMEOUT_MS with a "client did not respond" error.
 */
export function requestClientDeclaredTool(
  session: ActiveSession,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ClientToolDispatchResult> {
  return new Promise<ClientToolDispatchResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(toolUseId);
      resolve({
        error: `Tool '${toolName}' timed out after ${Math.round(
          CLIENT_DECLARED_TOOL_TIMEOUT_MS / 1000,
        )}s — the client did not respond.`,
      });
    }, CLIENT_DECLARED_TOOL_TIMEOUT_MS);

    pending.set(toolUseId, { sessionId: session.breezeSessionId, toolName, timer, resolve });
    session.eventBus.publish({ type: 'client_tool_request', toolUseId, toolName, input });
  });
}

/**
 * Resolve a parked call from POST /tool-results.
 *  - 'resolved'  — the call was pending for this session and is now settled.
 *  - 'duplicate' — this session already resolved this id (→ HTTP 409).
 *  - 'not_found' — unknown id, timed out, or owned by another session (→ 404).
 */
export function resolveClientDeclaredTool(
  sessionId: string,
  toolUseId: string,
  result: ClientToolDispatchResult,
): ResolveClientDeclaredOutcome {
  const entry = pending.get(toolUseId);
  if (!entry) {
    return resolvedIds.get(toolUseId) === sessionId ? 'duplicate' : 'not_found';
  }
  if (entry.sessionId !== sessionId) return 'not_found';

  clearTimeout(entry.timer);
  pending.delete(toolUseId);
  resolvedIds.set(toolUseId, sessionId);
  entry.resolve(result.error !== undefined ? { error: result.error } : { output: result.output ?? null });
  return 'resolved';
}

/**
 * Return the declared tool name of a still-pending call owned by `sessionId`,
 * or undefined if no such call is parked. Read BEFORE resolveClientDeclaredTool
 * (which deletes the entry) so a resolved result can be persisted with its name.
 * Generic: carries no knowledge of any specific tool's semantics.
 */
export function peekClientDeclaredToolName(sessionId: string, toolUseId: string): string | undefined {
  const entry = pending.get(toolUseId);
  return entry && entry.sessionId === sessionId ? entry.toolName : undefined;
}

/** Fail + drain every parked call of a session on teardown. Returns the count. */
export function failPendingClientDeclaredForSession(sessionId: string, reason = 'session_closed'): number {
  let failed = 0;
  for (const [toolUseId, entry] of [...pending.entries()]) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    pending.delete(toolUseId);
    entry.resolve({ error: reason });
    failed++;
  }
  for (const [toolUseId, owner] of [...resolvedIds.entries()]) {
    if (owner === sessionId) resolvedIds.delete(toolUseId);
  }
  return failed;
}

/** Test-only visibility into the pending map. */
export function _pendingClientDeclaredCountForTests(): number {
  return pending.size;
}

// ============================================
// SDK MCP server construction
// ============================================

export type ClientDeclaredToolHandlerResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** A session-bound dispatcher: publish + park + await for one tool call. */
export type ClientToolDispatch = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ClientToolDispatchResult>;

function textResult(text: string, isError = false): ClientDeclaredToolHandlerResult {
  return { content: [{ type: 'text' as const, text }], isError };
}

/**
 * Build the SDK tool handler for one declared tool: dispatch to the client and
 * map its result to a CallToolResult. Extracted for direct unit testing.
 */
export function makeClientDeclaredToolHandler(toolName: string, dispatch: ClientToolDispatch) {
  return async (args: Record<string, unknown>): Promise<ClientDeclaredToolHandlerResult> => {
    const result = await dispatch(toolName, args ?? {});
    if (result.error !== undefined) {
      return textResult(result.error, true);
    }
    const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null);
    return textResult(text);
  };
}

/** Prefixed MCP tool names (the SDK allowlist) for a set of declarations. */
export function clientDeclaredToolMcpNames(decls: ClientToolDeclaration[]): string[] {
  return decls.map((d) => `mcp__${CLIENT_DECLARED_MCP_SERVER_NAME}__${d.name}`);
}

/**
 * Build the SDK MCP server from validated declarations. `dispatch` is bound to
 * the live session by the caller (see the helper chat route). Plug the returned
 * server into streamingSessionManager.getOrCreate via its mcpServerFactory
 * parameter (the clientAi/sessions.ts precedent).
 */
export function createClientDeclaredMcpServer(decls: ClientToolDeclaration[], dispatch: ClientToolDispatch) {
  return createSdkMcpServer({
    name: CLIENT_DECLARED_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: decls.map((decl) =>
      tool(
        decl.name,
        decl.description,
        jsonSchemaObjectToZodShape(decl.inputSchema),
        makeClientDeclaredToolHandler(decl.name, dispatch),
      ),
    ),
  });
}
