import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ai/AiChatMessages', () => ({ default: () => <div /> }));
vi.mock('../ai/AiChatInput', () => ({ default: () => <div /> }));
vi.mock('../ai/AiContextBadge', () => ({ default: () => <div /> }));
vi.mock('../ai/AiCostIndicator', () => ({ default: () => <div /> }));

const store = {
  sendMessage: vi.fn(),
  approveExecution: vi.fn(),
  approvePlan: vi.fn(),
  abortPlan: vi.fn(),
  pauseAi: vi.fn(),
  interruptResponse: vi.fn(),
  clearError: vi.fn(),
  draftTicketFromChat: vi.fn(),
  saveTicketFromChat: vi.fn(),
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
