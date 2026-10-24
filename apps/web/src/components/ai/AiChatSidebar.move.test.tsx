/**
 * #9840 W3 (Task 13): the side panel's "Open in AI Assistant" control.
 *
 * Shown only for a bound, non-topology conversation outside History and
 * outside Wisp mode; it sits between History and New; it hands the session
 * and the composer draft to moveToAssistant. The joined-mid-response line
 * renders in the message area.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));
vi.mock('@/stores/aiStore', () => ({ useAiStore: vi.fn() }));
const handoff = vi.hoisted(() => ({ moveToAssistant: vi.fn(async () => 'moved') }));
vi.mock('@/stores/aiConversationHandoff', () => handoff);
vi.mock('./AiChatMessages', () => ({ default: () => <div data-testid="ai-chat-messages" /> }));
vi.mock('./AiChatInput', () => ({ default: () => null }));
vi.mock('./AiContextBadge', () => ({ default: () => null }));
vi.mock('./AiCostIndicator', () => ({ default: () => null }));
// #9840 W4: History renders the shared list; its source is tested in its own
// file and with the real stores in AiChatSidebar.history.test.tsx.
vi.mock('./useAiConversationSource', () => ({
  MIN_SEARCH_CHARS: 2,
  useAiConversationSource: () => ({ items: [], query: '', setQuery: () => undefined, isLoading: false, isSearching: false, error: null }),
}));
vi.mock('./WispToggle', () => ({ default: () => null }));
vi.mock('./WispThreadHeader', () => ({ default: () => null }));
vi.mock('./WispThreadAttachments', () => ({ default: () => null }));
vi.mock('./WispConcernsPanel', () => ({ WispConcernsPanel: () => null }));

import AiChatSidebar from './AiChatSidebar';
import { useAiStore } from '@/stores/aiStore';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const noop = vi.fn();
const baseState = {
  isOpen: true, toggle: noop, close: noop, messages: [], isStreaming: false, isLoading: false,
  error: null, pageContext: null, pendingApproval: null, pendingPlan: null,
  activePlan: null, approvalMode: 'manual', isPaused: false, sessionId: SID, hydratedSessionId: SID,
  showHistory: false, sessions: [],
  sendMessage: noop, approveExecution: noop, approvePlan: noop, abortPlan: noop,
  pauseAi: noop, createSession: noop, closeSession: noop, clearError: noop,
  toggleHistory: noop, loadSessions: noop, loadSession: noop,
  switchSession: noop, interruptResponse: noop,
  isInterrupting: false, isFlagged: false, flagSession: noop, unflagSession: noop,
  m365Connections: [], selectedM365ConnectionId: null, boundM365ConnectionId: null,
  loadM365Connections: noop, setSelectedM365Connection: noop,
  composerDraft: 'half typed', setComposerDraft: noop, topologySiteId: null, wisp: null,
  joinedMidResponse: false,
};
const withState = (over: Record<string, unknown> = {}) =>
  vi.mocked(useAiStore).mockReturnValue({ ...baseState, ...over } as never);

const button = () => screen.queryByTestId('ai-open-in-assistant');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Open in AI Assistant', () => {
  it('renders for a bound conversation, titled, between History and New', () => {
    withState();
    render(<AiChatSidebar />);
    const open = button();
    expect(open).not.toBeNull();
    expect(open).toHaveAttribute('title', 'Open in AI Assistant');
    const titles = [...open!.parentElement!.querySelectorAll('button')].map((b) => b.getAttribute('title'));
    const at = titles.indexOf('Open in AI Assistant');
    expect(titles[at - 1]).toBe('Conversation history');
    expect(titles[at + 1]).toBe('New conversation');
  });

  it('hands the session and the composer draft to moveToAssistant', () => {
    withState();
    render(<AiChatSidebar />);
    fireEvent.click(button()!);
    expect(handoff.moveToAssistant).toHaveBeenCalledWith(SID, { draft: 'half typed' });
  });

  it.each([
    ['no bound session', { sessionId: null }],
    ['History is open', { showHistory: true }],
    ['a topology investigation (D4)', { topologySiteId: 'site-1' }],
    ['Wisp mode', { wisp: { grantId: 'g', threadId: 'th', scopeOrgId: null, focusOrgId: null, focusOrgName: null, wideningAvailable: false } }],
  ])('is hidden with %s', (_l, over) => {
    withState(over);
    render(<AiChatSidebar />);
    expect(button()).toBeNull();
  });
});

describe('joined mid-response', () => {
  it('shows the line beside the messages while joinedMidResponse', () => {
    withState({ joinedMidResponse: true });
    render(<AiChatSidebar />);
    expect(screen.getByTestId('ai-joined-mid-response')).toHaveTextContent(
      'Joined mid-response. The full reply appears when it finishes.',
    );
  });

  it('is absent otherwise', () => {
    withState();
    render(<AiChatSidebar />);
    expect(screen.queryByTestId('ai-joined-mid-response')).toBeNull();
  });
});
