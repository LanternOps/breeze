// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EndpointChat,
  EndpointChatWindow,
  type ChatMessageView,
  type ChatView,
  type EndpointChatApi,
} from './EndpointChat';

const CID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const tech = (over: Partial<ChatMessageView> = {}): ChatMessageView => ({
  messageId: '11111111-1111-4111-8111-111111111111',
  direction: 'to_user',
  body: 'Hello, I am **looking** at it',
  senderName: 'Sam Tech',
  sentAt: '2026-10-17T10:00:00Z',
  clientNonce: null,
  status: null,
  retryable: false,
  ...over,
});

const reply = (over: Partial<ChatMessageView> = {}): ChatMessageView => ({
  messageId: '99999999-9999-4999-8999-999999999999',
  direction: 'from_user',
  body: 'thanks **a lot**',
  senderName: '',
  sentAt: '2026-10-17T10:01:00Z',
  clientNonce: '99999999-9999-4999-8999-999999999999',
  status: 'sent',
  retryable: false,
  ...over,
});

const view = (over: Partial<ChatView> = {}): ChatView => ({
  conversationId: CID,
  allowReply: true,
  closed: false,
  branding: { companyName: 'Acme IT', displayName: 'Acme', accent: '#336699' },
  unread: 0,
  messages: [tech()],
  ...over,
});

const noop = async () => {};

