import { fireEvent, render, screen } from '@testing-library/react';
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
import { useFeaturesStore } from '@/stores/featuresStore';

vi.mock('@/stores/aiStore', () => ({ useAiStore: vi.fn() }));
// Children pull in streaming/fetch concerns irrelevant to the shell test.
vi.mock('./AiChatMessages', () => ({ default: () => null }));
vi.mock('./AiChatInput', () => ({ default: () => null }));
vi.mock('./AiContextBadge', () => ({ default: () => null }));
vi.mock('./AiCostIndicator', () => ({ default: () => null }));
// #9840 W4: History renders the shared list; its source is tested in its own
// file and with the real stores in AiChatSidebar.history.test.tsx.
vi.mock('./useAiConversationSource', () => ({
  MIN_SEARCH_CHARS: 2,
  useAiConversationSource: () => ({ items: [], query: '', setQuery: () => undefined, isLoading: false, isSearching: false, error: null }),
}));

const noop = vi.fn();
const baseState = {
  toggle: noop, close: noop, messages: [], isStreaming: false, isLoading: false,
  error: null, pageContext: null, pendingApproval: null, pendingPlan: null,
  activePlan: null, approvalMode: 'manual', isPaused: false, sessionId: null,
  showHistory: false, sessions: [],
  sendMessage: noop, approveExecution: noop, approvePlan: noop, abortPlan: noop,
  pauseAi: noop, createSession: noop, closeSession: noop, clearError: noop,
  toggleHistory: noop, loadSessions: noop, loadSession: noop,
  switchSession: noop, interruptResponse: noop,
  isInterrupting: false, isFlagged: false, flagSession: noop, unflagSession: noop,
  m365Connections: [], selectedM365ConnectionId: null, boundM365ConnectionId: null,
  loadM365Connections: noop, setSelectedM365Connection: noop,
  // #9840 W3: the Open in Breeze AI control reads both.
  topologySiteId: null, wisp: null,
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

// #7150 (same as HelpPanel): a collapsed panel's shadow bleeds back onto the
// right edge of the viewport, so shadow-2xl must apply only while open.
describe('AiChatSidebar shadow', () => {
  it('has no shadow when collapsed', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: false });
    render(<AiChatSidebar />);
    expect(screen.getByTestId('ai-chat-sidebar').className).not.toContain('shadow-2xl');
  });

  it('has a shadow when open', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true });
    render(<AiChatSidebar />);
    expect(screen.getByTestId('ai-chat-sidebar').className).toContain('shadow-2xl');
  });
});

// #10107: the open panel was `fixed top-0 h-full`, so it covered the right end
// of the app header (h-16): the bell, theme and account menu sat under it and
// a click on them landed on the panel. The panel and its small-screen backdrop
// must start below the header so the header stays usable while the panel is open.
describe('AiChatSidebar leaves the app header uncovered (#10107)', () => {
  const classesOf = (testId: string) => screen.getByTestId(testId).className.split(/\s+/);

  it('docks the open panel below the header, not over it', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true });
    render(<AiChatSidebar />);
    const classes = classesOf('ai-chat-sidebar');
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'top-16', 'bottom-0', 'right-0']));
    expect(classes).not.toContain('top-0');
    expect(classes).not.toContain('h-full');
  });

  it('never overflows a viewport narrower than the panel', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true });
    render(<AiChatSidebar />);
    expect(classesOf('ai-chat-sidebar')).toContain('max-w-full');
  });

  it('starts the small-screen backdrop below the header too', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true });
    render(<AiChatSidebar />);
    const classes = classesOf('ai-chat-sidebar-backdrop');
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'top-16', 'bottom-0', 'lg:hidden']));
    expect(classes).not.toContain('inset-0');
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

