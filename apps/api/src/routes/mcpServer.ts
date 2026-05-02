/**
 * MCP Server Routes
 *
 * Exposes Breeze as an MCP (Model Context Protocol) server for external
 * Claude clients (Claude Desktop, Cursor, etc.).
 *
 * Transport: SSE (server→client) + HTTP POST (client→server)
 * Auth: API Key with ai:* scopes
 *
 * MCP JSON-RPC methods:
 *   - initialize
 *   - tools/list
 *   - tools/call
 *   - resources/list
 *   - resources/read
 */

import { Hono, type Context, type Next } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import { MCP_OAUTH_ENABLED, OAUTH_ISSUER } from '../config/env';
import { apiKeyAuthMiddleware, requireApiKeyScope } from '../middleware/apiKeyAuth';
import { bearerTokenAuthMiddleware } from '../middleware/bearerTokenAuth';
import { getToolDefinitions, executeTool, getToolTier } from '../services/aiTools';
import { checkGuardrails, checkToolPermission, checkToolRateLimit } from '../services/aiGuardrails';
import { db, withSystemDbAccessContext } from '../db';
import { devices, alerts, scripts, automations, partners, organizations, partnerUsers } from '../db/schema';
import { eq, and, asc, desc, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../middleware/auth';
import { writeAuditEvent } from '../services/auditEvents';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp } from '../services/clientIp';
import type { BootstrapTool } from '../modules/mcpInvites/types';
import { BootstrapError } from '../modules/mcpInvites/types';

export const mcpServerRoutes = new Hono();

function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const mcpExecuteToolAllowlist = parseCsvSet(process.env.MCP_EXECUTE_TOOL_ALLOWLIST);

function isExecuteToolAllowedInProd(toolName: string): boolean {
  if (mcpExecuteToolAllowlist.size === 0) return false;
  return mcpExecuteToolAllowlist.has('*') || mcpExecuteToolAllowlist.has(toolName);
}

function shouldRequireExecuteAdminInProd(): boolean {
  return process.env.NODE_ENV === 'production' && envFlag('MCP_REQUIRE_EXECUTE_ADMIN', true);
}

const MCP_MESSAGE_MAX_BODY_BYTES = envInt('MCP_MESSAGE_MAX_BODY_BYTES', 64 * 1024);

function setWwwAuthenticate(c: Context) {
  if (!MCP_OAUTH_ENABLED) return;
  const resourceUrl = `${OAUTH_ISSUER}/.well-known/oauth-protected-resource`;
  c.header('WWW-Authenticate', `Bearer realm="breeze", resource_metadata="${resourceUrl}"`);
}

function requestIp(c: Context | undefined): string | null {
  if (!c) return null;
  const ip = getTrustedClientIp(c, c.env?.incoming?.socket?.remoteAddress ?? 'unknown');
  return ip === 'unknown' ? null : ip;
}

async function readJsonRpcBodyWithLimit(
  req: Request,
  options: { clone: boolean },
): Promise<{ body?: unknown; tooLarge?: true; parseError?: true }> {
  const contentLength = req.headers.get('content-length');
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > MCP_MESSAGE_MAX_BODY_BYTES) {
      return { tooLarge: true };
    }
  }

  const source = options.clone ? req.clone() : req;
  if (!source.body) {
    return { parseError: true };
  }

  const reader = source.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let raw = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MCP_MESSAGE_MAX_BODY_BYTES) {
        return { tooLarge: true };
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { parseError: true };
  }
}

// ============================================
// Bootstrap module (authenticated tools only)
// ============================================

type BootstrapModule = { unauthTools: BootstrapTool<any, any>[]; authTools: BootstrapTool<any, any>[] };
let bootstrapModule: BootstrapModule | null = null;

async function loadBootstrapModuleInternal(): Promise<BootstrapModule> {
  const mod = await import('../modules/mcpInvites');
  return mod.initMcpBootstrap();
}

/**
 * Initialize the bootstrap module. Called from `apps/api/src/index.ts` during
 * startup. After Phase 3, the bootstrap module only contains auth tools
 * (send_deployment_invites, configure_defaults); the three unauth tools and
 * the IS_HOSTED flag-gate are gone.
 */
export async function initMcpBootstrapForStartup(): Promise<BootstrapModule | null> {
  bootstrapModule = await loadBootstrapModuleInternal();
  return bootstrapModule;
}

