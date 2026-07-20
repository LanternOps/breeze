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
 *   - prompts/list
 *   - prompts/get
 */

import { randomBytes } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { MCP_OAUTH_ENABLED, OAUTH_ISSUER } from '../config/env';
import { apiKeyAuthMiddleware, requireApiKeyScope } from '../middleware/apiKeyAuth';
import { bearerTokenAuthMiddleware, resolvePartnerAccessibleOrgIds } from '../middleware/bearerTokenAuth';
import { getToolDefinitions, executeTool, getToolTier } from '../services/aiTools';
import { checkGuardrails, checkToolPermission, checkToolRateLimit, checkPermissionRequirement } from '../services/aiGuardrails';
import { db } from '../db';
import { devices, alerts, scripts, automations, partners, organizations } from '../db/schema';
import { eq, and, asc, desc, inArray, isNull, or, getTableColumns, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../middleware/auth';
import { siteAccessCheck } from '../middleware/auth';
import { getUserPermissions } from '../services/permissions';
import { authorizeHumanApiKeyCreator, authorizeServicePrincipalKey } from '../services/apiKeyAuthorization';
import { getActiveOrgTenant } from '../services/tenantStatus';
import { resolveServerUrl } from '../services/recoveryBootstrap';
import { resolveSiteAllowedDeviceIds, deviceSiteDenied } from '../services/aiToolsSiteScope';
import { writeAuditEvent } from '../services/auditEvents';
import { sanitizeAuditPayload, summarizePayload, summarizeToolResult } from '../services/auditPayloadSanitizer';
import { compactToolResultForChat, redactAiToolOutputText } from '../services/aiToolOutput';
import { sanitizeThrownToolError } from '../services/aiToolErrors';
import { MCP_SERVER_INSTRUCTIONS, listMcpPrompts, getMcpPrompt, hasMcpPrompt } from '../services/mcpGuidance';
import {
  beginMcpToolExecutionLedger,
  completeMcpToolExecutionLedger,
  type McpToolExecutionLedgerHandle,
} from '../services/mcpToolExecutionLedger';
import { McpExecutionOrgError, resolveMcpExecutionContext } from './mcpExecutionOrg';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp } from '../services/clientIp';
import { enforceIpAllowlist, IP_NOT_ALLOWED_BODY, isBlocked } from '../services/ipAllowlist';
import { captureException } from '../services/sentry';
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
 * Convert a bootstrap tool's zod input schema to JSON Schema for `tools/list`,
 * using zod 4's native `z.toJSONSchema` with input semantics (a field carrying
 * a `.default()` is optional for the caller, so it stays out of `required`).
 *
 * The previous hand-rolled converter switched on `schema._def.typeName`, which
 * zod 4 removed — so every schema fell through to `{}`, an inputSchema with no
 * `type`. MCP clients reject that, and one bad tool schema fails the WHOLE
 * `tools/list` (Claude Code showed "fetching tools failed", 0 tools loaded).
 *
 * `$schema` is stripped: an MCP inputSchema is an embedded schema object, not a
 * standalone JSON Schema document.
 */
function zodToJsonSchema(schema: z.ZodSchema<any>): Record<string, unknown> {
  const { $schema: _dropped, ...jsonSchema } = z.toJSONSchema(schema, {
    io: 'input',
  }) as Record<string, unknown>;
  return jsonSchema;
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

type McpApiKeyContext = {
  id: string;
  orgId: string | null;
  partnerId?: string | null;
  oauthGrantId?: string | null;
};

type McpApiKeyWithAuthFields = McpApiKeyContext & {
  scopes: string[];
  name: string;
  createdBy: string;
  // SR2-15: 'human' (default, or absent for OAuth-bearer callers) | 'service'.
  // Set by apiKeyAuthMiddleware's `c.set('apiKey', ...)` for X-API-Key
  // callers; OAuth bearer tokens never carry it (they're always human) so
  // buildAuthFromApiKey treats an absent/undefined value as 'human'.
  principalType?: string;
  principalId?: string | null;
};

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
      let alive = true;
      let keepalive: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        alive = false;
        sseSessionQueues.delete(sessionId);
        if (keepalive) {
          clearInterval(keepalive);
          keepalive = undefined;
        }
      };
      stream.onAbort(cleanup);

      // Send endpoint event so client knows where to POST messages.
      //
      // The scheme/host come from the configured public base URL
      // (BREEZE_SERVER / PUBLIC_API_URL), NOT the raw request URL. Behind a
      // reverse proxy (e.g. Caddy) the inbound hop is plain http://, so deriving
      // the scheme from c.req.url emitted an http:// endpoint even on an https
      // deployment. We deliberately do NOT trust X-Forwarded-Proto/Host here —
      // matching the rest of the codebase's URL-emitting routes — to avoid host-
      // header injection. Self-hosters set PUBLIC_API_URL to their external URL.
      // The path is taken from the actual request so the /sse → /message mapping
      // stays correct regardless of mount point.
      const requestPath = new URL(c.req.url).pathname.replace('/sse', '/message');
      const messageUrl = `${resolveServerUrl(c.req.url)}${requestPath}?sessionId=${sessionId}`;

      await stream.writeSSE({
        event: 'endpoint',
        data: messageUrl
      });

      // Send keepalive pings
      keepalive = setInterval(async () => {
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
        cleanup();
      }
    });
  }
);

// ============================================
// HTTP POST Transport — JSON-RPC messages
// ============================================

type McpDispatchEarlyReturn = { kind: 'response'; status: number; body: unknown };
type McpDispatchOk = {
  kind: 'ok';
  body: JsonRpcRequest;
  sessionId: string | undefined;
};
type McpDispatchPreflight = McpDispatchEarlyReturn | McpDispatchOk;

/**
 * Shared preflight (rate limit, body parse, JSON-RPC validation, scope check)
 * for the legacy `/message` endpoint and the Streamable HTTP `/sse` POST
 * endpoint. Returns either an early `{ kind: 'response' }` (caller should
 * emit it as-is) or an `{ kind: 'ok' }` with the parsed body and sessionId.
 *
 * sessionId source differs between transports:
 *   - legacy: `?sessionId=` query param (set by SSE `endpoint` event)
 *   - streamable: `Mcp-Session-Id` header (set by server on initialize)
 */