describe('AiChatSidebar pre-session model menu (partner scope)', () => {
  it('loads the menu for the org a new chat would land in, never a sessionId', async () => {
    const { useAiModelPickerStore } = await import('@/stores/aiModelPickerStore');
    const load = vi.fn(async () => undefined);
    const original = useAiModelPickerStore.getState().load;
    useAiModelPickerStore.setState({ load, choices: null });
    try {
      vi.mocked(useAiStore).mockReturnValue({
        ...baseState, isOpen: true,
        pageContext: { type: 'device', id: 'd1', hostname: 'h', orgId: 'org-9' },
      });
      render(<AiChatSidebar />);
      expect(load).toHaveBeenCalledWith({ orgId: 'org-9' });
    } finally {
      useAiModelPickerStore.setState({ load: original });
    }
  });

  describe('credits exhausted banner (#9450)', () => {
    const exhausted = { ...baseState, isOpen: true, error: 'You are out of AI credits. Purchase more credits to continue.', errorCode: 'credits_exhausted' };
    const setHosted = (billing: boolean) =>
      useFeaturesStore.setState({ features: { ...useFeaturesStore.getState().features, billing }, loaded: true });

    it('offers a Buy credits link to the billing credits page on hosted', () => {
      setHosted(true);
      vi.mocked(useAiStore).mockReturnValue(exhausted);
      render(<AiChatSidebar />);
      expect(screen.getByText(/out of AI credits/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Buy credits' })).toHaveAttribute('href', '/billing/credits');
    });

    it('shows the error but no Buy credits link when billing is not configured (self-hosted)', () => {
      setHosted(false);
      vi.mocked(useAiStore).mockReturnValue(exhausted);
      render(<AiChatSidebar />);
      expect(screen.getByText(/out of AI credits/)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Buy credits' })).toBeNull();
    });

    it('does not offer Buy credits for other errors', () => {
      setHosted(true);
      vi.mocked(useAiStore).mockReturnValue({ ...exhausted, error: 'Rate limit exceeded', errorCode: null });
      render(<AiChatSidebar />);
      expect(screen.queryByRole('link', { name: 'Buy credits' })).toBeNull();
    });
  });
});

// #9613: with Shift held the browser reports KeyboardEvent.key as "A" (capital),
// so the handler must not compare against lowercase "a" only.
describe('AiChatSidebar keyboard shortcut (#9613)', () => {
  function setup() {
    permState.canUseAi = true;
    const toggle = vi.fn();
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, toggle, isOpen: false });
    render(<AiChatSidebar />);
    return toggle;
  }

  it.each([
    ['Ctrl+Shift+A (key "A")', { key: 'A', ctrlKey: true, shiftKey: true }],
    ['Cmd+Shift+A (key "A")', { key: 'A', metaKey: true, shiftKey: true }],
    ['Ctrl+Shift+a (key "a")', { key: 'a', ctrlKey: true, shiftKey: true }],
  ])('toggles on %s', (_label, init) => {
    const toggle = setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { ...init, cancelable: true }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('does not toggle without Shift or without a modifier', () => {
    const toggle = setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', shiftKey: true }));
    expect(toggle).not.toHaveBeenCalled();
  });
});

// Wisp W04 Task 8: the panel's Wisp mode. Children are stubbed — their own
// suites cover them; this pins where the sidebar mounts them. W05 (#10136)
// removed the "Turn on Wisp" toggle: the grant decides the voice
// (AiChatSidebar.wispHome.test.tsx covers the lookup).
vi.mock('./WispThreadHeader', () => ({
  default: (p: { wideningAvailable: boolean; orgName: string | null }) => (
    <div data-testid="wisp-header-stub" data-widening={String(p.wideningAvailable)} data-org={p.orgName ?? ''} />
  ),
}));
vi.mock('./WispThreadAttachments', () => ({ default: () => <div data-testid="wisp-attachments-stub" /> }));

describe('AiChatSidebar Wisp mode (W04)', () => {
  const wisp = {
    grantId: 'g-1', threadId: 't-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null, status: 'active',
    expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200, floorTickMinutes: 30, wideningAvailable: true,
  };

  it('without Wisp mode the header says Breeze AI and offers no Wisp toggle', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true, wisp: null });
    render(<AiChatSidebar />);
    expect(screen.queryByTestId('wisp-header-stub')).toBeNull();
    expect(screen.getByText('Breeze AI')).toBeInTheDocument();
    expect(screen.queryByTestId('wisp-toggle')).toBeNull();
    expect(screen.queryByText('Turn on Wisp')).toBeNull();
  });

  it('renders WispThreadHeader and the Wisp title when wisp is set', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true, wisp });
    render(<AiChatSidebar />);
    expect(screen.getByText('Wisp')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-header-stub')).toHaveAttribute('data-widening', 'true');
  });

  it('shows the thread attachments behind a disclosure', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true, wisp });
    render(<AiChatSidebar />);
    expect(screen.queryByTestId('wisp-attachments-stub')).toBeNull();
    const toggle = screen.getByTestId('wisp-attachments-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByTestId('wisp-attachments-stub')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

// #9840 W5: the E2E (e2e-tests/tests/ai-move-conversation.spec.ts) drives the
// header by data-testid only. Each id must sit on the control it names.
describe('AiChatSidebar header test ids (#9840 W5)', () => {
  it('History, New and Close carry their ids and their own handlers', () => {
    const toggleHistory = vi.fn();
    const close = vi.fn();
    const closeSession = vi.fn(async () => undefined);
    vi.mocked(useAiStore).mockReturnValue({
      ...baseState, isOpen: true, sessionId: 's-1', toggleHistory, close, closeSession,
    });
    render(<AiChatSidebar />);
    fireEvent.click(screen.getByTestId('ai-chat-history-toggle'));
    expect(toggleHistory).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('ai-chat-close'));
    expect(close).toHaveBeenCalledTimes(1);
    expect(closeSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ai-chat-new-conversation'));
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(toggleHistory).toHaveBeenCalledTimes(1);
  });

  it('New is absent without a bound session; History and Close are always there', () => {
    vi.mocked(useAiStore).mockReturnValue({ ...baseState, isOpen: true, sessionId: null });
    render(<AiChatSidebar />);
    expect(screen.getByTestId('ai-chat-history-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('ai-chat-close')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-new-conversation')).toBeNull();
  });
});