// Exposed for tests to force-load the module after vi.mock registration.
export async function __loadMcpBootstrapForTests(): Promise<BootstrapModule | null> {
  bootstrapModule = await loadBootstrapModuleInternal();
  return bootstrapModule;
}

/**
 * Minimal zod → JSON Schema converter covering the shapes used by bootstrap
 * tool input schemas (objects with string/enum/email fields). We don't pull
 * in `zod-to-json-schema` for one use-site; if future bootstrap tools need
 * richer shapes, swap this for the package.
 */
function zodToJsonSchema(schema: z.ZodSchema<any>): Record<string, unknown> {
  const def: any = (schema as any)._def;
  if (!def) return { type: 'object' };
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const child = value as z.ZodSchema<any>;
        properties[key] = zodToJsonSchema(child);
        const childDef: any = (child as any)._def;
        if (childDef?.typeName !== 'ZodOptional' && childDef?.typeName !== 'ZodDefault') {
          required.push(key);
        }
      }
      const out: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) out.required = required;
      return out;
    }
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' };
      for (const check of def.checks ?? []) {
        if (check.kind === 'email') out.format = 'email';
        if (check.kind === 'uuid') out.format = 'uuid';
        if (check.kind === 'min') out.minLength = check.value;
        if (check.kind === 'max') out.maxLength = check.value;
      }
      return out;
    }
    case 'ZodEnum':
      return { type: 'string', enum: [...def.values] };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray': {
      // Without this case, MCP clients (Claude.ai, ChatGPT) see `emails: {}` —
      // an unconstrained schema interpreted as `any`, and the client coerces
      // arrays to strings before validation. Surfaced via send_deployment_invites
      // when its `emails: z.array(z.string().email())` declared the array shape
      // but the converter dropped it.
      const out: Record<string, unknown> = {
        type: 'array',
        items: zodToJsonSchema(def.type),
      };
      for (const check of def.checks ?? []) {
        if (check.kind === 'min') out.minItems = check.value;
        if (check.kind === 'max') out.maxItems = check.value;
      }
      return out;
    }
    case 'ZodOptional':
    case 'ZodDefault':
      return zodToJsonSchema(def.innerType);
    default:
      return {};
  }
}

/**
 * MCP auth middleware.
 *
 * All callers must provide either an `Authorization: Bearer <token>` header
 * (OAuth 2.1 flow, when MCP_OAUTH_ENABLED) or an `X-API-Key` header.
 * Unauthenticated callers receive 401 + WWW-Authenticate.
 *
 * The bootstrap unauth carve-out (IS_HOSTED flag + create_tenant /
 * verify_tenant / attach_payment_method) was removed in Phase 3. The new
 * account-creation path is OAuth Create Account → /auth/register-partner.
 */
async function mcpAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization') ?? '';
  const hasBearer = MCP_OAUTH_ENABLED && authHeader.startsWith('Bearer ');
  if (hasBearer) {
    return bearerTokenAuthMiddleware(c, next);
  }

  const hasKey = Boolean(c.req.header('X-API-Key'));
  if (hasKey) {
    return apiKeyAuthMiddleware(c, next);
  }

  setWwwAuthenticate(c);
  return c.json(
    { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Missing X-API-Key header' } },
    401,
  );
}

// All MCP routes require authentication.
mcpServerRoutes.use('*', mcpAuthMiddleware);

// ============================================
// Types
// ============================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function buildMcpAuditAction(method: string): string {
  const normalized = method
    .toLowerCase()
    .replace(/[^a-z0-9/_.-]/g, '')
    .replace(/\//g, '.');
  return `mcp.${normalized || 'unknown'}`.slice(0, 100);
}

// ============================================
// SSE Transport — long-lived connection
// ============================================

// Active SSE sessions: sessionId → session data (queue, owner, TTL)
const MAX_SSE_SESSIONS = 100;
const MAX_SSE_SESSIONS_PER_KEY = envInt('MCP_MAX_SSE_SESSIONS_PER_KEY', 5);
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function mcpPrincipalKey(apiKey: { id: string; oauthGrantId?: string | null }): string {
  return apiKey.oauthGrantId ? `oauth-grant:${apiKey.oauthGrantId}` : apiKey.id;
}

const sseSessionQueues = new Map<string, { queue: Array<JsonRpcResponse>; principalKey: string; createdAt: number }>();

