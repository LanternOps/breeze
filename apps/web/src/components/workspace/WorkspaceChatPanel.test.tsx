import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the props the panel forwards, so the tab-id closure on
// onIntentDecided can be asserted against the RENDERED tab.
const messagesHarness = vi.hoisted(() => ({ props: null as Record<string, any> | null }));
vi.mock('../ai/AiChatMessages', () => ({
  default: (props: Record<string, any>) => {
    messagesHarness.props = props;
    return <div />;
  },
}));
const inputHarness = vi.hoisted(() => ({ props: null as Record<string, any> | null }));
vi.mock('../ai/AiChatInput', () => ({
  default: (props: Record<string, any>) => {
    inputHarness.props = props;
    return <div />;
  },
}));
vi.mock('./WorkspaceSessionChips', () => ({
  default: (props: Record<string, any>) => <div data-testid="chips" data-props={JSON.stringify(props)} />,
}));
vi.mock('../ai/AiContextBadge', () => ({ default: () => <div /> }));
vi.mock('../ai/AiCostIndicator', () => ({ default: () => <div /> }));

const store = {
  sendMessage: vi.fn(),
  approveExecution: vi.fn(),
  clearPendingApproval: vi.fn(),
  approvePlan: vi.fn(),
  abortPlan: vi.fn(),
  pauseAi: vi.fn(),
  interruptResponse: vi.fn(),
  clearError: vi.fn(),
  draftTicketFromChat: vi.fn(),
  saveTicketFromChat: vi.fn(),
  setComposerDraft: vi.fn(),
};

vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: () => store }));

import WorkspaceChatPanel from './WorkspaceChatPanel';

const baseTab = (over = {}) => ({
  id: 't',
  sessionId: 's1',
  messages: [],
  pageContext: null,
  error: null,
  isLoading: false,
  isStreaming: false,
  isInterrupting: false,
  pendingApproval: null,
  pendingPlan: null,
  activePlan: null,
  approvalMode: 'auto',
  isPaused: false,
  ...over,
});

describe('WorkspaceChatPanel - Create Ticket button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables the button until there is an assistant message', () => {
    render(<WorkspaceChatPanel tab={baseTab({ messages: [{ role: 'user', content: 'hi' }] }) as any} />);

    expect(screen.getByRole('button', { name: /create ticket/i })).toBeDisabled();
  });

  it('enables the button once an assistant message exists', () => {
    render(
      <WorkspaceChatPanel
        tab={baseTab({
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'done' },
          ],
        }) as any}
      />,
    );

    expect(screen.getByRole('button', { name: /create ticket/i })).toBeEnabled();
  });

  it('opens the modal and drafts a ticket when the enabled button is clicked', async () => {
    store.draftTicketFromChat.mockResolvedValueOnce({
      subject: 'Outlook would not open',
      problemSummary: 'Outlook would not start.',
      resolutionSummary: '',
      suggestedStatus: 'open',
      suggestedTimeMinutes: 10,
      elapsedMinutes: 12,
      orgId: 'o1',
      orgName: 'Acme',
      deviceId: null,
      deviceHostname: null,
    });

    render(
      <WorkspaceChatPanel
        tab={baseTab({
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'done' },
          ],
        }) as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create ticket/i }));

    await waitFor(() => expect(store.draftTicketFromChat).toHaveBeenCalledWith('t'));
    expect(screen.getByTestId('create-ticket-from-chat-modal')).toBeInTheDocument();
  });
});

describe('WorkspaceChatPanel - onIntentDecided', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messagesHarness.props = null;
  });

  it('forwards onIntentDecided as clearPendingApproval bound to the rendered tab id', () => {
    render(<WorkspaceChatPanel tab={baseTab({ id: 'tab-b' }) as any} />);

    messagesHarness.props!.onIntentDecided();

    // The multi-tab failure mode is clearing the wrong tab: assert the id, not
    // just that the action fired.
    expect(store.clearPendingApproval).toHaveBeenCalledWith('tab-b');
    expect(store.clearPendingApproval).toHaveBeenCalledTimes(1);
  });

  it('does not clear anything on render alone', () => {
    render(<WorkspaceChatPanel tab={baseTab() as any} />);

    expect(store.clearPendingApproval).not.toHaveBeenCalled();
  });
});

describe('WorkspaceChatPanel - move to the side panel, draft, chips (#9840 W3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inputHarness.props = null;
  });

  it('the header "Continue in side panel" button calls onContinueInPanel; Create Ticket stays unique', () => {
    const onContinueInPanel = vi.fn();
    render(<WorkspaceChatPanel tab={baseTab() as any} onContinueInPanel={onContinueInPanel} />);
    fireEvent.click(screen.getByTestId('workspace-continue-in-panel'));
    expect(onContinueInPanel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('workspace-continue-in-panel')).toHaveTextContent('Continue in side panel');
    expect(screen.getAllByRole('button', { name: /create ticket/i })).toHaveLength(1);
  });

  it('no header move button for a tab without a session', () => {
    render(<WorkspaceChatPanel tab={baseTab({ sessionId: null }) as any} onContinueInPanel={vi.fn()} />);
    expect(screen.queryByTestId('workspace-continue-in-panel')).toBeNull();
  });

  it('errorAction continue_in_panel → the banner offers the side panel', () => {
    const onContinueInPanel = vi.fn();
    render(
      <WorkspaceChatPanel
        tab={baseTab({ error: 'Continue in side panel to choose a model', errorAction: 'continue_in_panel' }) as any}
        onContinueInPanel={onContinueInPanel}
      />,
    );
    const banner = screen.getByTestId('workspace-error-banner');
    expect(banner).toHaveTextContent('Continue in side panel to choose a model');
    fireEvent.click(screen.getByTestId('workspace-error-continue-in-panel'));
    expect(onContinueInPanel).toHaveBeenCalledTimes(1);
  });

  it('a plain error shows no banner action', () => {
    render(<WorkspaceChatPanel tab={baseTab({ error: 'Failed to send message', errorAction: null }) as any} onContinueInPanel={vi.fn()} />);
    expect(screen.getByTestId('workspace-error-banner')).toHaveTextContent('Failed to send message');
    expect(screen.queryByTestId('workspace-error-continue-in-panel')).toBeNull();
  });

  it('the composer is controlled by the tab’s draft', () => {
    render(<WorkspaceChatPanel tab={baseTab({ id: 'tab-c', composerDraft: 'carried over' }) as any} />);
    expect(inputHarness.props!.value).toBe('carried over');
    inputHarness.props!.onValueChange('next');
    expect(store.setComposerDraft).toHaveBeenCalledWith('tab-c', 'next');
  });

  it('shows the joined-mid-response line only while joinedMidResponse', () => {
    const { rerender } = render(<WorkspaceChatPanel tab={baseTab({ joinedMidResponse: true }) as any} />);
    expect(screen.getByTestId('workspace-joined-mid-response')).toHaveTextContent(
      'Joined mid-response. The full reply appears when it finishes.',
    );
    rerender(<WorkspaceChatPanel tab={baseTab({ joinedMidResponse: false }) as any} />);
    expect(screen.queryByTestId('workspace-joined-mid-response')).toBeNull();
  });

  it('passes the tab’s chip fields to WorkspaceSessionChips', () => {
    render(<WorkspaceChatPanel tab={baseTab({ orgId: 'o1', deviceLabel: 'h1', m365ConnectionId: 'c1' }) as any} />);
    expect(JSON.parse(screen.getByTestId('chips').getAttribute('data-props')!)).toEqual({
      orgId: 'o1', deviceLabel: 'h1', m365ConnectionId: 'c1',
    });
  });
});
