import { afterEach, describe, expect, it, vi } from 'vitest';

const { safeFetchMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
}));

vi.mock('../urlSafety', async () => {
  const actual = await vi.importActual<typeof import('../urlSafety')>('../urlSafety');
  return { ...actual, safeFetch: safeFetchMock };
});

import { McpClient, McpClientError } from './mcpClient';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function sseResponse(messages: unknown[], status = 200, headers: Record<string, string> = {}): Response {
  const body = messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

function requestBody(call: [string, { body?: unknown }]): { id?: number; method: string; params?: Record<string, unknown> } {
  return JSON.parse(call[1].body as string);
}

function headersOf(call: [string, { headers?: unknown }]): Record<string, string> {
  return call[1].headers as Record<string, string>;
}

const BASE_URL = 'https://mcp.example.com/mcp';
const ORIGIN = 'https://mcp.example.com';

describe('McpClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    safeFetchMock.mockReset();
  });

  it('(a) captures the session id from initialize and echoes it (and the protocol version header) on the next request', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }, 200, { 'mcp-session-id': 'sess-123' })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 3, result: { tools: [] } }));

    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });
    await client.initialize();
    await client.listTools();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const notifyHeaders = headersOf(fetchImpl.mock.calls[1] as [string, { headers?: unknown }]);
    expect(notifyHeaders['Mcp-Session-Id']).toBe('sess-123');
    expect(notifyHeaders['MCP-Protocol-Version']).toBe('2025-06-18');

    const listHeaders = headersOf(fetchImpl.mock.calls[2] as [string, { headers?: unknown }]);
    expect(listHeaders['Mcp-Session-Id']).toBe('sess-123');
    expect(listHeaders['MCP-Protocol-Version']).toBe('2025-06-18');
  });

  it('(b) paginates tools/list until nextCursor is exhausted', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a', inputSchema: {} }], nextCursor: 'page2' } })
      )
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'b', inputSchema: {} }] } }));

    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });
    const tools = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = requestBody(fetchImpl.mock.calls[1] as [string, { body?: unknown }]);
    expect(secondBody.params?.cursor).toBe('page2');
  });

  it('(c) callTool returns structuredContent and isError from the tools/call result', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'oops' }], structuredContent: { code: 42 }, isError: true },
      })
    );

    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });
    const result = await client.callTool('doThing', { x: 1 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: 42 });
    expect(result.content[0]?.text).toBe('oops');

    const body = requestBody(fetchImpl.mock.calls[0] as [string, { body?: unknown }]);
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'doThing', arguments: { x: 1 } });
  });

  it('(d) parses an SSE-framed (text/event-stream) JSON-RPC response', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      sseResponse([{ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'sseTool', inputSchema: {} }] } }])
    );

    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });
    const tools = await client.listTools();

    expect(tools).toEqual([{ name: 'sseTool', inputSchema: {} }]);
  });

  it('(d) picks the SSE message whose id matches the request out of several framed events', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      sseResponse([
        { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
        { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'realTool', inputSchema: {} }] } },
      ])
    );

    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });
    const tools = await client.listTools();

    expect(tools).toEqual([{ name: 'realTool', inputSchema: {} }]);
  });

  it('(e) attaches Authorization: Bearer for bearer auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    const client = new McpClient({
      endpointUrl: BASE_URL,
      credentialOrigin: ORIGIN,
      auth: { authKind: 'bearer', token: 'tok123' },
      fetchImpl,
    });
    await client.listTools();
    expect(headersOf(fetchImpl.mock.calls[0] as [string, { headers?: unknown }]).Authorization).toBe('Bearer tok123');
  });

  it('(e) attaches the configured header for api_key_header auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    const client = new McpClient({
      endpointUrl: BASE_URL,
      credentialOrigin: ORIGIN,
      auth: { authKind: 'api_key_header', headerName: 'X-Api-Key', value: 'k-999' },
      fetchImpl,
    });
    await client.listTools();
    expect(headersOf(fetchImpl.mock.calls[0] as [string, { headers?: unknown }])['X-Api-Key']).toBe('k-999');
  });

  it('(e) attaches Authorization: Basic <base64> for basic auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    const client = new McpClient({
      endpointUrl: BASE_URL,
      credentialOrigin: ORIGIN,
      auth: { authKind: 'basic', username: 'user', password: 'pass' },
      fetchImpl,
    });
    await client.listTools();
    const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    expect(headersOf(fetchImpl.mock.calls[0] as [string, { headers?: unknown }]).Authorization).toBe(expected);
  });

  it('(f) throws origin_mismatch and sends no request when credentialOrigin differs from the endpoint origin', async () => {
    const fetchImpl = vi.fn();
    const client = new McpClient({
      endpointUrl: BASE_URL,
      credentialOrigin: 'https://attacker.example.com',
      auth: { authKind: 'bearer', token: 'tok123' },
      fetchImpl,
    });

    await expect(client.listTools()).rejects.toMatchObject({ code: 'origin_mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('(f) does not require origin agreement when auth is none', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    const client = new McpClient({
      endpointUrl: BASE_URL,
      credentialOrigin: 'https://unrelated.example.com',
      auth: { authKind: 'none' },
      fetchImpl,
    });
    await expect(client.listTools()).resolves.toEqual([]);
  });

  it('(g) surfaces a JSON-RPC error object as a protocol error carrying the server message', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: bogus' } })
    );
    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });

    await expect(client.callTool('bogus', {})).rejects.toMatchObject({
      code: 'protocol',
      message: expect.stringContaining('Method not found: bogus'),
    });
  });

  it('(h) maps a 401 response to an auth error', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
    );
    const client = new McpClient({
      endpointUrl: BASE_URL,
      credentialOrigin: ORIGIN,
      auth: { authKind: 'bearer', token: 'bad' },
      fetchImpl,
    });

    await expect(client.listTools()).rejects.toMatchObject({ code: 'auth' });
  });

  it('(i) throws too_large when the response body exceeds maxResponseBytes', async () => {
    const huge = 'x'.repeat(5000);
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [], huge } })
    );
    const client = new McpClient({
      endpointUrl: BASE_URL,
      credentialOrigin: ORIGIN,
      auth: { authKind: 'none' },
      fetchImpl,
      maxResponseBytes: 100,
    });

    await expect(client.listTools()).rejects.toMatchObject({ code: 'too_large' });
  });

  it('(j) raises a protocol error after more than 50 tools/list pages', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body?: unknown }) => {
      const req = requestBody([_url, init]);
      const cursor = req.params?.cursor as string | undefined;
      const nextPage = (cursor ? Number(cursor.split('-')[1]) : 0) + 1;
      return jsonResponse({ jsonrpc: '2.0', id: req.id, result: { tools: [], nextCursor: `page-${nextPage}` } });
    });

    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });

    await expect(client.listTools()).rejects.toMatchObject({ code: 'protocol' });
    expect(fetchImpl).toHaveBeenCalledTimes(50);
  });

  it('treats any 3xx response as a transport error and never follows it', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://mcp.example.com/other' } })
    );
    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });

    await expect(client.listTools()).rejects.toMatchObject({ code: 'transport' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('defaults to safeFetch (never bare fetch) as the transport when no fetchImpl is supplied', async () => {
    safeFetchMock.mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('global fetch must not be used'));

    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' } });
    await client.listTools();

    expect(globalFetch).not.toHaveBeenCalled();
    expect(safeFetchMock).toHaveBeenCalledWith(
      BASE_URL,
      expect.objectContaining({ method: 'POST', timeoutMs: expect.any(Number), maxBytes: expect.any(Number) })
    );
  });

  it('forwards allowPrivateNetwork through to the fetch transport (self-hosted SSRF opt-in, TOOL_SOURCES_ALLOW_PRIVATE_EGRESS)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    const client = new McpClient({
      endpointUrl: BASE_URL,
      credentialOrigin: ORIGIN,
      auth: { authKind: 'none' },
      fetchImpl,
      allowPrivateNetwork: true,
    });

    await client.listTools();

    expect(fetchImpl).toHaveBeenCalledWith(BASE_URL, expect.objectContaining({ allowPrivateNetwork: true }));
  });

  it('defaults allowPrivateNetwork to undefined (never silently opts a tenant into private egress)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    const client = new McpClient({ endpointUrl: BASE_URL, credentialOrigin: ORIGIN, auth: { authKind: 'none' }, fetchImpl });

    await client.listTools();

    const init = fetchImpl.mock.calls[0]![1] as { allowPrivateNetwork?: boolean };
    expect(init.allowPrivateNetwork).toBeUndefined();
  });

  it('fetches and caches an oauth2 client_credentials token, attaching it as a Bearer header', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-abc', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [] } }));

    const client = new McpClient({
      endpointUrl: BASE_URL,
      credentialOrigin: ORIGIN,
      auth: {
        authKind: 'oauth2_client_credentials',
        tokenUrl: 'https://auth.example.com/mcpclient-token-test',
        clientId: 'mcpclient-test-cid',
        clientSecret: 'secret',
      },
      fetchImpl,
    });

    await client.listTools();
    await client.listTools();

    // Token endpoint hit once (cached across the two MCP calls), then two MCP requests.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const mcpHeaders = headersOf(fetchImpl.mock.calls[1] as [string, { headers?: unknown }]);
    expect(mcpHeaders.Authorization).toBe('Bearer tok-abc');
    const mcpHeaders2 = headersOf(fetchImpl.mock.calls[2] as [string, { headers?: unknown }]);
    expect(mcpHeaders2.Authorization).toBe('Bearer tok-abc');
  });

  // Two tenants may register the same authorization server and the same client
  // id with DIFFERENT secrets. If the token cache keyed on (tokenUrl, clientId)
  // alone, tenant B would be handed an access token minted from tenant A's
  // secret — a silent cross-tenant credential leak.
  it('does not share a cached oauth2 token between two configs with the same clientId but different secrets', async () => {
    let issued = 0;
    let rpcId = 0;
    const fetchImpl = vi.fn(async (url: string, _init: { headers?: unknown }) => {
      void _init;
      if (url.includes('shared-token-endpoint')) {
        issued += 1;
        return jsonResponse({ access_token: `tok-${issued}`, expires_in: 3600 });
      }
      rpcId += 1;
      return jsonResponse({ jsonrpc: '2.0', id: rpcId, result: { tools: [] } });
    });

    const makeClient = (clientSecret: string) =>
      new McpClient({
        endpointUrl: BASE_URL,
        credentialOrigin: ORIGIN,
        auth: {
          authKind: 'oauth2_client_credentials',
          tokenUrl: 'https://auth.example.com/shared-token-endpoint',
          clientId: 'shared-cid',
          clientSecret,
        },
        fetchImpl,
      });

    await makeClient('tenant-a-secret').listTools();
    await makeClient('tenant-b-secret').listTools();

    const tokenCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes('shared-token-endpoint'));
    expect(tokenCalls).toHaveLength(2);

    const authHeaders = fetchImpl.mock.calls
      .filter(([url]) => !String(url).includes('shared-token-endpoint'))
      .map((call) => headersOf(call as [string, { headers?: unknown }]).Authorization);
    expect(authHeaders[0]).not.toBe(authHeaders[1]);
  });

  it('exports McpClientError with a readonly code', () => {
    const err = new McpClientError('boom', 'transport');
    expect(err.code).toBe('transport');
    expect(err).toBeInstanceOf(Error);
  });
});
