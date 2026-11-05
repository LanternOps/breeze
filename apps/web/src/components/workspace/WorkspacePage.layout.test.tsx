/**
 * #9840 W5 (Task 17, placement pass): the side panel is `fixed right-0
 * w-[400px]` with no backdrop on `lg+`, so while it is open it covers the right
 * end of the workspace header — "Continue in side panel" and "Create Ticket"
 * were unreachable. While the panel is open the workspace root reserves the
 * panel's width on `lg+` (below `lg` the panel has its backdrop and is an
 * overlay, so nothing is reserved there). Real workspaceStore + aiStore.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ allow: true }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: perms.allow ? [{ resource: 'ai_sessions', action: 'use' }] : [],
    can: (resource: string, action: string) => perms.allow && resource === 'ai_sessions' && action === 'use',
  }),
}));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./WorkspaceTabBar', () => ({
  default: ({ tabs }: { tabs: Array<{ id: string }> }) => (
    <div data-testid="workspace-tab-bar">
      {tabs.map((t) => <span key={t.id} data-testid={`mock-tab-${t.id}`} />)}
    </div>
  ),
}));
vi.mock('./WorkspaceChatPanel', () => ({ default: () => <div data-testid="workspace-chat-panel" /> }));
vi.mock('./WorkspaceEmptyState', () => ({ default: () => <div data-testid="workspace-empty-state" /> }));

import { fetchWithAuth } from '@/stores/auth';
import { useAiStore } from '@/stores/aiStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { abortAllAttaches } from '@/stores/aiSessionAttach';
import WorkspacePage from './WorkspacePage';

const fetchMock = vi.mocked(fetchWithAuth);
const PAD = 'lg:pr-[400px]';

beforeEach(() => {
  vi.clearAllMocks();
  perms.allow = true;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    ({ ok: false, status: 404, json: vi.fn().mockResolvedValue({}), body: null }) as unknown as Response);
  localStorage.clear();
  useWorkspaceStore.getState().cleanupAllStreams();
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  useAiStore.setState({ isOpen: false, sessionId: null, composerDraft: '', isStreaming: false });
  window.history.replaceState(null, '', '/ai/chat');
});

afterEach(() => {
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
});

describe('workspace root while the side panel is open', () => {
  it('reserves the panel width on lg+ while the panel is open', () => {
    useAiStore.setState({ isOpen: true });
    render(<WorkspacePage />);
    const root = screen.getByTestId('workspace-page');
    expect(root.className.split(/\s+/)).toContain(PAD);
    // The padding animates with the panel's own slide.
    expect(root.className).toContain('transition-[padding]');
    expect(root.className).toContain('duration-300');
  });

  it('reserves nothing while the panel is closed', () => {
    render(<WorkspacePage />);
    const root = screen.getByTestId('workspace-page');
    expect(root.className.split(/\s+/)).not.toContain(PAD);
    // Never an unconditional (below-lg) padding: there the panel is an overlay.
    expect(root.className).not.toMatch(/(^|\s)pr-\[400px\]/);
  });

  it('follows the panel as it opens and closes', () => {
    render(<WorkspacePage />);
    const root = () => screen.getByTestId('workspace-page');
    expect(root().className.split(/\s+/)).not.toContain(PAD);
    act(() => useAiStore.setState({ isOpen: true }));
    expect(root().className.split(/\s+/)).toContain(PAD);
    act(() => useAiStore.setState({ isOpen: false }));
    expect(root().className.split(/\s+/)).not.toContain(PAD);
  });

  it('the access-denied branch renders without the workspace root', () => {
    perms.allow = false;
    useAiStore.setState({ isOpen: true });
    render(<WorkspacePage />);
    expect(screen.getByTestId('workspace-access-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-page')).toBeNull();
  });
});

describe('persisted workspace tabs', () => {
  it('five persisted breeze-workspace tabs survive the move to /ai/chat', async () => {
    const ids = ['t1', 't2', 't3', 't4', 't5'];
    localStorage.setItem('breeze-workspace', JSON.stringify({
      state: {
        tabs: ids.map((id, i) => ({
          id,
          sessionId: null,
          title: `Chat ${i + 1}`,
          isTitleCustom: false,
          contextLabel: null,
          pageContext: null,
        })),
        activeTabId: 't3',
      },
      version: 0,
    }));
    window.history.replaceState(null, '', '/ai/chat');
    await act(async () => {
      await useWorkspaceStore.persist.rehydrate();
    });
    expect(useWorkspaceStore.getState().tabs).toHaveLength(5);

    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByTestId('workspace-tab-bar')).toBeInTheDocument());
    for (const id of ids) expect(screen.getByTestId(`mock-tab-${id}`)).toBeInTheDocument();
    expect(useWorkspaceStore.getState().activeTabId).toBe('t3');
  });
});
