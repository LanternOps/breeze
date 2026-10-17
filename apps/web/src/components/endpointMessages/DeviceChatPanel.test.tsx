import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  openConversation: vi.fn(),
  sendChatMessage: vi.fn(),
  closeConversation: vi.fn(),
}));
const pollers = vi.hoisted(() => [] as Array<{ opts: any; start: any; stop: any }>);
vi.mock('@/lib/endpointChat', async (orig) => ({
  ...(await orig<typeof import('@/lib/endpointChat')>()),
  ...api,
  createConversationPoller: (opts: any) => {
    const p = { opts, start: vi.fn(), stop: vi.fn() };
    pollers.push(p);
    return { start: p.start, stop: p.stop };
  },
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/shared/Toast', () => ({ showToast: toast }));

import { ActionError } from '@/lib/runAction';
import DeviceChatPanel from './DeviceChatPanel';

const CID = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

const conv = (over: Record<string, unknown> = {}) => ({
  id: CID, orgId: 'o', deviceId: DEVICE, status: 'open', allowUserReply: true, targetUsername: 'alice',
  errorCode: null, closeReason: null, openedBy: { id: 'u', name: 'Tess Tech' },
  createdAt: '2026-10-17T10:00:00.000Z', lastActivityAt: '2026-10-17T10:00:00.000Z', closedAt: null, ...over,
});
const m = (id: string, direction: 'to_user' | 'from_user', body: string, over: Record<string, unknown> = {}) => ({
  id, conversationId: CID, direction, body, senderName: direction === 'to_user' ? 'Tess Tech' : null,
  senderUsername: direction === 'from_user' ? 'CORP\\alice' : null,
  createdAt: '2026-10-17T10:00:01.000Z', deliveredAt: null, errorCode: null, ...over,
});

const supportedProps = { deviceId: DEVICE, osType: 'windows', agentVersion: '999.0.0' };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  pollers.length = 0;
  toast.mockReset();
  window.location.hash = '#chat';
  api.listConversations.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe('DeviceChatPanel — unsupported', () => {
  it.each([
    ['macos', '999.0.0'],
    ['windows', '0.100.0'],
  ])('shows the unsupported copy and no composer (%s / %s)', (osType, agentVersion) => {
    render(<DeviceChatPanel deviceId={DEVICE} osType={osType} agentVersion={agentVersion} />);
    expect(screen.getByTestId('chat-unsupported').textContent).toBe(
      'No chat on this device. Chat needs Breeze Assist on a Windows console session.',
    );
    expect(screen.queryByTestId('chat-start-body')).toBeNull();
    expect(screen.queryByTestId('chat-message-body')).toBeNull();
    expect(api.listConversations).not.toHaveBeenCalled();
  });
});

describe('DeviceChatPanel — supported', () => {
  it('lists recent conversations and never starts anything on mount', async () => {
    api.listConversations.mockResolvedValue([conv()]);
    render(<DeviceChatPanel {...supportedProps} />);
    expect(await screen.findByTestId(`chat-conversation-${CID}`)).toBeTruthy();
    expect(api.listConversations).toHaveBeenCalledWith(DEVICE);
    expect(api.openConversation).not.toHaveBeenCalled();
    expect(api.getConversation).not.toHaveBeenCalled();
    expect(pollers).toHaveLength(0);
    expect(screen.getByText('The user sees this as a chat window. A chat never grants remote access.')).toBeTruthy();
  });

  it('requires a first message, validates with the shared checker, and counts characters', async () => {
    render(<DeviceChatPanel {...supportedProps} />);
    const body = await screen.findByTestId('chat-start-body');
    const start = screen.getByTestId('chat-start-submit') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByTestId('chat-start-counter').textContent).toContain('0 / 2000');
    fireEvent.change(body, { target: { value: '<b>hi</b>' } });
    expect(start.disabled).toBe(true);
    expect(screen.getByTestId('chat-start-issues').textContent).toContain('HTML is not allowed');
    fireEvent.change(body, { target: { value: 'hello' } });
    expect(start.disabled).toBe(false);
    expect(screen.getByTestId('chat-start-counter').textContent).toContain('5 / 2000');
  });

  it('opens a conversation through the API client with a client uuid, writes it to the hash and polls', async () => {
    api.openConversation.mockResolvedValue({ conversation: conv({ status: 'opening' }), messages: [m('m1', 'to_user', 'hello')] });
    render(<DeviceChatPanel {...supportedProps} />);
    fireEvent.change(await screen.findByTestId('chat-start-body'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-start-submit'));
    await waitFor(() => expect(api.openConversation).toHaveBeenCalledTimes(1));
    const [input] = api.openConversation.mock.calls[0]!;
    expect(input).toMatchObject({ deviceId: DEVICE, body: 'hello' });
    expect(input.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(window.location.hash).toBe(`#chat/${CID}`));
    expect((await screen.findByTestId('chat-status')).textContent).toContain('Waiting for the user');
    await waitFor(() => expect(pollers.at(-1)?.start).toHaveBeenCalled());
  });

  it('reuses the same conversationId when the same first message is retried', async () => {
    api.openConversation.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ conversation: conv(), messages: [] });
    render(<DeviceChatPanel {...supportedProps} />);
    fireEvent.change(await screen.findByTestId('chat-start-body'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-start-submit'));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('chat-start-submit'));
    await waitFor(() => expect(api.openConversation).toHaveBeenCalledTimes(2));
    expect(api.openConversation.mock.calls[1]![0].conversationId).toBe(api.openConversation.mock.calls[0]![0].conversationId);
  });

  it('swallows an ActionError 401 (auth redirect handles it) without a toast or error line', async () => {
    api.openConversation.mockRejectedValue(new ActionError('expired', 401));
    render(<DeviceChatPanel {...supportedProps} />);
    fireEvent.change(await screen.findByTestId('chat-start-body'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-start-submit'));
    await waitFor(() => expect(api.openConversation).toHaveBeenCalled());
    await act(async () => {});
    expect(toast).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-start-error')).toBeNull();
  });

  it('does not double-toast an ActionError (runAction already toasted) but shows a specific line for known codes', async () => {
    api.openConversation.mockRejectedValue(new ActionError('x', 409, undefined, { error: 'device_offline' }));
    render(<DeviceChatPanel {...supportedProps} />);
    fireEvent.change(await screen.findByTestId('chat-start-body'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-start-submit'));
    expect((await screen.findByTestId('chat-start-error')).textContent).toContain('offline');
    expect(toast).not.toHaveBeenCalled();
  });

  it('offers to open the existing conversation on conversation_active', async () => {
    api.openConversation.mockRejectedValue(new ActionError('x', 409, undefined, { error: 'conversation_active', conversationId: CID }));
    api.getConversation.mockResolvedValue({ conversation: conv(), messages: [m('m1', 'to_user', 'earlier')] });
    render(<DeviceChatPanel {...supportedProps} />);
    fireEvent.change(await screen.findByTestId('chat-start-body'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('chat-start-submit'));
    fireEvent.click(await screen.findByTestId('chat-open-existing'));
    await waitFor(() => expect(window.location.hash).toBe(`#chat/${CID}`));
    expect(await screen.findByText('earlier')).toBeTruthy();
  });

  it('reads the selected conversation from the hash and loads it', async () => {
    window.location.hash = `#chat/${CID}`;
    api.getConversation.mockResolvedValue({
      conversation: conv(),
      messages: [m('m1', 'to_user', 'Please reboot'), m('m2', 'from_user', 'ok doing it')],
    });
    render(<DeviceChatPanel {...supportedProps} />);
    await screen.findByText('Please reboot');
    expect(api.getConversation).toHaveBeenCalledWith(CID);
    // technician vs user clearly distinguished, attested username shown
    expect(screen.getByTestId('chat-message-m1').getAttribute('data-direction')).toBe('to_user');
    const reply = screen.getByTestId('chat-message-m2');
    expect(reply.getAttribute('data-direction')).toBe('from_user');
    expect(reply.textContent).toContain('CORP\\alice');
    await waitFor(() => expect(pollers.at(-1)?.start).toHaveBeenCalled());
  });

  it('renders bodies as plain text, never as HTML', async () => {
    window.location.hash = `#chat/${CID}`;
    api.getConversation.mockResolvedValue({ conversation: conv(), messages: [m('m1', 'from_user', '<img src=x onerror=alert(1)>')] });
    render(<DeviceChatPanel {...supportedProps} />);
    const node = await screen.findByTestId('chat-message-m1');
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it.each([
    ['chat_requires_assist', 'needs Breeze Assist on a Windows console session'],
    ['agent_unsupported', 'does not support chat'],
    ['open_timeout', 'did not respond'],
    ['chat_window_failed', 'could not show the chat window'],
  ])('failed conversation with errorCode %s renders its localized line', async (errorCode, expected) => {
    window.location.hash = `#chat/${CID}`;
    api.getConversation.mockResolvedValue({ conversation: conv({ status: 'failed', errorCode }), messages: [] });
    render(<DeviceChatPanel {...supportedProps} />);
    expect((await screen.findByTestId('chat-status')).textContent).toContain(expected);
    expect(screen.queryByTestId('chat-message-body')).toBeNull();
    expect(screen.queryByTestId('chat-end')).toBeNull();
  });

  it('sends a message with a client messageId via the API client and appends it', async () => {
    window.location.hash = `#chat/${CID}`;
    api.getConversation.mockResolvedValue({ conversation: conv(), messages: [] });
    api.sendChatMessage.mockResolvedValue({ message: m('m9', 'to_user', 'next step') });
    render(<DeviceChatPanel {...supportedProps} />);
    fireEvent.change(await screen.findByTestId('chat-message-body'), { target: { value: 'next step' } });
    fireEvent.click(screen.getByTestId('chat-message-send'));
    await waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(api.sendChatMessage.mock.calls[0]![0]).toBe(CID);
    expect(api.sendChatMessage.mock.calls[0]![1]).toMatchObject({ body: 'next step' });
    expect(api.sendChatMessage.mock.calls[0]![1].messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByTestId('chat-message-m9')).toBeTruthy();
    expect((screen.getByTestId('chat-message-body') as HTMLTextAreaElement).value).toBe('');
  });

  it('marks an undelivered technician message', async () => {
    window.location.hash = `#chat/${CID}`;
    api.getConversation.mockResolvedValue({
      conversation: conv(),
      messages: [m('m1', 'to_user', 'lost', { errorCode: 'chat_window_failed' })],
    });
    render(<DeviceChatPanel {...supportedProps} />);
    expect((await screen.findByTestId('chat-undelivered-m1')).textContent).toContain('Not delivered');
  });

  it('End chat closes through the API client', async () => {
    window.location.hash = `#chat/${CID}`;
    api.getConversation.mockResolvedValue({ conversation: conv(), messages: [] });
    api.closeConversation.mockResolvedValue({ conversation: conv({ status: 'closed', closeReason: 'technician' }) });
    render(<DeviceChatPanel {...supportedProps} />);
    fireEvent.click(await screen.findByTestId('chat-end'));
    await waitFor(() => expect(api.closeConversation).toHaveBeenCalledWith(CID, expect.any(Object)));
    await waitFor(() => expect(screen.queryByTestId('chat-message-body')).toBeNull());
    expect(screen.getByTestId('chat-status').textContent).toContain('ended');
  });

  it('applies poller updates (merge by id) and stops the poller on unmount', async () => {
    window.location.hash = `#chat/${CID}`;
    api.getConversation.mockResolvedValue({ conversation: conv(), messages: [m('m1', 'to_user', 'hi')] });
    const { unmount } = render(<DeviceChatPanel {...supportedProps} />);
    await screen.findByText('hi');
    await waitFor(() => expect(pollers.length).toBeGreaterThan(0));
    const poller = pollers.at(-1)!;
    act(() => {
      poller.opts.onUpdate({ conversation: conv(), messages: [m('m1', 'to_user', 'hi'), m('m2', 'from_user', 'hello back')] });
    });
    expect(await screen.findByText('hello back')).toBeTruthy();
    expect(screen.getAllByTestId(/^chat-message-m/)).toHaveLength(2);
    unmount();
    expect(poller.stop).toHaveBeenCalled();
  });

  it('Back to the list clears the selection from the hash', async () => {
    window.location.hash = `#chat/${CID}`;
    api.getConversation.mockResolvedValue({ conversation: conv({ status: 'closed' }), messages: [] });
    render(<DeviceChatPanel {...supportedProps} />);
    fireEvent.click(await screen.findByTestId('chat-back'));
    await waitFor(() => expect(window.location.hash).toBe('#chat'));
  });
});
