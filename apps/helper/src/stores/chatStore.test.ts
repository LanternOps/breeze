import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/helperFetch', () => ({
  helperRequest: vi.fn(),
  getTauriInvoke: vi.fn(async () => null),
  requireDevBearerToken: vi.fn(() => 'dev-token'),
}));

import { helperRequest } from '../lib/helperFetch';
import { WORKSPACE_CHAT_TOOLS } from '../lib/workspaceChatTools';
import { processSSELines, useChatStore } from './chatStore';
import { useWorkspaceStore } from './workspaceStore';

const helperRequestMock = vi.mocked(helperRequest);
const AGENT_CONFIG = { api_url: 'http://localhost:3001', agent_id: 'agent-1' };

function ok(body: unknown, status = 200) {
  return { ok: true, status, body: JSON.stringify(body) };
}

// A tiny set/setDirect bridge onto the real store, matching how sendMessage
// wires processSSELines in production.
function run(lines: string[], currentId = { value: null as string | null }) {
  const set = (fn: (s: never) => object) => useChatStore.setState(fn as never);
  const setDirect = (partial: object) => useChatStore.setState(partial as never);
  return processSSELines(lines, currentId, set as never, setDirect as never);
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    agentConfig: AGENT_CONFIG,
    connectionState: 'connected',
    sessionId: null,
    messages: [],
    isStreaming: false,
    error: null,
    username: null,
    pendingApproval: null,
  });
  useWorkspaceStore.setState({ available: null });
});

// ---------------------------------------------------------------------------
// processSSELines regression baseline (this is the first chatStore suite, so
// pin the existing content_delta/done behavior before layering the tool loop).
// ---------------------------------------------------------------------------

