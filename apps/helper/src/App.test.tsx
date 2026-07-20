// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';

// jsdom doesn't implement scrollIntoView; ChatView's messages-end effect
// calls it unconditionally on every render, which would otherwise throw the
// moment the chat branch mounts.
Element.prototype.scrollIntoView = vi.fn();

// Module-level store mocks: a minimal zustand-hook stand-in (callable with
// or without a selector, plus getState/setState) so App — and, when the
// Files branch renders, WorkspacePanel underneath it — can read/write store
// state without touching the real network-backed actions. Tests configure
// state per-case via the factories below instead of driving the real
// initialize()/probe() implementations.
vi.mock('./stores/chatStore', () => {
  let state: Record<string, unknown> = {};
  const useChatStore = ((selector?: (s: unknown) => unknown) =>
    (selector ? selector(state) : state)) as unknown as {
    (selector?: (s: unknown) => unknown): unknown;
    getState: () => Record<string, unknown>;
    setState: (partial: Record<string, unknown>) => void;
  };
  useChatStore.getState = () => state;
  useChatStore.setState = (partial) => {
    state = { ...state, ...partial };
  };
  return { useChatStore };
});

vi.mock('./stores/workspaceStore', () => {
  let state: Record<string, unknown> = {};
  const useWorkspaceStore = ((selector?: (s: unknown) => unknown) =>
    (selector ? selector(state) : state)) as unknown as {
    (selector?: (s: unknown) => unknown): unknown;
    getState: () => Record<string, unknown>;
    setState: (partial: Record<string, unknown>) => void;
  };
  useWorkspaceStore.getState = () => state;
  useWorkspaceStore.setState = (partial) => {
    state = { ...state, ...partial };
  };
  return { useWorkspaceStore };
});

import App from './App';
import { useChatStore } from './stores/chatStore';
import { useWorkspaceStore } from './stores/workspaceStore';

function setChatState(overrides: Record<string, unknown> = {}) {
  const state = {
    connectionState: 'connected',
    connectionError: null,
    agentConfig: { api_url: 'https://example.test', os_username: 'todd' },
    sessionId: null,
    messages: [],
    isStreaming: false,
    error: null,
    username: 'todd',
    pendingApproval: null,
    isFlagged: false,
    initialize: vi.fn(),
    sendMessage: vi.fn(),
    clearMessages: vi.fn(),
    approveExecution: vi.fn(),
    flagSession: vi.fn(),
    setUsername: vi.fn(),
    ...overrides,
  };
  (useChatStore as unknown as { setState: (s: unknown) => void }).setState(state);
  return state;
}

// Full WorkspaceState shape (mirrors the real store's defaults — see
// WorkspacePanel.test.tsx) so that when `available: true` renders
// WorkspacePanel underneath App, its destructure doesn't hit undefined.
function setWorkspaceState(overrides: Record<string, unknown> = {}) {
  const state = {
    available: null,
    features: [],
    contentEnabled: false,
    contentFeatures: [],
    sources: [],
    results: [],
    entries: [],
    recent: [],
    department: [],
    filings: [],
    projects: [],
    loading: false,
    error: null,
    filingBusy: null,
    browsePath: null,
    filters: {},
    sort: { search: null, browse: { col: 'name', dir: 'asc' }, recents: { col: 'mtime', dir: 'desc' } },
    probe: vi.fn(),
    search: vi.fn(),
    browse: vi.fn(),
    loadRecents: vi.fn(),
    recordActivity: vi.fn(),
    loadFilings: vi.fn(),
    classifyEmail: vi.fn(),
    assignFiling: vi.fn(),
    fileByDrop: vi.fn(),
    setSort: vi.fn(),
    setFilter: vi.fn(),
    clearFilter: vi.fn(),
    ...overrides,
  };
  (useWorkspaceStore as unknown as { setState: (s: unknown) => void }).setState(state);
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  setChatState();
  setWorkspaceState();
});

it('probes the workspace capability once connected with an unknown availability', () => {
  setChatState({ connectionState: 'connected', username: 'todd' });
  const ws = setWorkspaceState({ available: null });

  render(<App />);

  expect(ws.probe).toHaveBeenCalledTimes(1);
});

it('lands on Files when the workspace capability is available (today\'s land-on-Files behavior)', () => {
  setChatState({ connectionState: 'connected', username: 'todd' });
  setWorkspaceState({ available: true });

  render(<App />);

  expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
});

it('falls back to the chat view when the workspace capability is unavailable', () => {
  setChatState({ connectionState: 'connected', username: 'todd' });
  setWorkspaceState({ available: false });

  render(<App />);

  expect(screen.getByTestId('chat-view')).toBeInTheDocument();
});

it('shows a Retry button when the connection errors', () => {
  setChatState({ connectionState: 'error', connectionError: 'boom', username: 'todd' });
  setWorkspaceState({ available: null });

  render(<App />);

  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

it('shows the username prompt when no username is set yet', () => {
  setChatState({ connectionState: 'connected', username: null });
  setWorkspaceState({ available: true });

  render(<App />);

  expect(screen.getByText("What's your name?")).toBeInTheDocument();
});