mcpServerRoutes.get(
  '/sse',
  requireApiKeyScope('ai:read'),
  async (c) => {
    const apiKey = c.get('apiKey');
    const principalKey = mcpPrincipalKey(apiKey);

    // Rate limit SSE connections in production
    if (process.env.NODE_ENV === 'production') {
      const redis = getRedis();
      if (!redis) {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Service temporarily unavailable' } }, 503);
      }
      const limit = envInt('MCP_SSE_RATE_LIMIT_PER_MINUTE', 30);
      const rate = await rateLimiter(redis, `mcp:sse:${principalKey}`, limit, 60);
      if (!rate.allowed) {
        const retryAfter = Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000));
        c.header('Retry-After', String(retryAfter));
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limit exceeded' } }, 429);
      }
    }

    // Cleanup stale sessions
    const now = Date.now();
    for (const [id, session] of sseSessionQueues) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        sseSessionQueues.delete(id);
      }
    }

    // Enforce max sessions limit
    if (sseSessionQueues.size >= MAX_SSE_SESSIONS) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many active MCP sessions' } }, 503);
    }

    // Enforce per-API-key session cap to reduce blast radius of a single leaked key.
    const perKeyCount = Array.from(sseSessionQueues.values()).filter((s) => s.principalKey === principalKey).length;
    if (perKeyCount >= MAX_SSE_SESSIONS_PER_KEY) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many active MCP sessions for this API key' } }, 429);
    }

    const sessionId = crypto.randomUUID();

    // Initialize queue for this session with ownership info
    sseSessionQueues.set(sessionId, { queue: [], principalKey, createdAt: Date.now() });

    return streamSSE(c, async (stream) => {
      // Send endpoint event so client knows where to POST messages
      const baseUrl = new URL(c.req.url);
      const messageUrl = `${baseUrl.protocol}//${baseUrl.host}${baseUrl.pathname.replace('/sse', '/message')}?sessionId=${sessionId}`;

      await stream.writeSSE({
        event: 'endpoint',
        data: messageUrl
      });

      // Poll for messages to send back to the client
      let alive = true;
      const cleanup = () => {
        alive = false;
        sseSessionQueues.delete(sessionId);
      };

      // Send keepalive pings
      const keepalive = setInterval(async () => {
        try {
          await stream.writeSSE({ event: 'ping', data: '' });
        } catch (err) {
          console.warn('[MCP] SSE keepalive failed, closing session:', sessionId, err);
          cleanup();
        }
      }, 30_000);

      try {
        while (alive) {
          const session = sseSessionQueues.get(sessionId);
          if (!session) break;

          if (session.queue.length > 0) {
            const messages = session.queue.splice(0, session.queue.length);
            for (const msg of messages) {
              await stream.writeSSE({
                event: 'message',
                data: JSON.stringify(msg)
              });
            }
          }

          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally {
        clearInterval(keepalive);
        cleanup();
      }
    });
  }
);

// ============================================
// HTTP POST Transport — JSON-RPC messages
// ============================================

mcpServerRoutes.post(
  '/message',
  async (c) => {
    const apiKey = c.get('apiKey');
    const principalKey = apiKey ? mcpPrincipalKey(apiKey) : null;

    // Rate limit messages in production.
    if (apiKey && process.env.NODE_ENV === 'production') {
      const redis = getRedis();
      if (!redis) {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Service temporarily unavailable' } }, 503);
      }
      const limit = envInt('MCP_MESSAGE_RATE_LIMIT_PER_MINUTE', 120);
      const rate = await rateLimiter(redis, `mcp:msg:${principalKey}`, limit, 60);
      if (!rate.allowed) {
        const retryAfter = Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000));
        c.header('Retry-After', String(retryAfter));
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limit exceeded' } }, 429);
      }
    }

    const sessionId = c.req.query('sessionId');

    const parsedBody = await readJsonRpcBodyWithLimit(c.req.raw, { clone: false });
    if (parsedBody.tooLarge) {
      return c.json({
        jsonrpc: '2.0' as const,
        id: null,
        error: { code: -32600, message: 'Request body too large' }
      }, 413);
    }
    if (parsedBody.parseError) {
      return c.json({
        jsonrpc: '2.0' as const,
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' }
      }, 400);
    }
    const body = parsedBody.body as JsonRpcRequest;

    if (!body.jsonrpc || body.jsonrpc !== '2.0' || !body.method) {
      return c.json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32600, message: 'Invalid JSON-RPC request' }
      } satisfies JsonRpcResponse, 400);
    }

    // All callers are authenticated (mcpAuthMiddleware enforces this).
    // Enforce ai:read scope.
    const hasAiRead = apiKey.scopes.includes('*') || apiKey.scopes.includes('ai:read');
    if (!hasAiRead) {
      return c.json(
        {
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: -32001, message: 'API key missing required scope: ai:read' },
        } satisfies JsonRpcResponse,
        403,
      );
    }

    // Build a minimal AuthContext from the API key
    const auth = await buildAuthFromApiKey(apiKey);

    const response = await handleJsonRpc(body, auth, apiKey.scopes, apiKey, c);

    // OAuth-bearer callers carry partner-scope tokens with apiKey.orgId=null
    // by design (partner admins span every org). Without the fallback, every
    // authed MCP audit event would lose org attribution and be invisible to
    // org-scoped audit searches. resolveDefaultOrgId mirrors what the
    // bootstrap-authTool dispatch does for the same reason.
    const auditOrgId =
      apiKey.orgId ??
      (auth.partnerId ? await resolveDefaultOrgId(auth.partnerId) : null);
    writeAuditEvent(c, {
      orgId: auditOrgId,
      actorType: 'api_key',
      actorId: apiKey.id,
      action: buildMcpAuditAction(body.method),
      resourceType: 'mcp_request',
      resourceId: sessionId,
      details: {
        method: body.method,
        hasSession: Boolean(sessionId),
        hasParams: Boolean(body.params)
      },
      result: response.error ? 'failure' : 'success',
      errorMessage: response.error?.message
    });

    // If there's an active SSE session, queue the response there (with ownership check)
    if (sessionId) {
      const session = sseSessionQueues.get(sessionId);
      if (session && session.principalKey === principalKey) {
        session.queue.push(response);
        // Return 202 Accepted — response will come via SSE
        return c.json({ status: 'accepted' }, 202);
      }
    }

    // Return inline (stateless HTTP mode)
    return c.json(response);
  }
);

