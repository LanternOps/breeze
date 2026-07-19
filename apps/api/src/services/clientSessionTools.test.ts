import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clientToolsSchema,
  requestClientDeclaredTool,
  resolveClientDeclaredTool,
  failPendingClientDeclaredForSession,
  makeClientDeclaredToolHandler,
  createClientDeclaredMcpServer,
  clientDeclaredToolMcpNames,
  CLIENT_DECLARED_MCP_SERVER_NAME,
  CLIENT_DECLARED_TOOL_TIMEOUT_MS,
  MAX_CLIENT_DECLARED_TOOLS,
  _pendingClientDeclaredCountForTests,
  type ClientToolDeclaration,
} from './clientSessionTools';
import type { ActiveSession } from './streamingSessionManager';

// ============================================
// Validation
// ============================================

function decl(name: string, extra: Partial<ClientToolDeclaration> = {}): ClientToolDeclaration {
  return {
    name,
    description: `does ${name}`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    ...extra,
  };
}

describe('clientToolsSchema validation', () => {
  it('accepts a well-formed declaration array', () => {
    const parsed = clientToolsSchema.safeParse([decl('find_files'), decl('get_passages')]);
    expect(parsed.success).toBe(true);
  });

  it('rejects more than the max number of tools', () => {
    const tools = Array.from({ length: MAX_CLIENT_DECLARED_TOOLS + 1 }, (_, i) => decl(`tool_${i}`));
    const parsed = clientToolsSchema.safeParse(tools);
    expect(parsed.success).toBe(false);
  });

  it('rejects a tool with a bad name', () => {
    expect(clientToolsSchema.safeParse([decl('Bad-Name')]).success).toBe(false);
    expect(clientToolsSchema.safeParse([decl('a')]).success).toBe(false); // too short
    expect(clientToolsSchema.safeParse([decl('1abc')]).success).toBe(false); // leading digit
  });

  it('rejects duplicate tool names', () => {
    const parsed = clientToolsSchema.safeParse([decl('find_files'), decl('find_files')]);
    expect(parsed.success).toBe(false);
  });

  it('rejects an inputSchema deeper than 3 levels', () => {
    const deep: ClientToolDeclaration = decl('deep', {
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' } } } } },
        },
      },
    });
    expect(clientToolsSchema.safeParse([deep]).success).toBe(false);
  });

  it('accepts an inputSchema exactly 3 levels deep', () => {
    const okay: ClientToolDeclaration = decl('okay', {
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'object', properties: { b: { type: 'string' } } } },
      },
    });
    expect(clientToolsSchema.safeParse([okay]).success).toBe(true);
  });

  it('rejects an inputSchema whose type is not object', () => {
    const bad: ClientToolDeclaration = decl('bad', {
      inputSchema: { type: 'string' } as unknown as ClientToolDeclaration['inputSchema'],
    });
    expect(clientToolsSchema.safeParse([bad]).success).toBe(false);
  });
});

// ============================================
// Bridge loop (park → publish → resolve/timeout)
// ============================================

function fakeSession(id: string) {
  const publish = vi.fn();
  return {
    session: { breezeSessionId: id, eventBus: { publish } } as unknown as ActiveSession,
    publish,
  };
}

