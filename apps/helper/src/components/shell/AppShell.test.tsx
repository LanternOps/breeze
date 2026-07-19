// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';

// jsdom doesn't implement scrollIntoView; ChatView's messages-end effect calls
// it unconditionally on every render, which would otherwise throw the moment
// the chat branch mounts.
Element.prototype.scrollIntoView = vi.fn();

// Module-level store stand-ins (mirrors App.test.tsx): a minimal zustand-hook
// substitute callable with or without a selector, plus getState/setState, so
// AppShell — and, when the Files branch renders, WorkspacePanel underneath it —
// can read/write store state without touching the real network-backed actions.
vi.mock('../../stores/chatStore', () => {
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

vi.mock('../../stores/workspaceStore', () => {
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

import AppShell from './AppShell';
import { useChatStore } from '../../stores/chatStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

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
    sessions: [],
    sessionsLoading: false,
    initialize: vi.fn(),
    sendMessage: vi.fn(),
    clearMessages: vi.fn(),
    approveExecution: vi.fn(),
    flagSession: vi.fn(),
    setUsername: vi.fn(),
    loadSession: vi.fn(),
    loadSessions: vi.fn(),
    ...overrides,
  };
  (useChatStore as unknown as { setState: (s: unknown) => void }).setState(state);
  return state;
}

// Full WorkspaceState shape (mirrors App.test.tsx / the real store's defaults)
// so that when `available: true` renders WorkspacePanel underneath the shell,
// its destructure doesn't hit undefined.
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

// Drive the shell's `useSyncExternalStore` width tracking. jsdom's innerWidth is
// writable; a `resize` event flushes the external-store snapshot.
function setWidth(px: number) {
  (window as unknown as { innerWidth: number }).innerWidth = px;
  fireEvent(window, new Event('resize'));
}

beforeEach(() => {
  vi.clearAllMocks();
  setChatState();
  setWorkspaceState();
});

// jsdom's default innerWidth (1024) is "wide"; restore it so width tweaks in one
// test don't leak into the next.
afterEach(() => {
  setWidth(1024);
});

it('renders exactly one shell header, even with the Files panel embedded', () => {
  setWorkspaceState({ available: true });

  render(<AppShell />);

  expect(document.querySelectorAll('.helper-header')).toHaveLength(1);
});

it('lands on Files as the default main view when the workspace capability is available', () => {
  setWorkspaceState({ available: true });

  render(<AppShell />);

  expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
});

it('falls back to chat as the default main view when the workspace capability is unavailable', () => {
  setWorkspaceState({ available: false });

  render(<AppShell />);

  expect(screen.getByTestId('chat-view')).toBeInTheDocument();
});

it('shows Files, Chat, and History nav when the workspace capability is available', () => {
  setWorkspaceState({ available: true });

  render(<AppShell />);

  expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'History' })).toBeInTheDocument();
});

it('hides the Files nav when the workspace capability is unavailable', () => {
  setWorkspaceState({ available: false });

  render(<AppShell />);

  expect(screen.queryByRole('tab', { name: 'Files' })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'History' })).toBeInTheDocument();
});

it('swaps the main region to History without unmounting the shell header', () => {
  setWorkspaceState({ available: true });

  render(<AppShell />);
  expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: 'History' }));

  // The shell header survives the swap (one, still present)...
  expect(document.querySelectorAll('.helper-header')).toHaveLength(1);
  // ...and SessionHistory now occupies the main region (its empty-state copy).
  expect(screen.getByText('No conversations yet')).toBeInTheDocument();
  expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument();
});

it('returns to the previous main view when leaving History via Back', () => {
  setWorkspaceState({ available: true });

  render(<AppShell />);
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(screen.getByText('No conversations yet')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Back' }));

  // Back from History restores Files (the view we came from).
  expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
  expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
});

it('renders the Flag and New actions only in chat context', () => {
  // Chat context: chat-scoped actions present (Flag needs an active session).
  setChatState({ sessionId: 's1' });
  setWorkspaceState({ available: false });

  const { unmount } = render(<AppShell />);
  expect(screen.getByRole('button', { name: 'Flag' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  unmount();

  // Files context: the same chat-scoped actions are gone.
  setChatState({ sessionId: 's1' });
  setWorkspaceState({ available: true });

  render(<AppShell />);
  expect(screen.queryByRole('button', { name: 'Flag' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'New' })).not.toBeInTheDocument();
});

it('opens a chat side panel on wide windows while the Files panel stays mounted', () => {
  setWidth(1000);
  setWorkspaceState({ available: true });

  render(<AppShell />);
  expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
  expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('chat-toggle'));

  const panel = screen.getByTestId('chat-panel');
  expect(panel).toBeInTheDocument();
  // ChatView lives inside the side panel...
  expect(within(panel).getByTestId('chat-view')).toBeInTheDocument();
  // ...and Files is still mounted alongside it (not swapped away).
  expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
});

it('closing the chat panel unmounts it while the Files panel stays put', () => {
  setWidth(1000);
  setWorkspaceState({ available: true });

  render(<AppShell />);
  fireEvent.click(screen.getByTestId('chat-toggle'));
  expect(screen.getByTestId('chat-panel')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('chat-toggle'));

  expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
  expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
});

it('on narrow windows the chat toggle full-swaps to chat instead of opening a panel', () => {
  setWidth(500);
  setWorkspaceState({ available: true });

  render(<AppShell />);
  expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('chat-toggle'));

  // Full swap: chat occupies the main region, Files is gone, no side panel.
  expect(screen.getByTestId('chat-view')).toBeInTheDocument();
  expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument();
  expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
});

it('converts an open panel to a full swap across the breakpoint without losing composer text', () => {
  setWidth(1000);
  setWorkspaceState({ available: true });

  render(<AppShell />);
  fireEvent.click(screen.getByTestId('chat-toggle'));

  const composer = screen.getByPlaceholderText('Ask me anything...');
  fireEvent.change(composer, { target: { value: 'draft in flight' } });
  expect(composer).toHaveValue('draft in flight');

  // Shrink below the breakpoint with the panel open.
  setWidth(500);

  // Panel is gone, chat is now the full main view, and the draft survived the
  // move because it lives in shell state (single definition), not in ChatView.
  expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
  expect(screen.getByTestId('chat-view')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Ask me anything...')).toHaveValue('draft in flight');
});