async function preflightMcpRequest(
  c: Context,
  sessionId: string | undefined,
): Promise<McpDispatchPreflight> {
  const apiKey = c.get('apiKey') as
    | (McpApiKeyContext & { scopes: string[]; name?: string; createdBy?: string })
    | undefined;
  const principalKey = apiKey ? mcpPrincipalKey(apiKey) : null;

  if (apiKey && process.env.NODE_ENV === 'production') {
    const redis = getRedis();
    if (!redis) {
      return { kind: 'response', status: 503, body: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Service temporarily unavailable' } } };
    }
    const limit = envInt('MCP_MESSAGE_RATE_LIMIT_PER_MINUTE', 120);
    const rate = await rateLimiter(redis, `mcp:msg:${principalKey}`, limit, 60);
    if (!rate.allowed) {
      const retryAfter = Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfter));
      return { kind: 'response', status: 429, body: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limit exceeded' } } };
    }
  }

  const parsedBody = await readJsonRpcBodyWithLimit(c.req.raw, { clone: false });
  if (parsedBody.tooLarge) {
    return { kind: 'response', status: 413, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request body too large' } } };
  }
  if (parsedBody.parseError) {
    return { kind: 'response', status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } } };
  }
  const body = parsedBody.body as JsonRpcRequest;

  if (!body.jsonrpc || body.jsonrpc !== '2.0' || !body.method) {
    return { kind: 'response', status: 400, body: { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } } satisfies JsonRpcResponse };
  }

  if (!apiKey || !apiKey.scopes.includes('ai:read')) {
    return { kind: 'response', status: 403, body: { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32001, message: 'API key missing required scope: ai:read' } } satisfies JsonRpcResponse };
  }

  return { kind: 'ok', body, sessionId };
}

async function buildCheckedAuthFromApiKey(
  c: Context,
  apiKey: McpApiKeyWithAuthFields,
): Promise<AuthContext | Response> {
  const auth = await buildAuthFromApiKey({
    id: apiKey.id,
    orgId: apiKey.orgId,
    partnerId: apiKey.partnerId ?? null,
    name: apiKey.name,
    createdBy: apiKey.createdBy,
    scopes: apiKey.scopes,
    principalType: apiKey.principalType,
    principalId: apiKey.principalId ?? null,
  });

  // SR2-15 fail-closed: buildAuthFromApiKey returns null when the key's creator
  // has no resolvable authority for the owning org. Deny the request rather than
  // fabricate an all-sites org auth context.
  if (!auth) {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'API key creator has no access to this organization' },
      },
      403,
    );
  }

  if (auth.scope === 'partner' && auth.partnerId) {
    let decision;
    try {
      decision = await enforceIpAllowlist(c, {
        partnerId: auth.partnerId,
        isPlatformAdmin: auth.user?.isPlatformAdmin === true,
        actorId: auth.user?.id ?? null,
        actorEmail: auth.user?.email ?? null,
      });
    } catch (err) {
      console.error('[MCP] IP allowlist check failed for partner-scoped API key:', err);
      captureException(err, c);
      return c.json({ code: 'ip_check_failed', error: 'Access temporarily unavailable' }, 503);
    }

    if (isBlocked(decision)) {
      return c.json(IP_NOT_ALLOWED_BODY, 403);
    }
  }

  return auth;
}

async function dispatchAndAudit(
  c: Context,
  body: JsonRpcRequest,
  sessionId: string | undefined,
  auth: AuthContext,
  apiKey: McpApiKeyWithAuthFields,
): Promise<JsonRpcResponse> {
  const response = await handleJsonRpc(body, auth, apiKey.scopes, apiKey, c, sessionId);

  // OAuth-bearer callers carry partner-scope tokens with apiKey.orgId=null
  // by design (partner admins span every org). Without the fallback, every
  // authed MCP audit event would lose org attribution.
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
      hasParams: Boolean(body.params),
    },
    result: response.error ? 'failure' : 'success',
    errorMessage: response.error?.message,
  });

  return response;
}

mcpServerRoutes.post(
  '/message',
  async (c) => {
    const sessionIdFromQuery = c.req.query('sessionId');
    const pre = await preflightMcpRequest(c, sessionIdFromQuery);
    if (pre.kind === 'response') return c.json(pre.body, pre.status as 400 | 403 | 413 | 429 | 503);

    const apiKey = c.get('apiKey') as McpApiKeyWithAuthFields;
    const principalKey = mcpPrincipalKey(apiKey);

    // MED-1 follow-through: the streamable POST /sse handler hardens
    // Mcp-Session-Id binding, but /message also accepts a sessionId via the
    // query string and used to pass it straight into dispatchAndAudit. That
    // let an OAuth client POST /message?sessionId=<anything> and have the
    // attacker-supplied string land in audit_logs.resource_id and the tool
    // ledger transport_session_id — even though the response delivery path
    // below still required principal ownership. Validate the sessionId
    // BEFORE dispatch so the audit row never reflects a forged value.
    let trustedSessionId: string | undefined;
    if (pre.sessionId) {
      if (pre.sessionId.startsWith(MCP_SERVER_SESSION_PREFIX)) {
        // Server-minted (Streamable HTTP) id — verify ownership in Redis.
        const redis = getRedis();
        if (!redis) {
          // Cannot verify; refuse to attach the id rather than fail the call
          // outright (legacy SSE clients aren't expected here, but a missing
          // Redis shouldn't bubble up as a hard 503 either).
          trustedSessionId = undefined;
        } else {
          try {
            const stored = await redis.get(`${MCP_SESSION_REDIS_PREFIX}${pre.sessionId}`);
            if (stored === principalKey) {
              trustedSessionId = pre.sessionId;
            }
          } catch (err) {
            console.warn('[MCP] /message session lookup failed:', err);
          }
        }
      } else {
        // Legacy SSE sessionId (UUID from GET /sse). Only honor it if the
        // in-memory map confirms the caller owns the stream.
        const session = sseSessionQueues.get(pre.sessionId);
        if (session && session.principalKey === principalKey) {
          trustedSessionId = pre.sessionId;
        }
      }
    }

    const auth = await buildCheckedAuthFromApiKey(c, apiKey);
    if (auth instanceof Response) return auth;

    const response = await dispatchAndAudit(c, pre.body, trustedSessionId, auth, apiKey);

    // Legacy SSE transport: if the request carries a verified-owned sessionId
    // pointing at an active SSE stream, push the response into that stream
    // and return 202. Streamable HTTP clients don't reach this branch (they
    // POST to /sse).
    if (trustedSessionId) {
      const session = sseSessionQueues.get(trustedSessionId);
      if (session && session.principalKey === principalKey) {
        session.queue.push(response);
        return c.json({ status: 'accepted' }, 202);
      }
    }

    return c.json(response);
  }
);