// ============================================
// JSON-RPC Method Dispatcher
// ============================================

async function handleJsonRpc(
  req: JsonRpcRequest,
  auth: AuthContext,
  scopes: string[],
  apiKey?: { id: string; orgId: string | null },
  c?: Context,
): Promise<JsonRpcResponse> {
  try {
    switch (req.method) {
      case 'initialize':
        return jsonRpcResult(req.id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false }
          },
          serverInfo: {
            name: 'breeze-rmm',
            version: '1.0.0'
          }
        });

      case 'notifications/initialized':
        // Client acknowledgment — no response needed but return empty result
        return jsonRpcResult(req.id, {});

      case 'tools/list':
        return handleToolsList(req.id, scopes);

      case 'tools/call':
        return await handleToolsCall(req.id, req.params ?? {}, auth, scopes, apiKey, c);

      case 'resources/list':
        return handleResourcesList(req.id);

      case 'resources/read':
        return await handleResourcesRead(req.id, req.params ?? {}, auth);

      default:
        return jsonRpcError(req.id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[MCP] JSON-RPC handler error:', err);
    return jsonRpcError(req.id, -32000, message);
  }
}

// ============================================
// tools/list
// ============================================

function handleToolsList(id: string | number, scopes: string[]): JsonRpcResponse {
  const allTools = getToolDefinitions();
  const hasExecute = scopes.includes('*') || scopes.includes('ai:execute');
  const requireExecuteAdmin = shouldRequireExecuteAdminInProd();
  const hasExecuteAdmin = scopes.includes('*') || scopes.includes('ai:execute_admin');
  const hasWrite = hasExecute || scopes.includes('ai:write');

  // Filter tools based on API key scopes.
  const filteredTools = allTools.filter((tool) => {
    const tier = getToolTier(tool.name);
    if (tier === undefined) return false;

    // Tier 1 (read-only) = ai:read is enough
    if (tier <= 1) return true;
    // Tier 2 (low-risk mutations) = ai:write
    if (tier === 2) return hasWrite;
    // Tier 3+ (destructive) = ai:execute
    return hasExecute && (!requireExecuteAdmin || hasExecuteAdmin);
  });

  const result = filteredTools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.input_schema,
  }));

  // Surface bootstrap auth tools (send_deployment_invites, configure_defaults)
  // to authenticated callers with the matching scope. These tools live outside
  // the main aiTools registry but flow through the authed dispatch path below.
  if (bootstrapModule) {
    const authToolsEligible = hasExecute && (!requireExecuteAdmin || hasExecuteAdmin);
    if (authToolsEligible) {
      for (const tool of bootstrapModule.authTools) {
        result.push({
          name: tool.definition.name,
          description: tool.definition.description,
          inputSchema: zodToJsonSchema(tool.definition.inputSchema) as typeof result[number]['inputSchema'],
        });
      }
    }
  }

  return jsonRpcResult(id, { tools: result });
}

