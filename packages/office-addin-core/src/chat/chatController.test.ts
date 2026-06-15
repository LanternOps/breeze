import { describe, expect, it, vi } from 'vitest';
import { ChatController, type ChatApi } from './chatController';
import { ApiError, type StreamCallbacks } from '../api/client';
import type { HostAdapter } from '../host/types';
import type { WorkbookContext } from '../api/types';

function stubApi(overrides: Partial<ChatApi> = {}): ChatApi {
  return {
    createSession: vi.fn(async () => ({
      sessionId: 'sess-1',
      writeMode: 'readwrite' as const,
      writeApproval: 'ask' as const,
    })),
    sendMessage: vi.fn(async () => undefined),
    postToolResult: vi.fn(async () => undefined),
    // Mirror the real stream: signal "open" so the first send()'s streamReady
    // gate resolves immediately (a real stream gets the server's eager ping).
    streamEvents: vi.fn((_sessionId: string, callbacks: StreamCallbacks) => {
      callbacks.onOpen?.();
      return { stop: vi.fn() };
    }),
    getSession: vi.fn(async () => ({
      session: {
        id: 'sess-1',
        status: 'active',
        title: null,
        workbookName: null,
        model: 'm',
        turnCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostCents: 0,
        createdAt: '',
        lastActivityAt: null,
      },
      messages: [],
    })),
    listSessions: vi.fn(async () => []),
    flagSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

/**
 * A neutral fake host so the controller tests never touch the Excel path. The
 * controller now REQUIRES a host; capture/preview/tool execution all route
 * through it. Individual tests override pieces (e.g. toolExecutors) as needed.
 */
function fakeHost(overrides: Partial<HostAdapter> = {}): HostAdapter {
  return {
    captureContext: async () => undefined,
    captureName: async () => undefined,
    captureSelectionAddress: async () => undefined,
    subscribeSelectionChanged: () => () => {},
    toolExecutors: {},
    mutatingTools: new Set<string>(),
    buildPreview: async (toolName: string) => ({
      kind: 'summary' as const,
      toolName,
      target: 'x',
      description: 'x',
    }),
    ...overrides,
  };
}

/** Default deps: a deterministic workbook name so create-body assertions are stable. */
function deps(api: ChatApi, captureContext: () => Promise<WorkbookContext | undefined>) {
  return { api, host: fakeHost(), captureContext, captureName: async () => 'Q3 Budget.xlsx' };
}

const SELECTION_CONTEXT: WorkbookContext = {
  kind: 'selection',
  address: 'Sheet1!B2:C3',
  sheetName: 'Sheet1',
  cells: [
    ['Region', 'Q1'],
    ['EMEA', 1200],
  ],
};

describe('ChatController — streaming', () => {
  it('accumulates message_delta text and finalizes one assistant message on turn_complete', () => {
    const controller = new ChatController({ api: stubApi(), host: fakeHost() });
    controller.handleEvent({ type: 'message_delta', text: 'Hello ' });
    controller.handleEvent({ type: 'message_delta', text: 'world' });
    expect(controller.getState().streamingText).toBe('Hello world');
    controller.handleEvent({
      type: 'turn_complete',
      usage: { inputTokens: 10, outputTokens: 5, costCents: 1 },
    });
    const state = controller.getState();
    expect(state.streamingText).toBe('');
    expect(state.busy).toBe(false);
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 5, costCents: 1 });
    expect(state.thread.filter((m) => m.kind === 'assistant')).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Hello world' }),
    ]);
  });

  it('session_error raises the error banner and clears busy', () => {
    const controller = new ChatController({ api: stubApi(), host: fakeHost() });
    controller.handleEvent({ type: 'session_error', message: 'loop exploded' });
    expect(controller.getState().banner).toEqual({ kind: 'error', text: 'loop exploded' });
    expect(controller.getState().busy).toBe(false);
  });

  it('tool_completed appends an activity row with the redaction count and raises a block banner', () => {
    const controller = new ChatController({ api: stubApi(), host: fakeHost() });
    controller.handleEvent({
      type: 'tool_completed',
      toolUseId: 'tu-1',
      toolName: 'read_range',
      status: 'success',
      redactions: [
        { rule: 'creditCard', count: 2, location: 'cell[0][0]' },
        { rule: 'ssn', count: 1, location: 'cell[1][1]' },
      ],
      blockReason: null,
    });
    expect(controller.getState().thread.at(-1)).toMatchObject({
      kind: 'tool',
      toolName: 'read_range',
      status: 'success',
      redactions: 3,
    });
    controller.handleEvent({
      type: 'tool_completed',
      toolUseId: 'tu-2',
      toolName: 'read_range',
      status: 'error',
      redactions: [],
      blockReason: 'dlp_blocked:creditCard',
    });
    expect(controller.getState().banner?.kind).toBe('blocked');
    expect(controller.getState().banner?.text).toContain('dlp_blocked:creditCard');
  });
});