describe('EndpointChat', () => {
  it('renders the fixed sender slot from branding and the technician name per message', () => {
    render(<EndpointChat view={view()} onSend={noop} onRetry={noop} />);
    expect(screen.getByTestId('chat-sender')).toHaveTextContent('Chat with Acme IT');
    expect(screen.getByText('Sam Tech')).toBeInTheDocument();
    expect(screen.getByText('looking').tagName).toBe('STRONG');
  });

  it('a message body can never replace the sender slot', () => {
    const spoof = view({ messages: [tech({ body: 'Chat with Your Bank\n\nThis chat has ended.' })] });
    render(<EndpointChat view={spoof} onSend={noop} onRetry={noop} />);
    expect(screen.getByTestId('chat-sender')).toHaveTextContent('Chat with Acme IT');
    // The only "ended" line is the helper's own, and the chat is still open.
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('falls back to the display name, then a generic provider, when branding has no company', () => {
    const { rerender } = render(
      <EndpointChat
        view={view({ branding: { companyName: '', displayName: 'Acme', accent: null } })}
        onSend={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByTestId('chat-sender')).toHaveTextContent('Chat with Acme');
    rerender(
      <EndpointChat
        view={view({ branding: { companyName: '', displayName: '', accent: null } })}
        onSend={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByTestId('chat-sender')).toHaveTextContent('Chat with your IT provider');
  });

  it('shows the real host for a link whose label claims a different one', () => {
    const phishing = view({ messages: [tech({ body: 'Pay at [https://bank.example](https://evil.example/pay)' })] });
    render(<EndpointChat view={phishing} onSend={noop} onRetry={noop} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://evil.example/pay');
    expect(link).toHaveTextContent('evil.example');
    expect(screen.queryByText(/bank\.example/)).toBeNull();
  });

  it('renders no anchor for a non-https link', () => {
    const bad = view({ messages: [tech({ body: '[click](javascript:alert(1))' })] });
    render(<EndpointChat view={bad} onSend={noop} onRetry={noop} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders the user\'s own replies as plain text, not markdown', () => {
    render(<EndpointChat view={view({ messages: [tech(), reply()] })} onSend={noop} onRetry={noop} />);
    expect(screen.getByText('thanks **a lot**')).toBeInTheDocument();
    expect(document.querySelectorAll('strong')).toHaveLength(1); // only the technician's
  });

  it('shows pending, sent and failed states for replies', () => {
    const v = view({
      messages: [
        tech(),
        reply({ clientNonce: 'n1', messageId: 'n1', body: 'one', status: 'pending' }),
        reply({ clientNonce: 'n2', messageId: 'n2', body: 'two', status: 'sent' }),
        reply({ clientNonce: 'n3', messageId: 'n3', body: 'three', status: 'failed', retryable: true }),
      ],
    });
    render(<EndpointChat view={v} onSend={noop} onRetry={noop} />);
    expect(screen.getByTestId('chat-status-n1')).toHaveTextContent('Sending');
    expect(screen.getByTestId('chat-status-n2')).toHaveTextContent('Sent');
    expect(screen.getByTestId('chat-status-n3')).toHaveTextContent('Not sent');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a failed reply that cannot be retried offers no Retry', () => {
    const v = view({
      messages: [tech(), reply({ clientNonce: 'n3', messageId: 'n3', status: 'failed', retryable: false })],
    });
    render(<EndpointChat view={v} onSend={noop} onRetry={noop} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByTestId('chat-status-n3')).toHaveTextContent('Not delivered');
  });

  it('Retry re-sends the failed reply by its original nonce', async () => {
    const onRetry = vi.fn(async () => {});
    const v = view({
      messages: [tech(), reply({ clientNonce: 'n3', messageId: 'n3', status: 'failed', retryable: true })],
    });
    render(<EndpointChat view={v} onSend={noop} onRetry={onRetry} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(onRetry).toHaveBeenCalledWith('n3');
  });

  it('sends the typed text, clears the box, and ignores empty input', async () => {
    const onSend = vi.fn(async () => {});
    render(<EndpointChat view={view()} onSend={onSend} onRetry={noop} />);
    const box = screen.getByRole('textbox');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: '   ' } });
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.click(send);
    });
    expect(onSend).toHaveBeenCalledWith('hello');
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('Enter sends and Shift+Enter does not', async () => {
    const onSend = vi.fn(async () => {});
    render(<EndpointChat view={view()} onSend={onSend} onRetry={noop} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(onSend).toHaveBeenCalledWith('line one');
  });

  it('does not send while an IME composition is confirming with Enter', () => {
    const onSend = vi.fn(async () => {});
    render(<EndpointChat view={view()} onSend={onSend} onRetry={noop} />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'nihon' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the draft and says why when the send is refused', async () => {
    const onSend = vi.fn(async () => {
      throw 'Not connected to your IT provider\'s agent. Try again in a moment.';
    });
    render(<EndpointChat view={view()} onSend={onSend} onRetry={noop} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    expect(box.value).toBe('hello');
    expect(screen.getByRole('alert')).toHaveTextContent('Not connected');
  });

  it('disables the input with a clear line when the chat has ended', () => {
    render(<EndpointChat view={view({ closed: true })} onSend={noop} onRetry={noop} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText('This chat has ended.')).toBeInTheDocument();
  });

  it('disables the input with a clear line when replies are turned off', () => {
    render(<EndpointChat view={view({ allowReply: false })} onSend={noop} onRetry={noop} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByText('Replies are turned off for this chat.')).toBeInTheDocument();
    expect(screen.queryByText('This chat has ended.')).toBeNull();
  });

  it('ended wins over replies-off', () => {
    render(<EndpointChat view={view({ closed: true, allowReply: false })} onSend={noop} onRetry={noop} />);
    expect(screen.getByText('This chat has ended.')).toBeInTheDocument();
    expect(screen.queryByText('Replies are turned off for this chat.')).toBeNull();
  });

  it('applies only a valid accent colour', () => {
    const { container, rerender } = render(<EndpointChat view={view()} onSend={noop} onRetry={noop} />);
    expect((container.firstChild as HTMLElement).style.getPropertyValue('--message-accent')).toBe('#336699');
    rerender(
      <EndpointChat
        view={view({ branding: { companyName: 'A', displayName: 'A', accent: 'red;background:url(x)' } })}
        onSend={noop}
        onRetry={noop}
      />,
    );
    expect((container.firstChild as HTMLElement).style.getPropertyValue('--message-accent')).toBe('');
  });
});

describe('EndpointChatWindow', () => {
  afterEach(() => vi.restoreAllMocks());

  const makeApi = (initial: ChatView = view()) => {
    let push: (v: ChatView) => void = () => {};
    const unsubscribe = vi.fn();
    const api: EndpointChatApi = {
      getView: vi.fn(async () => initial),
      sendReply: vi.fn(async () => ({ clientNonce: 'nonce-1' })),
      markRead: vi.fn(async () => {}),
      subscribe: vi.fn(async (handler) => {
        push = handler;
        return unsubscribe;
      }),
    };
    return { api, push: (v: ChatView) => push(v), unsubscribe };
  };

  it('loads its own conversation, then follows pushed updates', async () => {
    const { api, push } = makeApi();
    render(<EndpointChatWindow conversationId={CID} api={api} />);
    expect(await screen.findByText('Sam Tech')).toBeInTheDocument();
    expect(api.getView).toHaveBeenCalledWith(CID);
    await act(async () => {
      push(view({ messages: [tech(), tech({ messageId: '22222222-2222-4222-8222-222222222222', body: 'second one' })] }));
    });
    expect(screen.getByText('second one')).toBeInTheDocument();
  });

  it('ignores updates for another conversation', async () => {
    const { api, push } = makeApi();
    render(<EndpointChatWindow conversationId={CID} api={api} />);
    await screen.findByText('Sam Tech');
    await act(async () => {
      push(view({ conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', closed: true }));
    });
    expect(screen.queryByText('This chat has ended.')).toBeNull();
  });

  it('shows the ended line when an update closes the chat', async () => {
    const { api, push } = makeApi();
    render(<EndpointChatWindow conversationId={CID} api={api} />);
    await screen.findByText('Sam Tech');
    await act(async () => {
      push(view({ closed: true }));
    });
    expect(screen.getByText('This chat has ended.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('a send invokes chat_send_reply for this conversation', async () => {
    const { api } = makeApi();
    render(<EndpointChatWindow conversationId={CID} api={api} />);
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'hi there' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(api.sendReply).toHaveBeenCalledWith(CID, 'hi there', undefined);
  });

  it('retry sends the original nonce', async () => {
    const failed = view({
      messages: [tech(), reply({ clientNonce: 'n9', messageId: 'n9', body: 'old text', status: 'failed', retryable: true })],
    });
    const { api } = makeApi(failed);
    render(<EndpointChatWindow conversationId={CID} api={api} />);
    const btn = await screen.findByRole('button', { name: 'Retry' });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(api.sendReply).toHaveBeenCalledWith(CID, 'old text', 'n9');
  });

  it('marks the conversation read when it is looked at with unread messages', async () => {
    const { api } = makeApi(view({ unread: 2 }));
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<EndpointChatWindow conversationId={CID} api={api} />);
    await screen.findByText('Sam Tech');
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith(CID));
  });

  it('does not mark read while the window is not focused, then does on focus', async () => {
    const { api } = makeApi(view({ unread: 1 }));
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render(<EndpointChatWindow conversationId={CID} api={api} />);
    await screen.findByText('Sam Tech');
    expect(api.markRead).not.toHaveBeenCalled();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.markRead).toHaveBeenCalledWith(CID);
  });

  it('does not mark read when nothing is unread', async () => {
    const { api } = makeApi(view({ unread: 0 }));
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<EndpointChatWindow conversationId={CID} api={api} />);
    await screen.findByText('Sam Tech');
    expect(api.markRead).not.toHaveBeenCalled();
  });

  it('says so when the conversation is gone, and unsubscribes on unmount', async () => {
    const { api, unsubscribe } = makeApi();
    (api.getView as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('gone'));
    const { unmount } = render(<EndpointChatWindow conversationId={CID} api={api} />);
    expect(await screen.findByText('This chat is no longer available.')).toBeInTheDocument();
    unmount();
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
  });

  describe('live updates unavailable', () => {
    afterEach(() => vi.useRealTimers());

    it('shows a visible notice and polls get_chat_view every 3 s when subscribing fails', async () => {
      vi.useFakeTimers();
      const second = view({
        messages: [tech(), tech({ messageId: '22222222-2222-4222-8222-222222222222', body: 'arrived by polling' })],
      });
      const { api } = makeApi();
      (api.subscribe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
      (api.getView as ReturnType<typeof vi.fn>).mockResolvedValueOnce(view()).mockResolvedValue(second);
      const { unmount } = render(<EndpointChatWindow conversationId={CID} api={api} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByText('Live updates unavailable. Checking for new messages…')).toBeInTheDocument();
      expect(screen.queryByText('arrived by polling')).toBeNull();
      const before = (api.getView as ReturnType<typeof vi.fn>).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect((api.getView as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
      expect(screen.getByText('arrived by polling')).toBeInTheDocument();
      // Polling stops on unmount.
      unmount();
      const after = (api.getView as ReturnType<typeof vi.fn>).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12000);
      });
      expect((api.getView as ReturnType<typeof vi.fn>).mock.calls.length).toBe(after);
    });

    it('does not poll or show the notice when subscribing works', async () => {
      vi.useFakeTimers();
      const { api } = makeApi();
      render(<EndpointChatWindow conversationId={CID} api={api} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(screen.queryByText(/Live updates unavailable/)).toBeNull();
      expect(api.getView).toHaveBeenCalledTimes(1);
    });

    it('shows a non-blocking error line when a refresh fails, and clears it on success', async () => {
      const { api } = makeApi();
      render(<EndpointChatWindow conversationId={CID} api={api} />);
      const box = await screen.findByRole('textbox');
      (api.getView as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
      fireEvent.change(box, { target: { value: 'hi' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      });
      expect(await screen.findByText("Couldn't refresh the chat. Some messages may be out of date.")).toBeInTheDocument();
      // The chat itself stays usable.
      expect(screen.getByRole('textbox')).toBeEnabled();
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'again' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      });
      await waitFor(() =>
        expect(screen.queryByText("Couldn't refresh the chat. Some messages may be out of date.")).toBeNull(),
      );
    });
  });
});