// ============================================
// tools/call
// ============================================

async function handleToolsCall(
  id: string | number,
  params: Record<string, unknown>,
  auth: AuthContext,
  scopes: string[],
  apiKey?: { id: string; orgId: string | null },
  c?: Context,
): Promise<JsonRpcResponse> {
  const toolName = params.name as string;
  const toolInput = (params.arguments ?? {}) as Record<string, unknown>;

  if (!toolName) {
    return jsonRpcError(id, -32602, 'Missing required parameter: name');
  }

  // Bootstrap auth tools (send_deployment_invites, configure_defaults) live
  // outside the main aiTools registry but dispatch through this authed path.
  const bootstrapAuthTool = bootstrapModule?.authTools.find(
    (t) => t.definition.name === toolName,
  );
  if (bootstrapAuthTool) {
    return dispatchBootstrapAuthTool(
      id,
      bootstrapAuthTool,
      toolInput,
      auth,
      scopes,
      apiKey,
      c,
    );
  }

  // Check scope-based access
  const tier = getToolTier(toolName);
  if (tier === undefined) {
    return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
  }

  const hasExecute = scopes.includes('*') || scopes.includes('ai:execute');
  const requireExecuteAdmin = shouldRequireExecuteAdminInProd();
  const hasExecuteAdmin = scopes.includes('*') || scopes.includes('ai:execute_admin');
  const hasWrite = hasExecute || scopes.includes('ai:write');

  if (tier >= 3 && !hasExecute) {
    return jsonRpcError(id, -32603, `Tool "${toolName}" requires ai:execute scope`);
  }
  if (tier >= 3 && requireExecuteAdmin && !hasExecuteAdmin) {
    return jsonRpcError(id, -32603, `Tool "${toolName}" requires ai:execute_admin scope in production`);
  }
  if (tier === 2 && !hasWrite) {
    return jsonRpcError(id, -32603, `Tool "${toolName}" requires ai:write scope`);
  }

  // In production, enforce tool allowlist for tier 3+ (destructive) tools
  if (tier >= 3 && process.env.NODE_ENV === 'production' && !isExecuteToolAllowedInProd(toolName)) {
    return jsonRpcError(id, -32603, `Tool "${toolName}" is not in MCP_EXECUTE_TOOL_ALLOWLIST for production`);
  }

  // Check guardrails
  const guardrailCheck = checkGuardrails(toolName, toolInput);
  if (!guardrailCheck.allowed) {
    return jsonRpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify({ error: guardrailCheck.reason }) }],
      isError: true
    });
  }

  // RBAC permission check
  try {
    const permError = await checkToolPermission(toolName, toolInput, auth);
    if (permError) {
      return jsonRpcError(id, -32603, permError);
    }
  } catch (err) {
    console.error('[MCP] Permission check failed for tool:', toolName, err);
    return jsonRpcError(id, -32000, 'Unable to verify permissions');
  }

  // Per-tool rate limit
  try {
    const rateLimitErr = await checkToolRateLimit(toolName, auth.user.id);
    if (rateLimitErr) {
      return jsonRpcError(id, -32000, rateLimitErr);
    }
  } catch (err) {
    console.error('[MCP] Tool rate limit check failed for:', toolName, err);
    return jsonRpcError(id, -32000, 'Unable to verify rate limits');
  }

  // MCP server auto-executes Tier 3 tools without approval — the API key holder
  // is trusted at the scope level. Approval flow is for interactive UI only.

  try {
    const result = await executeTool(toolName, toolInput, auth);

    // If result contains imageBase64, return it as an MCP image content block
    // so Claude can actually see the screenshot (instead of raw base64 in JSON text)
    try {
      const parsed = JSON.parse(result);
      if (parsed.imageBase64 && typeof parsed.imageBase64 === 'string') {
        const { imageBase64, ...metadata } = parsed;
        const content: Array<Record<string, unknown>> = [
          { type: 'image', data: imageBase64, mimeType: `image/${parsed.format || 'jpeg'}` },
        ];
        if (Object.keys(metadata).length > 0) {
          content.push({ type: 'text', text: JSON.stringify(metadata) });
        }
        return jsonRpcResult(id, { content });
      }
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        console.error('[MCP] Unexpected error parsing vision response:', err);
      }
      // Not JSON or no imageBase64 — fall through to text
    }

    return jsonRpcResult(id, {
      content: [{ type: 'text', text: result }]
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    return jsonRpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true
    });
  }
}

