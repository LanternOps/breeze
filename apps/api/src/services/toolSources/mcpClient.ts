/**
 * Streamable-HTTP MCP client — Breeze acting as an MCP *client* against a
 * tenant-configured external MCP server (spec 2026-09-07, Task A5).
 *
 * Protocol: JSON-RPC 2.0 POSTs to a single `endpointUrl`, `Content-Type:
 * application/json`, `Accept: application/json, text/event-stream`. Every
 * request sent AFTER `initialize()` carries `MCP-Protocol-Version:
 * 2025-06-18`, and `Mcp-Session-Id` is echoed back once the server has
 * returned one. Responses are either a single `application/json` JSON-RPC
 * message or a `text/event-stream` framing of `data:` lines — either shape is
 * accepted transparently. Redirects are never followed (the default
 * transport, `safeFetch`, already refuses to follow them) — any 3xx is
 * treated as a transport failure so a compromised/misconfigured tenant
 * endpoint cannot smuggle us onto an internal address via a Location header.
 *
 * All egress goes through `safeFetch` by default (SSRF-guarded, IP-pinned,
 * size- and time-bounded) — never bare `fetch`. Callers running inside a
 * request's `withDbAccessContext` transaction must not construct this client
 * there; `safeFetch` itself asserts it is not called inside a held DB
 * context (see `urlSafety.ts`).
 */
import { createHash } from 'node:crypto';
import { safeFetch } from '../urlSafety';
import type { SafeFetchInit } from '../urlSafety';
import type { ToolSourceAuthConfig } from './secrets';

export interface McpClientOptions {
  endpointUrl: string;
  /** The origin (`new URL(endpointUrl).origin`) the caller decrypted `auth` for. */
  credentialOrigin: string;
  auth: ToolSourceAuthConfig;
  /** default: `safeFetch` from `../urlSafety` — tests must inject a scripted fake. */
  fetchImpl?: (url: string, init: SafeFetchInit) => Promise<Response>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowPrivateNetwork?: boolean;
  clientVersion?: string;
}

export interface McpToolListing {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export type McpClientErrorCode = 'transport' | 'protocol' | 'auth' | 'timeout' | 'too_large' | 'origin_mismatch';

export class McpClientError extends Error {
  constructor(message: string, readonly code: McpClientErrorCode) {
    super(message);
    this.name = 'McpClientError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const PROTOCOL_VERSION = '2025-06-18';
const MAX_LIST_PAGES = 50;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  id?: number;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Module-level cache of OAuth2 client-credentials tokens.
 *
 * The key covers the WHOLE credential, not just (tokenUrl, clientId): two
 * tenants may legitimately register the same authorization server and the same
 * client id with DIFFERENT secrets or scopes (a shared SaaS vendor, separate
 * subscriptions). Keying on the identifier alone would hand tenant B an access
 * token minted from tenant A's secret — a cross-tenant credential leak with no
 * error anywhere. The secret is hashed so the cache key itself is not a place
 * a credential can be read out of (heap dumps, debugger, log of Map keys).
 */
const oauthTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function oauthCacheKey(cfg: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([cfg.tokenUrl, cfg.clientId, cfg.clientSecret, cfg.scope ?? '']),
    )
    .digest('hex');
}

/** 30s of slack so a token about to expire mid-request is refreshed instead of reused. */
const OAUTH_EXPIRY_SKEW_MS = 30_000;

export async function getOAuth2ClientCredentialsToken(
  cfg: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string },
  fetchImpl: (url: string, init: SafeFetchInit) => Promise<Response>
): Promise<{ accessToken: string; expiresAt: number }> {
  const cacheKey = oauthCacheKey(cfg);
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    ...(cfg.scope ? { scope: cfg.scope } : {}),
  });

  let res: Response;
  try {
    res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    throw new McpClientError(`oauth2 token request failed: ${err instanceof Error ? err.message : String(err)}`, 'auth');
  }

  if (!res.ok) {
    throw new McpClientError(`oauth2 token request failed with status ${res.status}`, 'auth');
  }

  let json: { access_token?: string; expires_in?: number };
  try {
    json = (await res.json()) as { access_token?: string; expires_in?: number };
  } catch {
    throw new McpClientError('oauth2 token response was not valid JSON', 'auth');
  }
  if (!json.access_token) {
    throw new McpClientError('oauth2 token response missing access_token', 'auth');
  }

  const ttlMs = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in * 1000 : 3_600_000;
  const token = { accessToken: json.access_token, expiresAt: Date.now() + ttlMs - OAUTH_EXPIRY_SKEW_MS };
  oauthTokenCache.set(cacheKey, token);
  return token;
}

export class McpClient {
  private readonly opts: McpClientOptions;
  private readonly fetchImpl: (url: string, init: SafeFetchInit) => Promise<Response>;
  private sessionId: string | undefined;
  private nextRequestId = 1;
  private afterInitialize = false;

  constructor(opts: McpClientOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? safeFetch;
  }