describe('ChatController — send', () => {
  it('lazily creates the session, opens the stream once, and posts the pinned message body', async () => {
    const api = stubApi();
    const controller = new ChatController(deps(api, async () => SELECTION_CONTEXT));
    await controller.send('What does column B total to?');
    await controller.send('And C?');
    expect(api.createSession).toHaveBeenCalledTimes(1); // the busy guard makes the 2nd send a no-op
    expect(api.createSession).toHaveBeenCalledWith({ host: 'excel', workbookName: 'Q3 Budget.xlsx' });
    expect(api.streamEvents).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith('sess-1', {
      content: 'What does column B total to?',
      workbookContext: SELECTION_CONTEXT,
    });
    expect(controller.getState().thread[0]).toMatchObject({
      kind: 'user',
      text: 'What does column B total to?',
    });
    expect(controller.getState().busy).toBe(true);
  });

  it('defers the first message until the stream signals open (first-turn race)', async () => {
    // The stream only signals "open" once we release this gate — simulating the
    // SSE still connecting while the first send() is in flight.
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const api = stubApi({
      streamEvents: vi.fn((_sessionId: string, callbacks: StreamCallbacks) => {
        void openGate.then(() => callbacks.onOpen?.());
        return { stop: vi.fn() };
      }),
    });
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    const sent = controller.send('hello');
    // Flush the createSession/capture microtasks — control now parks on streamReady.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(api.streamEvents).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).not.toHaveBeenCalled(); // gated until the stream opens
    releaseOpen();
    await sent;
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('surfaces budget rejections as a banner and clears busy', async () => {
    const api = stubApi({
      sendMessage: vi.fn(async () => {
        throw new ApiError(403, 'budget_exceeded');
      }),
    });
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('hi');
    expect(controller.getState().busy).toBe(false);
    expect(controller.getState().banner?.text).toContain('budget');
  });

  it('routes mutating tool_requests into the approval queue without posting', async () => {
    const api = stubApi();
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('write something'); // establishes sessionId
    controller.handleEvent({
      type: 'tool_request',
      toolUseId: 'tu-w1',
      toolName: 'write_range',
      input: { address: 'B2', cells: [['x']] },
      mutating: true,
    });
    await vi.waitFor(() => expect(controller.approvals.getPending()).toHaveLength(1));
    expect(api.postToolResult).not.toHaveBeenCalled();
  });

  it('routes tool execution through an injected HostAdapter (the seam, not the Excel default)', async () => {
    const api = stubApi();
    const executed: string[] = [];
    // A fake non-Excel host: a single non-mutating tool that records calls and
    // an empty mutating set. If the controller still used the Excel default it
    // would treat write_range as mutating and never hit this executor.
    const host = fakeHost({
      toolExecutors: {
        echo: async (input: Record<string, unknown>) => {
          executed.push(String(input.value));
          return { ok: true };
        },
      },
    });
    const controller = new ChatController({ api, host });
    await controller.send('go'); // establishes sessionId
    controller.handleEvent({
      type: 'tool_request',
      toolUseId: 'tu-echo',
      toolName: 'echo',
      input: { value: 'hi' },
      mutating: false,
    });
    await vi.waitFor(() =>
      expect(api.postToolResult).toHaveBeenCalledWith('sess-1', {
        toolUseId: 'tu-echo',
        status: 'success',
        output: { ok: true },
      }),
    );
    expect(executed).toEqual(['hi']);
    // Nothing parked: this host has no mutating tools.
    expect(controller.approvals.getPending()).toHaveLength(0);
  });

  it('keeps writeApproval=ask out of the pane state under the default policy', async () => {
    const api = stubApi();
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('hi');
    expect(controller.getState().writeApproval).toBe('ask');
  });

  it('surfaces writeApproval=allow_auto into pane state when the org opts in', async () => {
    const api = stubApi({
      createSession: vi.fn(async () => ({
        sessionId: 'sess-1',
        writeMode: 'readwrite' as const,
        writeApproval: 'allow_auto' as const,
      })),
    });
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('hi');
    expect(controller.getState().writeApproval).toBe('allow_auto');
  });

  it('ignores a setAutoApply request when the org policy is ask (server-side gate is the real one, but the pane refuses too)', async () => {
    const api = stubApi(); // writeApproval: 'ask'
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('hi');
    controller.setAutoApply(true);
    expect(controller.approvals.isAutoApply()).toBe(false);
  });

  it('honors setAutoApply once the org policy allows auto', async () => {
    const api = stubApi({
      createSession: vi.fn(async () => ({
        sessionId: 'sess-1',
        writeMode: 'readwrite' as const,
        writeApproval: 'allow_auto' as const,
      })),
    });
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('hi');
    controller.setAutoApply(true);
    expect(controller.approvals.isAutoApply()).toBe(true);
  });
});

describe('ChatController — flag conversation', () => {
  it('is a no-op before a session exists (nothing to flag)', async () => {
    const api = stubApi();
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.flagConversation('looks wrong');
    expect(api.flagSession).not.toHaveBeenCalled();
  });

  it('flags the current session with the reason and shows a confirmation banner', async () => {
    const api = stubApi();
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('hi'); // establishes sessionId
    await controller.flagConversation('looks wrong');
    expect(api.flagSession).toHaveBeenCalledWith('sess-1', 'looks wrong');
    expect(controller.getState().flagged).toBe(true);
  });

  it('surfaces an error banner and stays unflagged when flagging fails', async () => {
    const api = stubApi({
      flagSession: vi.fn(async () => {
        throw new ApiError(500, 'server_error');
      }),
    });
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('hi');
    await controller.flagConversation();
    expect(controller.getState().flagged).toBe(false);
    expect(controller.getState().banner?.kind).toBe('error');
  });
});

describe('ChatController — tool-result post failures', () => {
  /** Drive a mutating tool_request into the approval queue for the active session. */
  async function enqueueWrite(controller: ChatController, toolUseId = 'tu-w1') {
    controller.handleEvent({
      type: 'tool_request',
      toolUseId,
      toolName: 'write_range',
      input: { address: 'B2', cells: [['x']] },
      mutating: true,
    });
    await vi.waitFor(() => expect(controller.approvals.getPending()).toHaveLength(1));
  }

  it('swallows the benign post-timeout 404 unknown_tool_request (no banner)', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const api = stubApi({
      postToolResult: vi.fn(async () => {
        throw new ApiError(404, 'unknown_tool_request');
      }),
    });
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('write something'); // establishes sessionId
    await enqueueWrite(controller);

    await controller.approvals.apply('tu-w1');

    // Benign: the server already gave up, so no error is shown to the user.
    expect(controller.getState().banner).toBeNull();
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });

  it('surfaces an error banner when an Apply post fails with a 5xx', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = stubApi({
      postToolResult: vi.fn(async () => {
        throw new ApiError(503, 'server_error');
      }),
    });
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('write something');
    await enqueueWrite(controller);

    await controller.approvals.apply('tu-w1');

    expect(controller.getState().banner?.kind).toBe('error');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('surfaces an error banner when an Apply post fails with a network error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = stubApi({
      postToolResult: vi.fn(async () => {
        throw new Error('Failed to fetch');
      }),
    });
    const controller = new ChatController({ api, host: fakeHost(), captureContext: async () => undefined });
    await controller.send('write something');
    await enqueueWrite(controller);

    await controller.approvals.apply('tu-w1');

    expect(controller.getState().banner?.kind).toBe('error');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('surfaces an error banner when a NON-mutating tool-result post fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const api = stubApi({
      // First send establishes the session; the tool-result post is the one that fails.
      postToolResult: vi.fn(async () => {
        calls += 1;
        throw new ApiError(500, 'server_error');
      }),
    });
    const host = fakeHost({
      toolExecutors: { echo: async () => ({ ok: true }) },
      mutatingTools: new Set<string>(), // echo is non-mutating → posts directly
    });
    const controller = new ChatController({ api, host, captureContext: async () => undefined });
    await controller.send('go'); // establishes sessionId
    controller.handleEvent({
      type: 'tool_request',
      toolUseId: 'tu-echo',
      toolName: 'echo',
      input: {},
      mutating: false,
    });

    await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
    await vi.waitFor(() => expect(controller.getState().banner?.kind).toBe('error'));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does NOT surface a banner for a benign 404 on a NON-mutating tool-result post', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    let calls = 0;
    const api = stubApi({
      postToolResult: vi.fn(async () => {
        calls += 1;
        throw new ApiError(404, 'unknown_tool_request');
      }),
    });
    const host = fakeHost({
      toolExecutors: { echo: async () => ({ ok: true }) },
      mutatingTools: new Set<string>(),
    });
    const controller = new ChatController({ api, host, captureContext: async () => undefined });
    await controller.send('go');
    controller.handleEvent({
      type: 'tool_request',
      toolUseId: 'tu-echo',
      toolName: 'echo',
      input: {},
      mutating: false,
    });

    await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
    await vi.waitFor(() => expect(debug).toHaveBeenCalled());
    expect(controller.getState().banner).toBeNull();
    debug.mockRestore();
  });
});