// ============================================
// Bootstrap authTool dispatch (authed path)
// ============================================

/**
 * Dispatch a bootstrap authTool (e.g. send_deployment_invites) from the authed
 * MCP path. Enforces the same scope/payment/allowlist gates as a tier-3 aiTool,
 * then builds a BootstrapContext from the API key + Hono request and invokes
 * the handler with the tool's own Zod-validated input.
 *
 * Errors are mapped 1:1 with the unauth bootstrap dispatch so callers see a
 * consistent shape whether they hit the pre- or post-activation path.
 */
async function dispatchBootstrapAuthTool(
  id: string | number,
  tool: BootstrapTool<any, any>,
  toolInput: Record<string, unknown>,
  auth: AuthContext,
  scopes: string[],
  apiKey: { id: string; orgId: string | null } | undefined,
  c: Context | undefined,
): Promise<JsonRpcResponse> {
  const hasExecute = scopes.includes('*') || scopes.includes('ai:execute');
  const requireExecuteAdmin = shouldRequireExecuteAdminInProd();
  const hasExecuteAdmin = scopes.includes('*') || scopes.includes('ai:execute_admin');

  if (!hasExecute) {
    return jsonRpcError(
      id,
      -32603,
      `Tool "${tool.definition.name}" requires ai:execute scope`,
    );
  }
  if (requireExecuteAdmin && !hasExecuteAdmin) {
    return jsonRpcError(
      id,
      -32603,
      `Tool "${tool.definition.name}" requires ai:execute_admin scope in production`,
    );
  }
  if (
    process.env.NODE_ENV === 'production' &&
    !isExecuteToolAllowedInProd(tool.definition.name)
  ) {
    return jsonRpcError(
      id,
      -32603,
      `Tool "${tool.definition.name}" is not in MCP_EXECUTE_TOOL_ALLOWLIST for production`,
    );
  }

  // Validate via the tool's own Zod schema (mirrors handleBootstrapToolsCall).
  const parsed = tool.definition.inputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return jsonRpcError(id, -32602, 'Invalid arguments', parsed.error.flatten());
  }

  if (!apiKey || !auth.partnerId) {
    return jsonRpcError(
      id,
      -32603,
      'Bootstrap authTool requires an authenticated session with a resolvable partner.',
    );
  }

  // Partner-scoped OAuth tokens correctly carry org_id=null because partner
  // admins span every org under their partner. Bootstrap authTools (e.g.
  // send_deployment_invites) still need a concrete orgId to write into.
  // Fall back to the partner's first-created org — same convention used by
  // configure_defaults / send_deployment_invites elsewhere. X-API-Key callers
  // already have apiKey.orgId set; this block only fires for OAuth bearers.
  let resolvedOrgId = apiKey.orgId;
  if (!resolvedOrgId) {
    resolvedOrgId = await resolveDefaultOrgId(auth.partnerId);
    if (!resolvedOrgId) {
      return jsonRpcError(
        id,
        -32603,
        'Partner has no organizations — create one before calling bootstrap authTools.',
      );
    }
  }

  // Look up partner billing email (used as the admin email in invite templates).
  let partnerAdminEmail = '';
  try {
    const [row] = await db
      .select({ billingEmail: partners.billingEmail })
      .from(partners)
      .where(eq(partners.id, auth.partnerId))
      .limit(1);
    partnerAdminEmail = row?.billingEmail ?? '';
  } catch (err) {
    console.error('[MCP] Failed to load partner billing email:', err);
  }

  const bootstrapCtx = {
    ip: requestIp(c),
    userAgent: c?.req.header('user-agent') ?? null,
    region: ((process.env.BREEZE_REGION as 'us' | 'eu') ?? 'us') as 'us' | 'eu',
    apiKey: {
      id: apiKey.id,
      partnerId: auth.partnerId,
      defaultOrgId: resolvedOrgId,
      partnerAdminEmail,
    },
  };

  try {
    const result = await tool.handler(parsed.data, bootstrapCtx);
    return jsonRpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    });
  } catch (err) {
    if (err instanceof BootstrapError) {
      return jsonRpcError(id, -32000, err.message, {
        code: err.code,
        remediation: err.remediation,
      });
    }
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    return jsonRpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    });
  }
}

// ============================================
// resources/list
// ============================================

