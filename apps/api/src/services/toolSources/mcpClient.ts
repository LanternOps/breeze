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
import { safeFetch } from '../urlSafety';
import type { SafeFetchInit } from '../urlSafety';
import type { ToolSourceAuthConfig } from './secrets';
import { buildToolSourceAuthHeaders, ToolSourceAuthError } from './authHeaders';

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
/**
 * Aggregate caps across every page of `tools/list`, on top of the existing
 * per-page `MAX_LIST_PAGES` and `maxResponseBytes`. Those two only bound a
 * single page in isolation; without a running total, a peer can still
 * return an unbounded number of small pages that together persist a huge
 * catalog and inflate every chat turn's tool-list payload.
 */
const MAX_TOOLS_PER_SOURCE = 500;
const MAX_AGGREGATE_TOOL_BYTES = 2_097_152;

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

// The OAuth2 client-credentials token cache and the credential header builder
// live in `./authHeaders` (W2) so the MCP and OpenAPI transports pin
// credentials identically. Re-exported for existing importers.
export { getOAuth2ClientCredentialsToken } from './authHeaders';

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
    let aggregateBytes = 0;
    for (;;) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new McpClientError(`tools/list did not exhaust after ${MAX_LIST_PAGES} pages`, 'protocol');
      }
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: McpToolListing[];
        nextCursor?: string;
      };
      for (const tool of result.tools ?? []) {
        tools.push(tool);
        aggregateBytes += Buffer.byteLength(JSON.stringify(tool), 'utf8');
        if (tools.length > MAX_TOOLS_PER_SOURCE) {
          throw new McpClientError(`tools/list exceeded the ${MAX_TOOLS_PER_SOURCE}-tool aggregate cap`, 'too_large');
        }
        if (aggregateBytes > MAX_AGGREGATE_TOOL_BYTES) {
          throw new McpClientError(
            `tools/list exceeded the ${MAX_AGGREGATE_TOOL_BYTES}-byte aggregate tool-definition cap`,
            'too_large'
          );
        }
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    return result as McpCallResult;
  }

  /**
   * Build the auth header for this request, enforcing origin pinning BEFORE any
   * network call. Delegates to the shared builder; its typed failures are
   * re-raised as `McpClientError` with the same code, which is what every
   * MCP caller already branches on.
   */
  private async buildAuthHeaders(): Promise<Record<string, string>> {
    const { auth, endpointUrl, credentialOrigin } = this.opts;
    try {
      return await buildToolSourceAuthHeaders(auth, endpointUrl, credentialOrigin, { fetchImpl: this.fetchImpl });
    } catch (err) {
      if (err instanceof ToolSourceAuthError) throw new McpClientError(err.message, err.code);
      throw err;
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
