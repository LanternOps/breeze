/**
 * Shared request helpers for the MCP tool-list / meta-tool suites (#12427).
 *
 * Only transport plumbing lives here; every suite declares its own vi.mock
 * calls (they are hoisted per file) and passes its own audit spy.
 */
import { Hono } from 'hono';
import type { mcpServerRoutes as McpServerRoutes } from './mcpServer';

export type HarnessResponse = {
  status: number;
  wwwAuthenticate: string | null;
  text: string;
  body: any;
  requestAudits: Array<Record<string, any>>;
  toolAudits: Array<Record<string, any>>;
};

export type HarnessCallOptions = {
  headers?: Record<string, string>;
  meta?: Record<string, unknown>;
  clientCapabilities?: Record<string, unknown>;
  /** Overrides the modern `Mcp-Name` header. */
  mcpName?: string;
};

type AuditSpy = { mock: { calls: unknown[][] }; mockClear: () => unknown };

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-API-Key': 'k' };

export function createMcpHarness(routes: typeof McpServerRoutes, writeAuditEvent: AuditSpy) {
  const app = () => new Hono().route('/mcp', routes);

  async function capture(res: Response): Promise<HarnessResponse> {
    const text = await res.text();
    const rows = writeAuditEvent.mock.calls.map((call) => call[1] as Record<string, any>);
    return {
      status: res.status,
      wwwAuthenticate: res.headers.get('www-authenticate'),
      text,
      body: text ? JSON.parse(text) : null,
      requestAudits: rows.filter((r) => r.resourceType === 'mcp_request'),
      toolAudits: rows.filter((r) => r.resourceType === 'mcp_tool_execution'),
    };
  }

  async function initialize(opts: HarnessCallOptions = {}) {
    writeAuditEvent.mockClear();
    const res = await app().request('/mcp/sse', {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...opts.headers },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', ...(opts.clientCapabilities ? { capabilities: opts.clientCapabilities } : {}) },
      }),
    });
    return { sessionId: res.headers.get('mcp-session-id'), response: await capture(res) };
  }

  /** Legacy Streamable HTTP: initialize (no mode override), then the call on the owned session. */
  async function legacy(method: string, params?: Record<string, unknown>, opts: HarnessCallOptions = {}): Promise<HarnessResponse> {
    const { sessionId } = await initialize({ clientCapabilities: opts.clientCapabilities });
    writeAuditEvent.mockClear();
    const merged = opts.meta ? { ...(params ?? {}), _meta: opts.meta } : params;
    return capture(await app().request('/mcp/sse', {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        'MCP-Protocol-Version': '2025-11-25',
        ...opts.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, ...(merged ? { params: merged } : {}) }),
    }));
  }

  /** Stateless 2026-07-28 era on POST /sse. */
  async function modern(method: string, params?: Record<string, unknown>, opts: HarnessCallOptions = {}): Promise<HarnessResponse> {
    writeAuditEvent.mockClear();
    const headers: Record<string, string> = {
      ...JSON_HEADERS, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
    };
    if (method === 'tools/call') headers['Mcp-Name'] = opts.mcpName ?? String(params?.name);
    if (method === 'resources/read') headers['Mcp-Name'] = String(params?.uri);
    if (method.startsWith('tasks/')) headers['Mcp-Name'] = String(params?.taskId);
    return capture(await app().request('/mcp/sse', {
      method: 'POST',
      headers: { ...headers, ...opts.headers },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method,
        params: {
          ...(params ?? {}),
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': opts.clientCapabilities ?? {},
            ...opts.meta,
          },
        },
      }),
    }));
  }

  return { app, initialize, legacy, modern };
}