// ============================================
// Streamable HTTP transport (MCP 2025-03-26)
// ============================================
// Single-URL transport: POST /sse delivers the JSON-RPC request and the
// response comes back inline as application/json. GET /sse is left as the
// legacy SSE handler above for backward compatibility with older clients;
// new clients (Claude.ai, ChatGPT) only use POST. DELETE /sse terminates a
// session (no-op here — sessions are stateless).
//
// Session ID, when present, comes from the `Mcp-Session-Id` request header.
// On `initialize` we mint a server-side ID (prefixed `mcp-`), persist
// `(sessionId → principalKey)` in Redis, and return it in the same header.
// Subsequent calls MUST present that server-minted ID and the stored
// principalKey must match the caller's principalKey — otherwise the request
// is rejected. This prevents an attacker from stamping arbitrary
// `Mcp-Session-Id` values to muddy audit triage or merge their activity
// into another principal's session (audit finding MCP MED-1).
//
// The minted-session map is keyed in Redis under MCP_SESSION_PREFIX with a
// short TTL (matches OAuth access-token lifetime plus a small buffer).
const MCP_SESSION_REDIS_PREFIX = 'mcp-session:';
const MCP_SERVER_SESSION_PREFIX = 'mcp-';
const MCP_SESSION_TTL_SECONDS = envInt('MCP_SESSION_TTL_SECONDS', 11 * 60);

function mintMcpSessionId(): string {
  return `${MCP_SERVER_SESSION_PREFIX}${randomBytes(16).toString('hex')}`;
}

mcpServerRoutes.post(
  '/sse',
  async (c) => {
    const sessionIdFromHeader = c.req.header('Mcp-Session-Id') || undefined;
    // NOTE: we do NOT pass the client-supplied header into preflight as a
    // trusted sessionId — the resolved sessionId is determined below after
    // body parsing and after we know whether this is an `initialize` call.
    const pre = await preflightMcpRequest(c, undefined);
    if (pre.kind === 'response') return c.json(pre.body, pre.status as 400 | 403 | 413 | 429 | 503);

    const apiKey = c.get('apiKey') as McpApiKeyWithAuthFields;
    const principalKey = mcpPrincipalKey(apiKey);
    const isInitialize = pre.body.method === 'initialize';
    const redis = getRedis();

    let trustedSessionId: string | undefined;
    if (isInitialize) {
      // Ignore any client-supplied Mcp-Session-Id on initialize. The server
      // mints the canonical id and (best-effort) persists ownership.
      trustedSessionId = mintMcpSessionId();
      if (redis) {
        try {
          await redis.setex(
            `${MCP_SESSION_REDIS_PREFIX}${trustedSessionId}`,
            MCP_SESSION_TTL_SECONDS,
            principalKey,
          );
        } catch (err) {
          // If Redis is unreachable we still mint the id — subsequent calls
          // will fail closed (no stored principal → 403), which is the
          // correct safety behavior.
          console.warn('[MCP] Failed to persist Mcp-Session-Id mapping:', err);
        }
      }
    } else {
      // Non-initialize: require a server-prefixed Mcp-Session-Id header.
      if (!sessionIdFromHeader || !sessionIdFromHeader.startsWith(MCP_SERVER_SESSION_PREFIX)) {
        return c.json(
          {
            jsonrpc: '2.0',
            id: pre.body.id ?? null,
            error: { code: -32600, message: 'Mcp-Session-Id header required (must be server-minted on initialize)' },
          },
          400,
        );
      }
      // If Redis is configured, look up ownership and require principal match.
      // If Redis is unavailable we cannot verify ownership; fail closed.
      if (!redis) {
        return c.json(
          {
            jsonrpc: '2.0',
            id: pre.body.id ?? null,
            error: { code: -32000, message: 'MCP session store unavailable' },
          },
          503,
        );
      }
      let storedPrincipal: string | null = null;
      try {
        storedPrincipal = await redis.get(`${MCP_SESSION_REDIS_PREFIX}${sessionIdFromHeader}`);
      } catch (err) {
        console.warn('[MCP] Failed to read Mcp-Session-Id mapping:', err);
        return c.json(
          {
            jsonrpc: '2.0',
            id: pre.body.id ?? null,
            error: { code: -32000, message: 'MCP session store unavailable' },
          },
          503,
        );
      }
      if (!storedPrincipal || storedPrincipal !== principalKey) {
        return c.json(
          {
            jsonrpc: '2.0',
            id: pre.body.id ?? null,
            error: { code: -32001, message: 'Mcp-Session-Id principal mismatch' },
          },
          403,
        );
      }
      trustedSessionId = sessionIdFromHeader;
    }

    // Echo the server-trusted session id back to the client so they can
    // include it on subsequent requests (and so clients can observe the
    // server-minted value on initialize).
    c.header('Mcp-Session-Id', trustedSessionId);

    // JSON-RPC notifications (no `id`) — process for side effects, return 202
    // with empty body per Streamable HTTP spec; do not emit a response body.
    const auth = await buildCheckedAuthFromApiKey(c, apiKey);
    if (auth instanceof Response) return auth;

    if (pre.body.id === undefined) {
      void dispatchAndAudit(c, pre.body, trustedSessionId, auth, apiKey).catch((err) => {
        console.error('[MCP] notification handler error:', err);
      });
      return c.body(null, 202);
    }

    const response = await dispatchAndAudit(c, pre.body, trustedSessionId, auth, apiKey);
    return c.json(response);
  }
);

mcpServerRoutes.delete('/sse', (c) => {
  // Streamable HTTP DELETE — terminate session. Stateless server, so 204.
  return c.body(null, 204);
});

// ============================================
// JSON-RPC Method Dispatcher
// ============================================

export function buildInitializeResult() {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    },
    serverInfo: {
      name: 'breeze-rmm',
      version: '1.0.0',
    },
    instructions: MCP_SERVER_INSTRUCTIONS,
  };
}

