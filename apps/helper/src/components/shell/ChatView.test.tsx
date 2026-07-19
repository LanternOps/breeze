// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';

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
