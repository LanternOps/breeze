import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const permState = vi.hoisted(() => ({ canUseAi: true }));
// #6396: the sidebar is gated on ai_sessions:use; default to allowed so the
// shell tests below exercise the open/collapsed states.
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: [],
    // Argument-checked so gating on a different resource/action than the
    // Header and the API route is caught, not just "some gate exists".
    can: (resource: string, action: string) =>
      resource === 'ai_sessions' && action === 'use' && permState.canUseAi,
  }),
}));

import AiChatSidebar from './AiChatSidebar';
import { useAiStore } from '@/stores/aiStore';

vi.mock('@/stores/aiStore', () => ({ useAiStore: vi.fn() }));
// Children pull in streaming/fetch concerns irrelevant to the shell test.
vi.mock('./AiChatMessages', () => ({ default: () => null }));
vi.mock('./AiChatInput', () => ({ default: () => null }));
vi.mock('./AiContextBadge', () => ({ default: () => null }));
vi.mock('./AiCostIndicator', () => ({ default: () => null }));

const noop = vi.fn();
const baseState = {
  toggle: noop, close: noop, messages: [], isStreaming: false, isLoading: false,
  error: null, pageContext: null, pendingApproval: null, pendingPlan: null,
  activePlan: null, approvalMode: 'manual', isPaused: false, sessionId: null,
  showHistory: false, sessions: [], searchResults: [], isSearching: false,
  sendMessage: noop, approveExecution: noop, approvePlan: noop, abortPlan: noop,
  pauseAi: noop, createSession: noop, closeSession: noop, clearError: noop,
  toggleHistory: noop, loadSessions: noop, loadSession: noop,
  searchConversations: noop, switchSession: noop, interruptResponse: noop,
  isInterrupting: false, isFlagged: false, flagSession: noop, unflagSession: noop,
  m365Connections: [], selectedM365ConnectionId: null, boundM365ConnectionId: null,
  loadM365Connections: noop, setSelectedM365Connection: noop,
};

// #1419: the off-canvas shell stays mounted (transition:persist); collapsed it
// must be inert + pointer-events-none so it can't intercept clicks on wide
// layouts or expose an off-viewport Close control.
describe('AiChatSidebar collapsed-shell interactivity', () => {
  it('is inert and pointer-events-none when collapsed', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: false });
    render(<AiChatSidebar />);
    const shell = screen.getByTestId('ai-chat-sidebar');
    expect(shell).toHaveAttribute('inert');
    expect(shell.className).toContain('pointer-events-none');
  });

  it('is interactive (no inert, no pointer-events-none) when open', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true });
    render(<AiChatSidebar />);
    const shell = screen.getByTestId('ai-chat-sidebar');
    expect(shell).not.toHaveAttribute('inert');
    expect(shell.className).not.toContain('pointer-events-none');
  });
});

describe('AiChatSidebar permission gate (#6396)', () => {
  it('renders nothing when the user lacks ai_sessions:use', () => {
    permState.canUseAi = false;
    try {
      vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true });
      render(<AiChatSidebar />);
      expect(screen.queryByTestId('ai-chat-sidebar')).toBeNull();
    } finally {
      permState.canUseAi = true;
    }
  });
});