async function handleJsonRpc(
  req: JsonRpcRequest,
  auth: AuthContext,
  scopes: string[],
  apiKey?: McpApiKeyContext,
  c?: Context,
  sessionId?: string,
): Promise<JsonRpcResponse> {
  try {
    switch (req.method) {
      case 'initialize':
        return jsonRpcResult(req.id, buildInitializeResult());

      case 'notifications/initialized':
        // Client acknowledgment — no response needed but return empty result
        return jsonRpcResult(req.id, {});

      case 'tools/list':
        return handleToolsList(req.id, scopes);

      case 'tools/call':
        return await handleToolsCall(req.id, req.params ?? {}, auth, scopes, apiKey, c, sessionId);

      case 'resources/list':
        return handleResourcesList(req.id);

      case 'resources/read':
        return await handleResourcesRead(req.id, req.params ?? {}, auth);

      case 'prompts/list':
        return handlePromptsList(req.id);

      case 'prompts/get':
        return handlePromptsGet(req.id, req.params ?? {});

      default:
        return jsonRpcError(req.id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    // Raw driver text must not reach an MCP client (#2603).
    const message = sanitizeThrownToolError('mcp_jsonrpc', err, { method: req.method });
    return jsonRpcError(req.id, -32000, message);
  }
}

// ============================================
// tools/list
// ============================================

function handleToolsList(id: string | number, scopes: string[]): JsonRpcResponse {
  const allTools = getToolDefinitions();
  const hasExecute = scopes.includes('ai:execute');
  const requireExecuteAdmin = shouldRequireExecuteAdminInProd();
  const hasExecuteAdmin = scopes.includes('ai:execute_admin');
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
  apiKey?: McpApiKeyContext,
  c?: Context,
  sessionId?: string,
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
      sessionId,
    );
  }

  // Check scope-based access
  const baseTier = getToolTier(toolName);
  if (baseTier === undefined) {
    return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
  }

  // Run guardrails BEFORE the scope gates so the EFFECTIVE tier (which a
  // per-action escalation can raise above the tool's static base tier — e.g.
  // registry_operations base tier 1 but action:'delete_key' → tier 3) drives
  // the scope gates, the production allowlist, the execute_admin lever, AND
  // the ledger-creation condition below. checkGuardrails is pure (input-only,
  // no auth-context or DB side effects), so reordering is safe. Without this,
  // a destructive sub-action on a low-base-tier tool would sail past the gates
  // on an ai:read-only key.
  const guardrailCheck = checkGuardrails(toolName, toolInput);
  if (!guardrailCheck.allowed) {
    return jsonRpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify({ error: guardrailCheck.reason }) }],
      isError: true
    });
  }

  // Effective tier = max of the tool's static base tier and any per-action
  // escalation from guardrails. checkGuardrails can also DOWNGRADE a sub-action
  // (a read-only action on a high-base-tier tool returns tier 1 via
  // TIER1_ACTIONS); Math.max DELIBERATELY ignores those downgrades so a
  // sub-action can never weaken the scope requirement below the tool's static
  // base tier. Do not "fix" this to honor the guardrail tier directly — that
  // would silently weaken the gate.
  //
  // Fail CLOSED on a malformed guardrail tier: if checkGuardrails ever returns
  // a non-finite tier (unreachable given current types, but a security gate
  // must not fall through to the permissive base tier on a partial result),
  // DENY rather than silently dropping to baseTier.
  if (!Number.isFinite(guardrailCheck.tier)) {
    console.error('[MCP] Guardrail check returned a non-finite tier for tool:', toolName, guardrailCheck.tier);
    return jsonRpcError(id, -32000, 'Unable to evaluate tool guardrails');
  }
  const tier = Math.max(baseTier, guardrailCheck.tier);

  const hasExecute = scopes.includes('ai:execute');
  const requireExecuteAdmin = shouldRequireExecuteAdminInProd();
  const hasExecuteAdmin = scopes.includes('ai:execute_admin');
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

  // Authoritative execution org (MCP-OAUTH-05): for device-targeted tools this
  // is resolved from the TARGETED DEVICES via the org+site access gate — NOT
  // accessibleOrgIds[0] — so ledger, audit, and the handler all attribute to the
  // device's true org. Mixed-org device arrays / conflicting orgId / inaccessible
  // devices / org-pinned callers reaching outside their org are rejected here,
  // BEFORE any ledger or audit mutation. Non-device tools keep prior behavior.
  let executionOrgId: string | null;
  try {
    ({ orgId: executionOrgId } = await resolveMcpExecutionContext({ auth, apiKey: apiKey ?? null, toolName, toolInput }));
  } catch (err) {
    if (err instanceof McpExecutionOrgError) {
      return jsonRpcError(id, -32602, 'Invalid params');
    }
    console.error('[MCP] Failed to resolve execution org for tool:', toolName, err);
    return jsonRpcError(id, -32000, 'Unable to resolve execution organization');
  }
  // Shared Tier 3 lifecycle (MCP-OAUTH-12): ledger (fail closed) → handler →
  // complete + uniform audit. The callback owns executeTool + the MCP response
  // shape (including the image content-block special case) and classifies its
  // own success/failure; the wrapper owns the ledger + audit for both outcomes.
  const execute = async (): Promise<Tier3ExecutionOutcome> => {
    try {
      const result = await executeTool(toolName, toolInput, auth);
      const safeResult = compactToolResultForChat(toolName, result);

      // If result contains imageBase64, return it as an MCP image content block
      // so Claude can actually see the screenshot (instead of raw base64 in JSON text)
      let response: JsonRpcResponse;
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
          response = jsonRpcResult(id, { content });
        } else {
          response = jsonRpcResult(id, { content: [{ type: 'text', text: safeResult }] });
        }
      } catch (err) {
        if (!(err instanceof SyntaxError)) {
          console.error('[MCP] Unexpected error parsing vision response:', err);
        }
        // Not JSON or no imageBase64 — fall through to text
        response = jsonRpcResult(id, { content: [{ type: 'text', text: safeResult }] });
      }

      return { status: 'success', ledgerResult: safeResult, response };
    } catch (err) {
      const message = sanitizeThrownToolError(toolName, err);
      const safeError = compactToolResultForChat(toolName, JSON.stringify({ error: message }));
      return {
        status: 'failure',
        error: err,
        response: jsonRpcResult(id, { content: [{ type: 'text', text: safeError }], isError: true }),
      };
    }
  };

  return runTier3ToolLifecycle(
    { id, c, auth, apiKey, sessionId, orgId: executionOrgId, toolName, tier, toolInput },
    execute,
  );
}

function writeMcpToolAuditEvent(
  c: Context | undefined,
  event: {
    apiKey?: McpApiKeyContext;
    auth: AuthContext;
    sessionId?: string;
    orgId?: string | null;
    toolName: string;
    tier: number;
    toolInput: Record<string, unknown>;
    durationMs: number;
    status: 'success' | 'failure';
    result?: string;
    error?: unknown;
  },
): void {
  if (!c || !event.apiKey) return;

  const error = event.error instanceof Error ? event.error : undefined;
  // event.orgId is the authoritative execution org (resolveMcpExecutionContext).
  // NEVER fall back to a raw client-supplied toolInput.orgId here — doing so
  // would let a partner-scoped caller forge cross-tenant audit_logs attribution
  // (audit rows are written under the RLS-bypassed system context).
  const orgId = event.orgId ?? event.apiKey.orgId ?? event.auth.orgId ?? null;
  writeAuditEvent(c, {
    orgId,
    actorType: 'api_key',
    actorId: event.apiKey.id,
    action: `mcp.tool.${event.toolName}`.slice(0, 100),
    resourceType: 'mcp_tool_execution',
    resourceId: event.sessionId,
    result: event.status === 'success' ? 'success' : 'failure',
    errorMessage: error ? redactAiToolOutputText(error.message).slice(0, 1000) : undefined,
    details: {
      sessionId: event.sessionId ?? null,
      approvalId: null,
      oauthGrantId: event.apiKey.oauthGrantId ?? null,
      partnerId: event.auth.partnerId ?? event.apiKey.partnerId ?? null,
      orgId: orgId ?? null,
      toolName: event.toolName,
      tier: event.tier,
      target: summarizePayload(event.toolInput, { maxStringLength: 512 }),
      arguments: sanitizeAuditPayload(event.toolInput, { maxStringLength: 2048 }),
      durationMs: event.durationMs,
      ...(event.result ? { result: summarizeToolResult(event.result, { maxStringLength: 500 }) } : {}),
      ...(error ? { errorClass: error.name } : {}),
    },
  });
}