  async initialize(): Promise<{ protocolVersion: string; serverInfo?: { name?: string; version?: string } }> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'breeze-rmm', version: this.opts.clientVersion ?? '0.0.0' },
    });
    // Every request AFTER initialize (including the notification below) carries
    // the protocol-version header.
    this.afterInitialize = true;
    await this.notify('notifications/initialized', undefined);
    return result as { protocolVersion: string; serverInfo?: { name?: string; version?: string } };
  }

  async listTools(): Promise<McpToolListing[]> {
    const tools: McpToolListing[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new McpClientError(`tools/list did not exhaust after ${MAX_LIST_PAGES} pages`, 'protocol');
      }
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: McpToolListing[];
        nextCursor?: string;
      };
      tools.push(...(result.tools ?? []));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    return result as McpCallResult;
  }

  /** Build the auth header for this request, enforcing origin pinning BEFORE any network call. */
  private async buildAuthHeaders(): Promise<Record<string, string>> {
    const { auth, endpointUrl, credentialOrigin } = this.opts;
    if (auth.authKind === 'none') return {};

    if (new URL(endpointUrl).origin !== credentialOrigin) {
      throw new McpClientError(
        `refusing to attach credentials: endpoint origin does not match the credential's origin (${credentialOrigin})`,
        'origin_mismatch'
      );
    }

    switch (auth.authKind) {
      case 'bearer':
        return { Authorization: `Bearer ${auth.token}` };
      case 'api_key_header':
        return { [auth.headerName]: auth.value };
      case 'basic':
        return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` };
      case 'oauth2_client_credentials': {
        const { accessToken } = await getOAuth2ClientCredentialsToken(
          { tokenUrl: auth.tokenUrl, clientId: auth.clientId, clientSecret: auth.clientSecret, scope: auth.scope },
          this.fetchImpl
        );
        return { Authorization: `Bearer ${accessToken}` };
      }
      default:
        return {};
    }
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(await this.buildAuthHeaders()),
    };
    if (this.afterInitialize) headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  private async send(payload: JsonRpcRequest): Promise<Response> {
    const headers = await this.buildHeaders();
    try {
      return await this.fetchImpl(this.opts.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: this.opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        allowPrivateNetwork: this.opts.allowPrivateNetwork,
      });
    } catch (err) {
      if (err instanceof McpClientError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'ResponseTooLargeError') {
        throw new McpClientError(message, 'too_large');
      }
      if (/timed out/i.test(message)) {
        throw new McpClientError(`MCP request timed out: ${message}`, 'timeout');
      }
      throw new McpClientError(`MCP transport error: ${message}`, 'transport');
    }
  }

  /** Send a JSON-RPC request (with an `id`) and return its `result`. */
  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    const res = await this.send({ jsonrpc: '2.0', method, id, params });

    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (res.status >= 300 && res.status < 400) {
      throw new McpClientError(`MCP server returned a redirect (${res.status}); redirects are never followed`, 'transport');
    }
    if (res.status === 401 || res.status === 403) {
      throw new McpClientError(`MCP server rejected the request with ${res.status}`, 'auth');
    }
    if (!res.ok) {
      throw new McpClientError(`MCP server responded with ${res.status}`, 'transport');
    }

    const message = await this.parseBody(res, id);
    if (message?.error) {
      throw new McpClientError(message.error.message ?? 'MCP server returned a JSON-RPC error', 'protocol');
    }
    return message?.result;
  }

  /** Send a JSON-RPC notification (no `id`, no response body expected). */
  private async notify(method: string, params: unknown): Promise<void> {
    const res = await this.send({ jsonrpc: '2.0', method, params });

    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (res.status >= 300 && res.status < 400) {
      throw new McpClientError(`MCP server returned a redirect (${res.status}); redirects are never followed`, 'transport');
    }
    if (res.status === 401 || res.status === 403) {
      throw new McpClientError(`MCP server rejected the notification with ${res.status}`, 'auth');
    }
    if (![200, 202, 204].includes(res.status)) {
      throw new McpClientError(`MCP server returned unexpected status ${res.status} for a notification`, 'protocol');
    }
  }

  private async parseBody(res: Response, expectedId: number): Promise<JsonRpcResponse | undefined> {
    const text = await res.text();
    const maxBytes = this.opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new McpClientError(`MCP response body exceeded maxResponseBytes (${maxBytes})`, 'too_large');
    }
    if (text.length === 0) return undefined;

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return this.parseSse(text, expectedId);
    }
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new McpClientError('MCP response body was not valid JSON', 'protocol');
    }
  }

  /** Parse a `text/event-stream` body into JSON-RPC messages and return the one matching `expectedId`. */
  private parseSse(text: string, expectedId: number): JsonRpcResponse | undefined {
    const messages: JsonRpcResponse[] = [];
    let dataLines: string[] = [];

    const flush = (): void => {
      if (dataLines.length === 0) return;
      try {
        messages.push(JSON.parse(dataLines.join('\n')) as JsonRpcResponse);
      } catch {
        // Malformed individual event — skip it rather than failing the whole stream.
      }
      dataLines = [];
    };

    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      } else if (line === '') {
        flush();
      }
    }
    flush();

    const match = messages.find((m) => m.id === expectedId);
    if (!match) {
      throw new McpClientError(`no SSE event carried a JSON-RPC response for request id ${expectedId}`, 'protocol');
    }
    return match;
  }
}
