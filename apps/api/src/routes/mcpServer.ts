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

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { apiKeyAuthMiddleware, requireApiKeyScope } from '../middleware/apiKeyAuth';
import { getToolDefinitions, executeTool, getToolTier } from '../services/aiTools';
import { checkGuardrails, checkToolPermission, checkToolRateLimit } from '../services/aiGuardrails';
import { db } from '../db';
import { devices, alerts, scripts, automations } from '../db/schema';
import { eq, and, desc, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { writeAuditEvent } from '../services/auditEvents';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';

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

// All MCP routes require API key auth
mcpServerRoutes.use('*', apiKeyAuthMiddleware);

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

const sseSessionQueues = new Map<string, { queue: Array<JsonRpcResponse>; apiKeyId: string; createdAt: number }>();

mcpServerRoutes.get(
  '/sse',
  requireApiKeyScope('ai:read'),
  async (c) => {
    const apiKey = c.get('apiKey');

    // Rate limit SSE connections in production
    if (process.env.NODE_ENV === 'production') {
      const redis = getRedis();
      if (!redis) {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Service temporarily unavailable' } }, 503);
      }
      const limit = envInt('MCP_SSE_RATE_LIMIT_PER_MINUTE', 30);
      const rate = await rateLimiter(redis, `mcp:sse:${apiKey.id}`, limit, 60);
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
    const perKeyCount = Array.from(sseSessionQueues.values()).filter((s) => s.apiKeyId === apiKey.id).length;
    if (perKeyCount >= MAX_SSE_SESSIONS_PER_KEY) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many active MCP sessions for this API key' } }, 429);
    }

    const sessionId = crypto.randomUUID();

    // Initialize queue for this session with ownership info
    sseSessionQueues.set(sessionId, { queue: [], apiKeyId: apiKey.id, createdAt: Date.now() });

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
  requireApiKeyScope('ai:read'),
  async (c) => {
    const apiKey = c.get('apiKey');

    // Rate limit messages in production
    if (process.env.NODE_ENV === 'production') {
      const redis = getRedis();
      if (!redis) {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Service temporarily unavailable' } }, 503);
      }
      const limit = envInt('MCP_MESSAGE_RATE_LIMIT_PER_MINUTE', 120);
      const rate = await rateLimiter(redis, `mcp:msg:${apiKey.id}`, limit, 60);
      if (!rate.allowed) {
        const retryAfter = Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000));
        c.header('Retry-After', String(retryAfter));
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limit exceeded' } }, 429);
      }
    }

    const sessionId = c.req.query('sessionId');

    let body: JsonRpcRequest;
    try {
      body = await c.req.json<JsonRpcRequest>();
    } catch {
      return c.json({
        jsonrpc: '2.0' as const,
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' }
      }, 400);
    }

    if (!body.jsonrpc || body.jsonrpc !== '2.0' || !body.method) {
      return c.json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32600, message: 'Invalid JSON-RPC request' }
      } satisfies JsonRpcResponse, 400);
    }

    // Build a minimal AuthContext from the API key
    const auth = buildAuthFromApiKey(apiKey);

    const response = await handleJsonRpc(body, auth, apiKey.scopes);

    writeAuditEvent(c, {
      orgId: apiKey.orgId,
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
      if (session && session.apiKeyId === apiKey.id) {
        session.queue.push(response);
        // Return 202 Accepted — response will come via SSE
        return c.json({ status: 'accepted' }, 202);
      }
    }

    // Otherwise return inline (stateless HTTP mode)
    return c.json(response);
  }
);

// ============================================
// JSON-RPC Method Dispatcher
// ============================================

async function handleJsonRpc(
  req: JsonRpcRequest,
  auth: AuthContext,
  scopes: string[]
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
        return await handleToolsCall(req.id, req.params ?? {}, auth, scopes);

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
  const requireExecuteAdmin = process.env.NODE_ENV === 'production' && envFlag('MCP_REQUIRE_EXECUTE_ADMIN', false);
  const hasExecuteAdmin = scopes.includes('*') || scopes.includes('ai:execute_admin');
  const hasWrite = hasExecute || scopes.includes('ai:write');

  // Filter tools based on API key scopes
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

  return jsonRpcResult(id, {
    tools: filteredTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.input_schema
    }))
  });
}

// ============================================
// tools/call
// ============================================

async function handleToolsCall(
  id: string | number,
  params: Record<string, unknown>,
  auth: AuthContext,
  scopes: string[]
): Promise<JsonRpcResponse> {
  const toolName = params.name as string;
  const toolInput = (params.arguments ?? {}) as Record<string, unknown>;

  if (!toolName) {
    return jsonRpcError(id, -32602, 'Missing required parameter: name');
  }

  // Check scope-based access
  const tier = getToolTier(toolName);
  if (tier === undefined) {
    return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
  }

  const hasExecute = scopes.includes('*') || scopes.includes('ai:execute');
  const requireExecuteAdmin = process.env.NODE_ENV === 'production' && envFlag('MCP_REQUIRE_EXECUTE_ADMIN', false);
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
    } catch {
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
 * Build a minimal AuthContext from an API key.
 * API keys are always org-scoped (no partner/system access).
 */
function buildAuthFromApiKey(apiKey: { id: string; orgId: string; name: string; createdBy: string }): AuthContext {
  const orgId = apiKey.orgId;
  return {
    user: {
      id: apiKey.createdBy,
      email: `apikey-${apiKey.name}@breeze.local`,
      name: `API Key: ${apiKey.name}`
    },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (orgIdColumn) => eq(orgIdColumn, orgId),
    canAccessOrg: (checkOrgId) => checkOrgId === orgId
  };
}