// ============================================
// Shared Tier 3 execution lifecycle (MCP-OAUTH-12)
// ============================================

// Bootstrap tools are destructive tenant mutations (send invites / configure
// defaults) and always run through the Tier 3 ledger + uniform audit.
const BOOTSTRAP_TOOL_TIER = 3;

interface Tier3LifecycleContext {
  id: string | number;
  c: Context | undefined;
  auth: AuthContext;
  apiKey: McpApiKeyContext | undefined;
  sessionId: string | undefined;
  /** Authoritative execution org (resolveMcpExecutionContext / bootstrap default). */
  orgId: string | null;
  toolName: string;
  tier: number;
  toolInput: Record<string, unknown>;
}

interface Tier3ExecutionOutcome {
  status: 'success' | 'failure';
  /**
   * Summarized result string recorded on the ledger + uniform audit on SUCCESS.
   * Mirrors the ordinary path, which records `result` on success and `error`
   * (not result) on failure.
   */
  ledgerResult?: string;
  /** On failure: an Error (thrown or a partial-failure marker) for errorClass/message. */
  error?: unknown;
  response: JsonRpcResponse;
}

/**
 * Shared Tier 3 begin/execute/complete/audit lifecycle (MCP-OAUTH-12). Used by
 * BOTH the ordinary tools/call path and the bootstrap authTool dispatch so the
 * fail-closed ledger and uniform `mcp.tool.<name>` audit are identical for every
 * Tier 3 mutation.
 *
 * Ordering (preserves Task 6's resolution → ledger → handler → complete+audit):
 *   1. create the execution ledger BEFORE the mutation; fail CLOSED if creation
 *      fails (the handler never runs without a durable ledger row);
 *   2. run the `execute` callback (which owns path-specific response construction
 *      AND classifies its own success/partial-failure/thrown-failure outcome);
 *   3. complete the ledger with the outcome status + duration; and
 *   4. write the uniform `mcp.tool.<name>` audit for BOTH outcomes.
 *
 * Tiers below 3 skip the ledger (as the ordinary path always has) but still emit
 * the uniform audit. The wrapper NEVER skips the ledger for a Tier 3 tool because
 * the principal is inconvenient — OAuth bearers already carry a synthetic
 * `apiKey` context (`oauth:<jti>`), exactly like ordinary Tier 3 bearer calls.
 */
async function runTier3ToolLifecycle(
  ctx: Tier3LifecycleContext,
  execute: () => Promise<Tier3ExecutionOutcome>,
): Promise<JsonRpcResponse> {
  let ledgerHandle: McpToolExecutionLedgerHandle | null = null;
  if (ctx.tier >= 3) {
    if (!ctx.apiKey || !ctx.orgId) {
      return jsonRpcError(ctx.id, -32000, 'Unable to create MCP tool execution ledger');
    }
    try {
      ledgerHandle = await beginMcpToolExecutionLedger({
        orgId: ctx.orgId,
        accessibleOrgIds: ctx.auth.accessibleOrgIds,
        toolName: ctx.toolName,
        tier: ctx.tier,
        toolInput: ctx.toolInput,
        transportSessionId: ctx.sessionId ?? null,
        principal: {
          apiKeyId: ctx.apiKey.id,
          oauthGrantId: ctx.apiKey.oauthGrantId ?? null,
          partnerId: ctx.auth.partnerId ?? ctx.apiKey.partnerId ?? null,
          actorUserId: ctx.auth.user.id,
        },
      });
    } catch (err) {
      console.error('[MCP] Failed to create tool execution ledger:', ctx.toolName, err);
      return jsonRpcError(ctx.id, -32000, 'Unable to create MCP tool execution ledger');
    }
  }

  const startedAt = Date.now();
  let outcome: Tier3ExecutionOutcome;
  try {
    outcome = await execute();
  } catch (err) {
    // The execute callback is expected to classify its own outcome and never
    // throw. This defensive net STILL completes the ledger + audit (never skip
    // them) before surfacing a generic error.
    console.error('[MCP] Unexpected throw from Tier 3 execute callback:', ctx.toolName, err);
    const failureResponse = jsonRpcError(ctx.id, -32000, 'Tool execution failed');
    await finalizeTier3ToolLifecycle(
      ctx,
      ledgerHandle,
      { status: 'failure', error: err, response: failureResponse },
      Date.now() - startedAt,
    );
    return failureResponse;
  }

  await finalizeTier3ToolLifecycle(ctx, ledgerHandle, outcome, Date.now() - startedAt);
  return outcome.response;
}

async function finalizeTier3ToolLifecycle(
  ctx: Tier3LifecycleContext,
  ledgerHandle: McpToolExecutionLedgerHandle | null,
  outcome: Tier3ExecutionOutcome,
  durationMs: number,
): Promise<void> {
  if (ledgerHandle) {
    await completeMcpToolExecutionLedger({
      handle: ledgerHandle,
      status: outcome.status,
      durationMs,
      result: outcome.status === 'success' ? outcome.ledgerResult : undefined,
      error: outcome.status === 'failure' ? outcome.error : undefined,
    }).catch((err) => {
      console.error('[MCP] Failed to complete tool execution ledger:', ctx.toolName, err);
    });
  }
  writeMcpToolAuditEvent(ctx.c, {
    apiKey: ctx.apiKey,
    auth: ctx.auth,
    sessionId: ctx.sessionId,
    orgId: ctx.orgId,
    toolName: ctx.toolName,
    tier: ctx.tier,
    toolInput: ctx.toolInput,
    durationMs,
    status: outcome.status,
    result: outcome.status === 'success' ? outcome.ledgerResult : undefined,
    error: outcome.status === 'failure' ? outcome.error : undefined,
  });
}

/**
 * Bootstrap handlers return best-effort results: `send_deployment_invites`
 * reports per-invite `failures`, `configure_defaults` reports per-step `errors`.
 * A non-throwing result carrying any such entries is a PARTIAL FAILURE, not a
 * success — classify it explicitly so the shared ledger/audit records the true
 * outcome rather than treating every non-throw as success.
 */