function handleResourcesList(id: string | number): JsonRpcResponse {
  return jsonRpcResult(id, {
    resources: [
      {
        uri: 'breeze://devices',
        name: 'Device Inventory',
        description: 'List of all managed devices',
        mimeType: 'application/json'
      },
      {
        uri: 'breeze://alerts',
        name: 'Active Alerts',
        description: 'Currently active alerts across all devices',
        mimeType: 'application/json'
      },
      {
        uri: 'breeze://scripts',
        name: 'Script Library',
        description: 'Available scripts for execution',
        mimeType: 'application/json'
      },
      {
        uri: 'breeze://automations',
        name: 'Automation Rules',
        description: 'Configured automation rules',
        mimeType: 'application/json'
      }
    ]
  });
}

// ============================================
// resources/read
// ============================================

/**
 * Query a table with org-scoping and return a JSON-RPC resource result.
 */
async function readOrgScopedResource(
  id: string | number,
  uri: string,
  table: any,
  columns: Record<string, any>,
  orgCondition: ReturnType<AuthContext['orgCondition']>,
  options?: { extraConditions?: SQL[]; limit?: number; orderBy?: any }
): Promise<JsonRpcResponse> {
  const conditions: SQL[] = [...(options?.extraConditions || [])];
  if (orgCondition) conditions.push(orgCondition);
  let query = db.select(columns).from(table);
  const result = await (
    conditions.length > 0
      ? query.where(and(...conditions))
      : query
  )
    .limit(options?.limit ?? 50);

  return jsonRpcResult(id, {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }]
  });
}