describe('client-declared tool bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    failPendingClientDeclaredForSession('sess-1');
    failPendingClientDeclaredForSession('sess-2');
    vi.useRealTimers();
  });

  it('publishes client_tool_request and resolves with the posted output', async () => {
    const { session, publish } = fakeSession('sess-1');
    const p = requestClientDeclaredTool(session, 'tu-1', 'find_files', { q: 'henderson' });

    expect(publish).toHaveBeenCalledWith({
      type: 'client_tool_request',
      toolUseId: 'tu-1',
      toolName: 'find_files',
      input: { q: 'henderson' },
    });

    expect(resolveClientDeclaredTool('sess-1', 'tu-1', { output: { files: [1, 2] } })).toBe('resolved');
    await expect(p).resolves.toEqual({ output: { files: [1, 2] } });
    expect(_pendingClientDeclaredCountForTests()).toBe(0);
  });

  it('resolves as a tool error when the client posts { error }', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientDeclaredTool(session, 'tu-2', 'find_files', {});
    expect(resolveClientDeclaredTool('sess-1', 'tu-2', { error: 'boom' })).toBe('resolved');
    await expect(p).resolves.toEqual({ error: 'boom' });
  });

  it('resolves with a timeout error text when the client never responds', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientDeclaredTool(session, 'tu-3', 'find_files', {});

    vi.advanceTimersByTime(CLIENT_DECLARED_TOOL_TIMEOUT_MS - 1);
    expect(_pendingClientDeclaredCountForTests()).toBe(1);
    vi.advanceTimersByTime(1);

    const result = await p;
    expect(result.error).toContain('client did not respond');
    expect(_pendingClientDeclaredCountForTests()).toBe(0);
  });

  it('reports a duplicate post for an already-resolved toolUseId (409 signal)', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientDeclaredTool(session, 'tu-4', 'find_files', {});
    expect(resolveClientDeclaredTool('sess-1', 'tu-4', { output: 1 })).toBe('resolved');
    expect(resolveClientDeclaredTool('sess-1', 'tu-4', { output: 2 })).toBe('duplicate');
    await p;
  });

  it('reports not_found for unknown ids and cross-session posts', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientDeclaredTool(session, 'tu-5', 'find_files', {});
    expect(resolveClientDeclaredTool('sess-1', 'nope', { output: null })).toBe('not_found');
    expect(resolveClientDeclaredTool('sess-2', 'tu-5', { output: null })).toBe('not_found');
    expect(resolveClientDeclaredTool('sess-1', 'tu-5', { output: null })).toBe('resolved');
    await p;
  });

  it('fails every pending request of one session on teardown', async () => {
    const a = fakeSession('sess-1');
    const b = fakeSession('sess-2');
    const p1 = requestClientDeclaredTool(a.session, 'tu-6', 'find_files', {});
    const p2 = requestClientDeclaredTool(b.session, 'tu-7', 'find_files', {});

    expect(failPendingClientDeclaredForSession('sess-1')).toBe(1);
    await expect(p1).resolves.toMatchObject({ error: expect.any(String) });
    expect(_pendingClientDeclaredCountForTests()).toBe(1);

    expect(resolveClientDeclaredTool('sess-2', 'tu-7', { output: null })).toBe('resolved');
    await p2;
  });
});

// ============================================
// SDK tool handler mapping
// ============================================

describe('makeClientDeclaredToolHandler', () => {
  it('maps a dispatch output to a text CallToolResult', async () => {
    const dispatch = vi.fn().mockResolvedValue({ output: { files: ['a'] } });
    const handler = makeClientDeclaredToolHandler('find_files', dispatch);
    const result = await handler({ q: 'x' });
    expect(dispatch).toHaveBeenCalledWith('find_files', { q: 'x' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe(JSON.stringify({ files: ['a'] }));
  });

  it('maps a dispatch error to an isError CallToolResult', async () => {
    const dispatch = vi.fn().mockResolvedValue({ error: 'nope' });
    const handler = makeClientDeclaredToolHandler('find_files', dispatch);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nope');
  });

  it('passes a plain string output through without double-encoding', async () => {
    const dispatch = vi.fn().mockResolvedValue({ output: 'hello' });
    const handler = makeClientDeclaredToolHandler('find_files', dispatch);
    const result = await handler({});
    expect(result.content[0].text).toBe('hello');
  });
});

// ============================================
// MCP server construction
// ============================================

describe('createClientDeclaredMcpServer', () => {
  it('builds an SDK MCP server named for the generic client-tools namespace', () => {
    const server = createClientDeclaredMcpServer([decl('find_files')], vi.fn());
    expect(server).toBeTruthy();
    expect(server.name).toBe(CLIENT_DECLARED_MCP_SERVER_NAME);
  });

  it('prefixes the MCP tool allowlist names for the declared tools', () => {
    expect(clientDeclaredToolMcpNames([decl('find_files'), decl('get_passages')])).toEqual([
      `mcp__${CLIENT_DECLARED_MCP_SERVER_NAME}__find_files`,
      `mcp__${CLIENT_DECLARED_MCP_SERVER_NAME}__get_passages`,
    ]);
  });
});