export function classifyBootstrapToolResult(result: unknown): 'success' | 'failure' {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.failures) && r.failures.length > 0) return 'failure';
    if (Array.isArray(r.errors) && r.errors.length > 0) return 'failure';
  }
  return 'success';
}

function bootstrapPartialFailureError(result: unknown): Error {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const failures = Array.isArray(r.failures) ? r.failures.length : 0;
  const errors = Array.isArray(r.errors) ? r.errors.length : 0;
  const parts: string[] = [];
  if (failures > 0) parts.push(`${failures} recipient failure(s)`);
  if (errors > 0) parts.push(`${errors} step error(s)`);
  return new Error(`bootstrap partial failure: ${parts.join(', ') || 'unknown'}`);
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
  apiKey: McpApiKeyContext | undefined,
  c: Context | undefined,
  sessionId: string | undefined,
): Promise<JsonRpcResponse> {
  const hasExecute = scopes.includes('ai:execute');
  const requireExecuteAdmin = shouldRequireExecuteAdminInProd();
  const hasExecuteAdmin = scopes.includes('ai:execute_admin');

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

  // Product RBAC (MCP-OAUTH-11): bootstrap authTools carry a TOOL_PERMISSIONS
  // mapping and are gated exactly like ordinary tools/call tools. This applies
  // REGARDLESS of MCP_REQUIRE_EXECUTE_ADMIN — that lever is an ADDITIONAL
  // production gate above, not a replacement for product permissions. Checked
  // BEFORE the Zod parse, the ledger, and the handler, so a denial never records
  // a ledger row or mutates anything (reject precedes ledger).
  try {
    const permError = await checkToolPermission(tool.definition.name, toolInput, auth);
    if (permError) {
      return jsonRpcError(id, -32603, permError);
    }
  } catch (err) {
    console.error('[MCP] Permission check failed for bootstrap tool:', tool.definition.name, err);
    return jsonRpcError(id, -32000, 'Unable to verify permissions');
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

  // Shared Tier 3 lifecycle (MCP-OAUTH-12): ledger (fail closed) → handler →
  // complete + uniform `mcp.tool.<name>` audit. The handler's own business
  // audits + dedup (per-invite events, configure_defaults audit, 24h dedupe)
  // remain intact; this wraps them with the fail-closed ledger + uniform audit.
  const execute = async (): Promise<Tier3ExecutionOutcome> => {
    try {
      const result = await tool.handler(parsed.data, bootstrapCtx);
      const status = classifyBootstrapToolResult(result);
      const resultText = JSON.stringify(result);
      return {
        status,
        ledgerResult: resultText,
        error: status === 'failure' ? bootstrapPartialFailureError(result) : undefined,
        response: jsonRpcResult(id, { content: [{ type: 'text', text: resultText }] }),
      };
    } catch (err) {
      if (err instanceof BootstrapError) {
        return {
          status: 'failure',
          error: err,
          response: jsonRpcError(id, -32000, err.message, {
            code: err.code,
            remediation: err.remediation,
          }),
        };
      }
      const message = sanitizeThrownToolError(tool.definition.name, err);
      return {
        status: 'failure',
        error: err,
        response: jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
          isError: true,
        }),
      };
    }
  };

  return runTier3ToolLifecycle(
    {
      id,
      c,
      auth,
      apiKey,
      sessionId,
      orgId: resolvedOrgId,
      toolName: tool.definition.name,
      tier: BOOTSTRAP_TOOL_TIER,
      toolInput,
    },
    execute,
  );
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
// prompts/list, prompts/get
// ============================================

export function handlePromptsList(id: string | number): JsonRpcResponse {
  return jsonRpcResult(id, { prompts: listMcpPrompts() });
}

export function handlePromptsGet(id: string | number, params: Record<string, unknown>): JsonRpcResponse {
  const name = params.name as string | undefined;
  if (!name) return jsonRpcError(id, -32602, 'Missing required parameter: name');
  if (!hasMcpPrompt(name)) return jsonRpcError(id, -32602, `Unknown prompt: ${name}`);
  const args = (params.arguments as Record<string, string>) ?? {};
  try {
    return jsonRpcResult(id, getMcpPrompt(name, args));
  } catch {
    // The prompt exists but rendering blew up — that's an internal fault, not a bad request.
    return jsonRpcError(id, -32603, `Failed to render prompt: ${name}`);
  }
}

// ============================================
// resources/read
// ============================================

/**
 * MCP-OAUTH-03: fail-closed resource RBAC. `resources/read` previously
 * enforced MCP auth + general scope + tenant RLS filtering, but never mapped
 * the requested resource URI to a product permission the way `tools/call`
 * does via checkToolPermission — so a role missing e.g. `devices.read` could
 * still read device/alert/script/automation data through resources/read.
 * This ordered pattern list is the fail-closed authorization boundary:
 * handleResourcesRead consults it BEFORE any site resolution or DB query.
 * Unknown URI families (no pattern match) are denied.
 */
const MCP_RESOURCE_PERMISSIONS: Array<{ pattern: RegExp; permission: { resource: string; action: 'read' } }> = [
  { pattern: /^breeze:\/\/devices$/, permission: { resource: 'devices', action: 'read' } },
  { pattern: /^breeze:\/\/devices\/[0-9a-f-]+$/, permission: { resource: 'devices', action: 'read' } },
  { pattern: /^breeze:\/\/alerts$/, permission: { resource: 'alerts', action: 'read' } },
  { pattern: /^breeze:\/\/scripts$/, permission: { resource: 'scripts', action: 'read' } },
  { pattern: /^breeze:\/\/automations$/, permission: { resource: 'automations', action: 'read' } },
];

function findMcpResourcePermission(uri: string): { resource: string; action: 'read' } | null {
  return MCP_RESOURCE_PERMISSIONS.find((entry) => entry.pattern.test(uri))?.permission ?? null;
}

/**
 * SR-008: explicit ALLOW-LIST of `devices` columns safe to serialize into the
 * `breeze://devices/{id}` MCP resource. An allow-list (not a deny-list) is
 * deliberate — any column added to the schema in future is excluded by
 * default, so a newly-introduced credential/secret column cannot silently
 * leak to an AI/MCP client. Excludes: agent/watchdog/helper token hashes and
 * their issued/expiry timestamps, mTLS certificate material/metadata, and the
 * internal agentId.
 */