async function handleResourcesRead(
  id: string | number,
  params: Record<string, unknown>,
  auth: AuthContext
): Promise<JsonRpcResponse> {
  const uri = params.uri as string;
  if (!uri) {
    return jsonRpcError(id, -32602, 'Missing required parameter: uri');
  }

  const orgCond = auth.orgCondition;

  try {
    if (uri === 'breeze://devices') {
      return await readOrgScopedResource(id, uri, devices, {
        id: devices.id,
        hostname: devices.hostname,
        status: devices.status,
        osType: devices.osType,
        osVersion: devices.osVersion,
        agentVersion: devices.agentVersion,
        lastSeenAt: devices.lastSeenAt
      }, orgCond(devices.orgId), { limit: 500 });
    }

    if (uri === 'breeze://alerts') {
      return await readOrgScopedResource(id, uri, alerts, {
        id: alerts.id,
        title: alerts.title,
        severity: alerts.severity,
        status: alerts.status,
        deviceId: alerts.deviceId,
        triggeredAt: alerts.triggeredAt
      }, orgCond(alerts.orgId), {
        extraConditions: [eq(alerts.status, 'active' as typeof alerts.status.enumValues[number])],
        limit: 200
      });
    }

    if (uri === 'breeze://scripts') {
      return await readOrgScopedResource(id, uri, scripts, {
        id: scripts.id,
        name: scripts.name,
        description: scripts.description,
        language: scripts.language,
        category: scripts.category
      }, orgCond(scripts.orgId), { limit: 200 });
    }

    if (uri === 'breeze://automations') {
      return await readOrgScopedResource(id, uri, automations, {
        id: automations.id,
        name: automations.name,
        description: automations.description,
        enabled: automations.enabled,
        trigger: automations.trigger
      }, orgCond(automations.orgId), { limit: 200 });
    }

    // Handle dynamic resource URIs: breeze://devices/{id}
    const deviceMatch = uri.match(/^breeze:\/\/devices\/([0-9a-f-]+)$/);
    if (deviceMatch?.[1]) {
      const deviceId = deviceMatch[1];
      const orgFilter = orgCond(devices.orgId);
      const conditions: SQL[] = [eq(devices.id, deviceId)];
      if (orgFilter) conditions.push(orgFilter);

      const [device] = await db
        .select()
        .from(devices)
        .where(and(...conditions))
        .limit(1);

      if (!device) {
        return jsonRpcError(id, -32602, `Device not found: ${deviceId}`);
      }

      return jsonRpcResult(id, {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(device, null, 2)
        }]
      });
    }

    return jsonRpcError(id, -32602, `Unknown resource URI: ${uri}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read resource';
    return jsonRpcError(id, -32603, message);
  }
}

// ============================================
// Helpers
// ============================================

function jsonRpcResult(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

/**
 * Resolve the partner's default (first-created) organization id. Mirrors the
 * convention used by configure_defaults / send_deployment_invites. Used to
 * scope partner.* audit events so query_audit_log surfaces them for the
 * partner's own MCP caller, and to default the bootstrap-authTool dispatch
 * orgId for partner-scoped OAuth tokens (which intentionally have org_id=null
 * since partner-admins span all orgs).
 *
 * Inlined here after activationRoutes.ts was deleted in Phase 4 — the only
 * remaining caller is this file.
 */
async function resolveDefaultOrgId(partnerId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, partnerId))
      .orderBy(asc(organizations.createdAt))
      .limit(1);
    return row?.id ?? null;
  } catch (err) {
    console.error('[mcpServer] failed to resolve default orgId for partner', partnerId, err);
    return null;
  }
}

/**
 * Resolve the concrete org allowlist a partner-scope caller can reach.
 * Mirrors `computeAccessibleOrgIds` in middleware/auth.ts and
 * `resolvePartnerAccessibleOrgIds` in middleware/bearerTokenAuth.ts. Kept
 * inline here to avoid widening auth.ts' export surface; the cost is ~25
 * duplicated lines, intentionally accepted per CLAUDE.md.
 *
 * Pre-auth lookup runs under withSystemDbAccessContext because RLS GUCs for
 * the request's real scope haven't been set yet.
 */
async function resolvePartnerAccessibleOrgIds(
  partnerId: string,
  userId: string,
): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const [membership] = await db
      .select({ orgAccess: partnerUsers.orgAccess, orgIds: partnerUsers.orgIds })
      .from(partnerUsers)
      .where(and(eq(partnerUsers.userId, userId), eq(partnerUsers.partnerId, partnerId)))
      .limit(1);

    if (!membership) return [];
    if (membership.orgAccess === 'none') return [];

    if (membership.orgAccess === 'selected') {
      const selected = (membership.orgIds ?? []).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      if (selected.length === 0) return [];
      const rows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.partnerId, partnerId), inArray(organizations.id, selected)));
      return rows.map((r) => r.id);
    }

    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, partnerId));
    return rows.map((r) => r.id);
  });
}

/**
 * Build a minimal AuthContext from an API key or OAuth-backed API key context.
 * API keys remain org-scoped; OAuth bearer tokens may be partner-scoped when
 * they carry a partner_id without an org_id.
 *
 * Defense-in-depth fix (M-B1): partner-scope callers used to receive
 * `accessibleOrgIds: null` + `orgCondition: () => undefined`, which is
 * the "system, no filter" shape — but `canAccessOrg: () => false`
 * contradicted that, leaving any code paths that switch on `canAccessOrg`
 * vs `orgCondition` in inconsistent states. Now we resolve the actual
 * partner→org list and use a proper inArray filter.
 */
async function buildAuthFromApiKey(apiKey: {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  createdBy: string;
}): Promise<AuthContext> {
  const user = {
    id: apiKey.createdBy,
    email: `apikey-${apiKey.name}@breeze.local`,
    name: `API Key: ${apiKey.name}`
  };

  if (apiKey.orgId) {
    return {
      user,
      token: {} as AuthContext['token'],
      partnerId: apiKey.partnerId,
      orgId: apiKey.orgId,
      scope: 'organization',
      accessibleOrgIds: [apiKey.orgId],
      orgCondition: (orgIdColumn) => eq(orgIdColumn, apiKey.orgId!),
      canAccessOrg: (checkOrgId) => checkOrgId === apiKey.orgId
    };
  }

  // Partner-scope caller (OAuth bearer token, or API key with no orgId).
  // Resolve the concrete org allowlist so orgCondition / canAccessOrg are
  // consistent and defense-in-depth filtering works alongside RLS.
  const accessibleOrgIds = apiKey.partnerId
    ? await resolvePartnerAccessibleOrgIds(apiKey.partnerId, apiKey.createdBy)
    : [];

  const orgCondition = (orgIdColumn: PgColumn): SQL | undefined => {
    if (accessibleOrgIds.length === 0) {
      // No accessible orgs — return an impossible condition so any query
      // using this filter matches no rows. Same pattern as auth.ts.
      return eq(orgIdColumn, '00000000-0000-0000-0000-000000000000');
    }
    if (accessibleOrgIds.length === 1) {
      return eq(orgIdColumn, accessibleOrgIds[0]);
    }
    return inArray(orgIdColumn, accessibleOrgIds);
  };

  return {
    user,
    token: {} as AuthContext['token'],
    partnerId: apiKey.partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds,
    orgCondition,
    canAccessOrg: (checkOrgId) => accessibleOrgIds.includes(checkOrgId),
  };
}