describe('ChatController — conversation history', () => {
  it('createSession with no captured workbook name sends an empty body', async () => {
    const api = stubApi();
    const controller = new ChatController({
      api,
      host: fakeHost(),
      captureContext: async () => undefined,
      captureName: async () => undefined,
    });
    await controller.send('hello');
    expect(api.createSession).toHaveBeenCalledWith({ host: 'excel' });
  });

  it("never lets a captureName failure block session creation", async () => {
    const api = stubApi();
    const controller = new ChatController({
      api,
      host: fakeHost(),
      captureContext: async () => undefined,
      captureName: async () => {
        throw new Error('Office unavailable');
      },
    });
    await controller.send('hello');
    expect(api.createSession).toHaveBeenCalledWith({ host: 'excel' });
    expect(api.sendMessage).toHaveBeenCalled();
  });

  it('listSessions delegates to the api', async () => {
    const item = {
      id: 's9',
      title: 'Old chat',
      workbookName: 'Forecast.xlsx',
      status: 'active',
      createdAt: '',
      lastActivityAt: null,
      updatedAt: '',
      messageCount: 2,
    };
    const api = stubApi({ listSessions: vi.fn(async () => [item]) });
    const controller = new ChatController({ api, host: fakeHost() });
    await expect(controller.listSessions()).resolves.toEqual([item]);
  });

  it('threads clientHost through createSession and listSessions (Word pane → Word registry/prompt)', async () => {
    const api = stubApi();
    const controller = new ChatController({
      api,
      host: fakeHost(),
      clientHost: 'word',
      captureContext: async () => undefined,
      captureName: async () => undefined,
    });
    await controller.send('summarize this document');
    expect(api.createSession).toHaveBeenCalledWith({ host: 'word' });
    await controller.listSessions();
    expect(api.listSessions).toHaveBeenCalledWith('word');
  });

  it('defaults clientHost to excel and passes it to listSessions', async () => {
    const item = {
      id: 's1',
      title: null,
      workbookName: null,
      status: 'active',
      createdAt: '',
      lastActivityAt: null,
      updatedAt: '',
      messageCount: 0,
    };
    const api = stubApi({ listSessions: vi.fn(async () => [item]) });
    const controller = new ChatController({ api, host: fakeHost() });
    await controller.listSessions();
    expect(api.listSessions).toHaveBeenCalledWith('excel');
  });

  it('resumeSession adopts the id, rehydrates history, and opens the stream', async () => {
    const getSession = vi.fn(async () => ({
      session: {
        id: 'past-1',
        status: 'active',
        title: 'Budget review',
        workbookName: 'Q3 Budget.xlsx',
        model: 'm',
        turnCount: 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostCents: 0,
        createdAt: '',
        lastActivityAt: null,
      },
      messages: [
        { id: 'm1', role: 'user', content: 'hi', contentBlocks: null, toolName: null, toolInput: null, toolOutput: null, toolUseId: null, createdAt: '' },
        { id: 'm2', role: 'assistant', content: 'hello', contentBlocks: null, toolName: null, toolInput: null, toolOutput: null, toolUseId: null, createdAt: '' },
      ],
    }));
    const api = stubApi({ getSession });
    const controller = new ChatController({ api, host: fakeHost() });

    await controller.resumeSession('past-1');

    expect(getSession).toHaveBeenCalledWith('past-1');
    expect(api.streamEvents).toHaveBeenCalledTimes(1);
    expect(api.streamEvents).toHaveBeenCalledWith('past-1', expect.anything());
    const thread = controller.getState().thread;
    expect(thread).toEqual([
      expect.objectContaining({ kind: 'user', text: 'hi' }),
      expect.objectContaining({ kind: 'assistant', text: 'hello' }),
    ]);
    // A subsequent send reuses the resumed session (no new create).
    await controller.send('next');
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith('past-1', expect.objectContaining({ content: 'next' }));
  });

  it('startNewSession clears the thread and forces a fresh session on next send', async () => {
    const api = stubApi();
    const controller = new ChatController(deps(api, async () => undefined));
    await controller.send('first'); // creates sess-1
    expect(api.createSession).toHaveBeenCalledTimes(1);

    controller.handleEvent({
      type: 'turn_complete',
      usage: { inputTokens: 1, outputTokens: 1, costCents: 0 },
    });
    controller.startNewSession();
    expect(controller.getState().thread).toEqual([]);
    expect(controller.getState().busy).toBe(false);

    await controller.send('second');
    expect(api.createSession).toHaveBeenCalledTimes(2); // a brand-new session
  });
});

describe('ChatController — draft & templates', () => {
  it('insertTemplate fills an empty draft and appends to a non-empty one', () => {
    const controller = new ChatController({ api: stubApi(), host: fakeHost() });
    controller.insertTemplate('Summarize this sheet.');
    expect(controller.getState().draft).toBe('Summarize this sheet.');
    controller.insertTemplate('Then list outliers.');
    expect(controller.getState().draft).toBe('Summarize this sheet.\n\nThen list outliers.');
  });
});