export const SAFE_DEVICE_RESOURCE_FIELDS = [
  'id', 'orgId', 'siteId', 'hostname', 'displayName',
  'osType', 'deviceRole', 'deviceRoleSource', 'osVersion', 'osBuild',
  'architecture', 'agentVersion', 'status', 'lastSeenAt', 'enrolledAt',
  'enrolledBy', 'tags', 'customFields', 'managementPosture', 'tccPermissions',
  'desktopAccess', 'lastUser', 'uptimeSeconds', 'isHeadless', 'watchdogStatus',
  'watchdogLastSeen', 'watchdogVersion', 'quarantinedAt', 'quarantinedReason',
  'createdAt', 'updatedAt',
] as const;

export function buildSafeDeviceProjection() {
  const cols = getTableColumns(devices);
  return Object.fromEntries(
    SAFE_DEVICE_RESOURCE_FIELDS.map((field) => [field, cols[field]])
  ) as Pick<typeof cols, (typeof SAFE_DEVICE_RESOURCE_FIELDS)[number]>;
}

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

/**
 * Dual-axis read condition for a dual-ownership table (org XOR partner —
 * scripts, automations #2133). The app-layer filter must MIRROR RLS, never be
 * looser (leak) nor stricter (hide readable rows).
 *
 * Who may see partner-wide rows (org_id NULL) owned by their OWN partner:
 *  - PARTNER-scope callers always: they carry a partner-axis allowlist and pass
 *    RLS `breeze_has_partner_access(partner_id)`.
 *  - ORG-scope callers: since MCP-OAUTH-06 they carry NO partner-axis allowlist
 *    (accessiblePartnerIds: []), so `breeze_has_partner_access` FAILS for them.
 *    Their only partner-wide visibility comes from the RLS catalog read branch
 *    `org_id IS NULL AND partner_id = breeze_current_partner_id()`, which exists
 *    on scripts/alert_templates/script_categories/script_tags (2026-06-13
 *    migration) but NOT on automations. Hence the asymmetry:
 *      • SCRIPTS (orgScopeCatalogRead: true) — org callers DO see partner-wide
 *        rows; omitting the branch here would wrongly hide rows RLS permits
 *        (mirrors REST routes/scripts.ts which OR-s the partner branch for org
 *        scope).
 *      • AUTOMATIONS (orgScopeCatalogRead: false) — automations has no catalog
 *        read branch, so partner-wide rows are invisible to org callers at the
 *        RLS layer; the app layer matches by withholding the branch (mirrors
 *        REST routes/automations.ts which gates it to `scope === 'partner'`).
 */