describe('processSSELines — SSE baseline (regression)', () => {
  it('appends content_delta to the current streaming assistant message', async () => {
    useChatStore.setState({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'Hello',
          isStreaming: true,
          createdAt: new Date(),
        },
      ],
    });
    await run([sse({ type: 'content_delta', delta: ' world' })], { value: 'a1' });
    expect(useChatStore.getState().messages[0].content).toBe('Hello world');
  });

  it('clears isStreaming on the done event', async () => {
    useChatStore.setState({ isStreaming: true });
    await run([sse({ type: 'done' })]);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('ignores non-data and blank lines without throwing', async () => {
    await expect(run([': keep-alive', '', 'event: ping'])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// client_tool_request round-trip
// ---------------------------------------------------------------------------

describe('processSSELines — client_tool_request round-trip', () => {
  it('executes a known tool and POSTs its output to /tool-results', async () => {
    useChatStore.setState({ sessionId: 'sess-1' });
    helperRequestMock.mockImplementation(async (_config, url) => {
      if (url.includes('/workspace/helper/search')) {
        return ok({ results: [{ id: 'f1', relPath: 'a.pdf', openPath: null }] });
      }
      return ok({ ok: true });
    });

    await run([
      sse({
        type: 'client_tool_request',
        toolUseId: 't1',
        toolName: 'search_workspace_files',
        input: { q: 'henderson' },
      }),
    ]);

    const post = helperRequestMock.mock.calls.find(([, url]) => url.endsWith('/tool-results'));
    expect(post).toBeDefined();
    const body = JSON.parse(post![2]!.body as string);
    expect(body.toolUseId).toBe('t1');
    expect(body.output.files[0].fileIndexId).toBe('f1');
    expect(body.error).toBeUndefined();
  });

  it('posts {error} (not output) for an unknown tool name', async () => {
    useChatStore.setState({ sessionId: 'sess-1' });
    helperRequestMock.mockResolvedValue(ok({ ok: true }));

    await run([
      sse({ type: 'client_tool_request', toolUseId: 't2', toolName: 'no_such_tool', input: {} }),
    ]);

    const post = helperRequestMock.mock.calls.find(([, url]) => url.endsWith('/tool-results'));
    expect(post).toBeDefined();
    const body = JSON.parse(post![2]!.body as string);
    expect(body.toolUseId).toBe('t2');
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('no_such_tool');
    expect(body.output).toBeUndefined();
    // The unknown tool must not have hit any workspace endpoint.
    expect(helperRequestMock.mock.calls.every(([, url]) => url.endsWith('/tool-results'))).toBe(true);
  });

  it('appends a tool_result transcript message carrying the executor output for a known tool', async () => {
    // The server never echoes a tool_result SSE event for client-declared tools,
    // so the client must record its own executed result in the transcript —
    // otherwise ChatView's resolution map and result cards see nothing.
    useChatStore.setState({ sessionId: 'sess-1' });
    helperRequestMock.mockImplementation(async (_config, url) => {
      if (url.includes('/workspace/helper/search')) {
        return ok({ results: [{ id: 'f1', relPath: 'a.pdf', openPath: null }] });
      }
      return ok({ ok: true });
    });

    await run([
      sse({
        type: 'client_tool_request',
        toolUseId: 't1',
        toolName: 'search_workspace_files',
        input: { q: 'henderson' },
      }),
    ]);

    const result = useChatStore.getState().messages.find((m) => m.role === 'tool_result');
    expect(result).toBeDefined();
    expect(result!.toolName).toBe('search_workspace_files');
    const output = result!.toolOutput as { files: Array<{ fileIndexId: string }> };
    expect(output.files[0].fileIndexId).toBe('f1');
  });

  it('appends NO transcript message for an unknown tool (only the error POST)', async () => {
    useChatStore.setState({ sessionId: 'sess-1' });
    helperRequestMock.mockResolvedValue(ok({ ok: true }));

    await run([
      sse({ type: 'client_tool_request', toolUseId: 't2', toolName: 'no_such_tool', input: {} }),
    ]);

    expect(useChatStore.getState().messages).toHaveLength(0);
    const post = helperRequestMock.mock.calls.find(([, url]) => url.endsWith('/tool-results'));
    expect(post).toBeDefined();
  });

  it('logs console.error when the tool-results POST responds not-ok', async () => {
    useChatStore.setState({ sessionId: 'sess-1' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    helperRequestMock.mockImplementation(async (_config, url) => {
      if (url.includes('/workspace/helper/search')) {
        return { ok: true, status: 200, body: JSON.stringify({ results: [] }) };
      }
      // The /tool-results POST fails — helperRequest resolves (never throws).
      return { ok: false, status: 500, body: JSON.stringify({ error: 'boom' }) };
    });

    await run([
      sse({
        type: 'client_tool_request',
        toolUseId: 't9',
        toolName: 'search_workspace_files',
        input: { q: 'x' },
      }),
    ]);

    expect(errSpy).toHaveBeenCalledWith(
      '[Helper] tool-results POST failed:',
      500,
      expect.stringContaining('boom'),
    );
    errSpy.mockRestore();
  });

  it('does nothing when there is no active session', async () => {
    useChatStore.setState({ sessionId: null });
    await run([
      sse({
        type: 'client_tool_request',
        toolUseId: 't3',
        toolName: 'search_workspace_files',
        input: { q: 'x' },
      }),
    ]);
    expect(helperRequestMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session-create body gating on workspace availability
// ---------------------------------------------------------------------------

describe('sendMessage — clientTools declaration', () => {
  function stubStream() {
    // sendMessage streams via native fetch in non-Tauri mode; return a body-less
    // response so the stream ends immediately (we only assert the create body).
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { forEach: () => {} },
      body: null,
    })) as unknown as typeof fetch;
  }

  function createBody() {
    const create = helperRequestMock.mock.calls.find(([, url]) => url.endsWith('/chat/sessions'));
    expect(create).toBeDefined();
    return JSON.parse(create![2]!.body as string) as { clientTools?: Array<{ name: string }> };
  }

  it('omits clientTools when the workspace is not available', async () => {
    useWorkspaceStore.setState({ available: false, contentEnabled: false });
    helperRequestMock.mockResolvedValue(ok({ id: 'sess-1' }));
    stubStream();

    await useChatStore.getState().sendMessage('hi');

    expect(createBody().clientTools).toBeUndefined();
  });

  it('declares only search_workspace_files when available but content preview is off', async () => {
    useWorkspaceStore.setState({ available: true, contentEnabled: false });
    helperRequestMock.mockResolvedValue(ok({ id: 'sess-1' }));
    stubStream();

    await useChatStore.getState().sendMessage('hi');

    const names = createBody().clientTools?.map((t) => t.name);
    expect(names).toEqual(['search_workspace_files']);
  });

  it('declares both tools when available and content preview is on', async () => {
    useWorkspaceStore.setState({ available: true, contentEnabled: true });
    helperRequestMock.mockResolvedValue(ok({ id: 'sess-1' }));
    stubStream();

    await useChatStore.getState().sendMessage('hi');

    expect(createBody().clientTools).toEqual(WORKSPACE_CHAT_TOOLS);
  });

  it('cold-start: awaits the capabilities probe when available is null and includes the tools it reports', async () => {
    useWorkspaceStore.setState({ available: null, contentEnabled: null });
    // The first message beats the startup probe: resolving it flips the estate
    // to available + content on, so the created session declares both tools.
    const probeSpy = vi
      .spyOn(useWorkspaceStore.getState(), 'probe')
      .mockImplementation(async () => {
        useWorkspaceStore.setState({ available: true, contentEnabled: true });
      });
    helperRequestMock.mockResolvedValue(ok({ id: 'sess-1' }));
    stubStream();

    await useChatStore.getState().sendMessage('hi');

    expect(probeSpy).toHaveBeenCalled();
    expect(createBody().clientTools).toEqual(WORKSPACE_CHAT_TOOLS);
  });
});

// ---------------------------------------------------------------------------
// loadSession maps a persisted tool_result (with toolOutput) back into the store
// ---------------------------------------------------------------------------

describe('loadSession — persisted tool_result rehydration', () => {
  it('maps a persisted tool_result row into a tool_result message carrying toolOutput', async () => {
    useChatStore.setState({ agentConfig: AGENT_CONFIG });
    helperRequestMock.mockResolvedValue(
      ok([
        { id: 'u1', role: 'user', content: 'find henderson', toolName: null, createdAt: '2026-07-19T00:00:00Z' },
        {
          id: 'r1',
          role: 'tool_result',
          content: '{}',
          toolName: 'search_workspace_files',
          toolOutput: { files: [{ fileIndexId: 'f1', relPath: 'a.pdf', openPath: null }] },
          createdAt: '2026-07-19T00:00:01Z',
        },
        { id: 'a1', role: 'assistant', content: 'See [file:f1|a.pdf].', toolName: null, createdAt: '2026-07-19T00:00:02Z' },
      ]),
    );

    await useChatStore.getState().loadSession('sess-1');

    const result = useChatStore.getState().messages.find((m) => m.role === 'tool_result');
    expect(result).toBeDefined();
    expect(result!.toolName).toBe('search_workspace_files');
    const output = result!.toolOutput as { files: Array<{ fileIndexId: string }> };
    expect(output.files[0].fileIndexId).toBe('f1');
  });
});