export function dualAxisResourceCondition(
  auth: AuthContext,
  orgCondition: SQL | undefined,
  table: { orgId: PgColumn; partnerId: PgColumn },
  options: { orgScopeCatalogRead: boolean },
): SQL | undefined {
  if (!orgCondition) return undefined; // system scope — no tenant filter
  if (!auth.partnerId) return orgCondition;

  const partnerWideVisible =
    auth.scope === 'partner' || options.orgScopeCatalogRead;
  if (!partnerWideVisible) return orgCondition;

  return or(
    orgCondition,
    and(isNull(table.orgId), eq(table.partnerId, auth.partnerId)),
  ) as SQL;
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

  // MCP-OAUTH-03: authorize the URI before any site resolution or DB query.
  // OAuth consent and tenant RLS only prove membership, not that the
  // caller's role includes the resource's read permission — that's this
  // check's job, and it must fail closed (unknown URI families denied).
  const requiredPermission = findMcpResourcePermission(uri);
  if (!requiredPermission) {
    return jsonRpcError(id, -32602, `Unknown resource URI: ${uri}`);
  }
  try {
    const permError = await checkPermissionRequirement(auth, requiredPermission);
    if (permError) {
      return jsonRpcError(id, -32603, permError);
    }
  } catch (err) {
    console.error('[MCP] Permission check failed for resource:', uri, err);
    return jsonRpcError(id, -32000, 'Unable to verify permissions');
  }

  const orgCond = auth.orgCondition;

  // Site axis (app-layer only; RLS does NOT enforce it). A site-restricted
  // caller (auth.allowedSiteIds + canAccessSite) may only see devices/alerts
  // for devices in their allowed sites. tools/call enforces this via
  // verifyDeviceAccess, but resources/read previously applied only the org
  // condition. We resolve the allowed device-id set once (per the caller's
  // org) and narrow the device + alert list resources to it. No-op for
  // unrestricted callers (resolveSiteAllowedDeviceIds returns null).
  const siteOrgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
  const siteAllowedDeviceIds =
    auth.canAccessSite && siteOrgId
      ? await resolveSiteAllowedDeviceIds(siteOrgId, auth)
      : null;

  try {
    if (uri === 'breeze://devices') {
      const deviceSiteConditions: SQL[] =
        siteAllowedDeviceIds === null
          ? []
          : siteAllowedDeviceIds.length === 0
            ? // Restricted caller with zero in-scope devices — match no rows.
              [inArray(devices.id, ['00000000-0000-0000-0000-000000000000'])]
            : [inArray(devices.id, siteAllowedDeviceIds)];
      return await readOrgScopedResource(id, uri, devices, {
        id: devices.id,
        hostname: devices.hostname,
        status: devices.status,
        osType: devices.osType,
        osVersion: devices.osVersion,
        agentVersion: devices.agentVersion,
        lastSeenAt: devices.lastSeenAt
      }, orgCond(devices.orgId), { extraConditions: deviceSiteConditions, limit: 500 });
    }

    if (uri === 'breeze://alerts') {
      const alertSiteConditions: SQL[] = [
        eq(alerts.status, 'active' as typeof alerts.status.enumValues[number]),
      ];
      if (siteAllowedDeviceIds !== null) {
        // Narrow alerts to those raised on devices the caller may see. Empty
        // allowlist → impossible deviceId so no alert rows leak.
        alertSiteConditions.push(
          inArray(
            alerts.deviceId,
            siteAllowedDeviceIds.length === 0
              ? ['00000000-0000-0000-0000-000000000000']
              : siteAllowedDeviceIds,
          ),
        );
      }
      return await readOrgScopedResource(id, uri, alerts, {
        id: alerts.id,
        title: alerts.title,
        severity: alerts.severity,
        status: alerts.status,
        deviceId: alerts.deviceId,
        triggeredAt: alerts.triggeredAt
      }, orgCond(alerts.orgId), {
        extraConditions: alertSiteConditions,
        limit: 200
      });
    }

    if (uri === 'breeze://scripts') {
      // Scripts are dual-owned — include the caller's partner-wide scripts.
      return await readOrgScopedResource(id, uri, scripts, {
        id: scripts.id,
        name: scripts.name,
        description: scripts.description,
        language: scripts.language,
        category: scripts.category
      }, dualAxisResourceCondition(auth, orgCond(scripts.orgId), scripts, {
        // scripts have the RLS catalog read branch — org-scope callers see
        // their own partner-wide scripts.
        orgScopeCatalogRead: true,
      }), {
        extraConditions: [isNull(scripts.deletedAt)],
        limit: 200
      });
    }

    if (uri === 'breeze://automations') {
      // Automations are dual-owned (#2133) — include partner-wide rows.
      return await readOrgScopedResource(id, uri, automations, {
        id: automations.id,
        name: automations.name,
        description: automations.description,
        enabled: automations.enabled,
        trigger: automations.trigger
      }, dualAxisResourceCondition(auth, orgCond(automations.orgId), automations, {
        // automations have NO catalog read branch — org-scope callers do NOT
        // see partner-wide automations (aligns with routes/automations.ts).
        orgScopeCatalogRead: false,
      }), { limit: 200 });
    }

    // Handle dynamic resource URIs: breeze://devices/{id}
    const deviceMatch = uri.match(/^breeze:\/\/devices\/([0-9a-f-]+)$/);
    if (deviceMatch?.[1]) {
      const deviceId = deviceMatch[1];
      const orgFilter = orgCond(devices.orgId);
      const conditions: SQL[] = [eq(devices.id, deviceId)];
      if (orgFilter) conditions.push(orgFilter);

      const [device] = await db
        .select(buildSafeDeviceProjection())
        .from(devices)
        .where(and(...conditions))
        .limit(1);

      // Site axis (app-layer only): a site-restricted caller must not resolve a
      // device outside their allowed sites — treat as not-found. siteId is in
      // SAFE_DEVICE_RESOURCE_FIELDS so the projection already carries it.
      if (!device || deviceSiteDenied(auth, device.siteId)) {
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
    const message = sanitizeThrownToolError('mcp_resources_read', err, { uri });
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
  scopes: string[];
  principalType?: string;
  principalId?: string | null;
}): Promise<AuthContext | null> {
  const user = {
    id: apiKey.createdBy,
    email: `apikey-${apiKey.name}@breeze.local`,
    name: `API Key: ${apiKey.name}`,
    isPlatformAdmin: false
  };

  if (apiKey.orgId) {
    // A key inherits the CREATING user's access, including their site-axis
    // restriction — it can never be broader than the user who minted it. Load
    // the creator's allowedSiteIds for this org so the site gate (verifyDeviceAccess)
    // applies to MCP/API-key callers exactly as it does to the JWT request path.
    //
    // The creator may be a Partner Admin with NO organization_users row for this
    // org — their role lives in partner_users. getUserPermissions only consults
    // the partner axis when given a partnerId, but manual (user-created) keys
    // carry partnerId: null because apiKeyAuth deliberately gates partner-axis
    // RLS visibility (accessiblePartnerIds) to mcp_provisioning keys. Resolve the
    // owning org's partner here purely for ROLE resolution so a partner-admin-
    // minted key can pass checkToolPermission. This does NOT widen the key's RLS
    // partner visibility: the middleware still established this request's DB
    // context with an empty accessiblePartnerIds, so partner-scoped tables stay
    // unreadable. The key remains org-scoped (orgCondition pins to this org).
    const partnerId =
      apiKey.partnerId ?? (await getActiveOrgTenant(apiKey.orgId))?.partnerId ?? null;

    // SR2-15 (PR 5): a service-principal key (principalType === 'service')
    // is authorized against the PRINCIPAL, never the human who last rotated
    // it — `createdBy` on a service key is an audit trail (who minted the
    // current key), not an acting identity to delegate from. Human keys (the
    // default; also every OAuth-bearer caller, which never carries
    // principalType) take the unchanged authorizeHumanApiKeyCreator path.
    const isServicePrincipalKey = apiKey.principalType === 'service' && !!apiKey.principalId;

    // SR2-15: LIVE-authorize the human creator via the shared resolver — it does
    // BOTH the null-perms fail-closed deny (#2510) AND the scope re-clamp this
    // task adds. The old code read `creatorPerms?.allowedSiteIds` off a raw
    // getUserPermissions() call: a null read collapsed to `undefined`, and
    // siteAccessCheck(undefined) means "full access to EVERY site in the org" —
    // the same value a legitimate full-access admin gets. #2510 already closed
    // that hole with an explicit null-check. What #2510 did NOT do: re-validate
    // that the key's STORED scopes are still backed by the creator's CURRENT
    // permissions. A creator whose role was downgraded after the key was minted
    // (e.g. admin -> read-only) would still have their key served with the
    // original, now-stale, broader scopes — the MCP path never re-clamped. A
    // key delegates its creator's authority; it must never outlive a reduction
    // in that authority, any more than it may outlive its total loss.
    const authz = isServicePrincipalKey
      ? await authorizeServicePrincipalKey({
          principalId: apiKey.principalId as string,
          scopes: apiKey.scopes ?? [],
        })
      : await authorizeHumanApiKeyCreator({
          createdBy: apiKey.createdBy,
          orgId: apiKey.orgId,
          partnerId,
          scopes: apiKey.scopes ?? [],
        });
    if (!authz.ok) {
      // buildCheckedAuthFromApiKey maps null -> 403 (creator/principal has no
      // access, or the key's scopes exceed the current permission/scope ceiling).
      return null;
    }
    const allowedSiteIds = authz.allowedSiteIds;
    return {
      user,
      token: {} as AuthContext['token'],
      partnerId,
      orgId: apiKey.orgId,
      scope: 'organization',
      accessibleOrgIds: [apiKey.orgId],
      orgCondition: (orgIdColumn) => eq(orgIdColumn, apiKey.orgId!),
      canAccessOrg: (checkOrgId) => checkOrgId === apiKey.orgId,
      allowedSiteIds,
      canAccessSite: siteAccessCheck(allowedSiteIds)
    };
  }

  // Partner-scope caller (OAuth bearer token, or API key with no orgId).
  //
  // SR2-15: this branch had no explicit null-perms deny — an off-boarded
  // partner admin's bearer key was only "data-starved" (accessibleOrgIds
  // resolves to [] via resolvePartnerAccessibleOrgIds, which reads
  // partner_users fresh and returns [] when the membership row is gone),
  // never outright rejected. That's an unsatisfiable org filter, not a
  // denial: tools/list still succeeds and the caller looks authenticated.
  // Add an explicit reject so an off-boarded partner admin's key is denied,
  // matching the org-scope branch's fail-closed behavior above.
  if (apiKey.partnerId) {
    let partnerPerms: Awaited<ReturnType<typeof getUserPermissions>>;
    try {
      partnerPerms = await getUserPermissions(apiKey.createdBy, { partnerId: apiKey.partnerId });
    } catch {
      // FAIL CLOSED: a DB/RLS error is indistinguishable from "no access".
      return null;
    }
    if (!partnerPerms) {
      return null;
    }
  }

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
