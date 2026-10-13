// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MessageCard, MessageCardWindow, type MessageCardApi, type MessageView } from './MessageCard';

const view: MessageView = {
  messageId: '11111111-1111-4111-8111-111111111111',
  title: 'Reboot tonight',
  body: 'Please **save** your work.',
  severity: 'warning',
  requiresAck: true,
  expiresAt: '2030-01-01T00:00:00Z',
  branding: { companyName: 'Acme IT', displayName: 'Acme', accent: '#336699' },
  plain: false,
};

describe('MessageCard', () => {
  it('renders the fixed sender slot, title, body and footer', () => {
    render(<MessageCard view={view} onAcknowledge={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('message-sender')).toHaveTextContent('From Acme IT');
    expect(screen.getByText('Reboot tonight')).toBeInTheDocument();
    expect(screen.getByText('save').tagName).toBe('STRONG');
    expect(screen.getByText('Sent by your IT provider')).toBeInTheDocument();
  });

  it('body text cannot replace the sender slot', () => {
    const spoof: MessageView = {
      ...view,
      title: 'From Your Bank',
      body: 'From Your Bank\n\nSent by your bank',
    };
    render(<MessageCard view={spoof} onAcknowledge={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId('message-sender')).toHaveTextContent('From Acme IT');
    expect(screen.getAllByText(/Sent by your IT provider/)).toHaveLength(1);
  });

  it('falls back to the display name, then a generic sender, when branding has no company', () => {
    const { rerender } = render(
      <MessageCard
        view={{ ...view, branding: { companyName: '', displayName: 'Acme', accent: null } }}
        onAcknowledge={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('message-sender')).toHaveTextContent('From Acme');
    rerender(
      <MessageCard
        view={{ ...view, branding: { companyName: '', displayName: '', accent: null } }}
        onAcknowledge={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('message-sender')).toHaveTextContent('From your IT provider');
  });

  it('shows Acknowledge (not Close) when an ack is required', () => {
    render(<MessageCard view={view} onAcknowledge={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('shows Close when no ack is required', () => {
    const onClose = vi.fn();
    render(<MessageCard view={{ ...view, requiresAck: false }} onAcknowledge={() => {}} onClose={onClose} />);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards against a double-click on Acknowledge', () => {
    const onAcknowledge = vi.fn();
    render(<MessageCard view={view} onAcknowledge={onAcknowledge} onClose={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Acknowledge' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('renders oversize content as plain text', () => {
    render(
      <MessageCard
        view={{ ...view, body: '**x** [a](https://a.example)', plain: true }}
        onAcknowledge={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('**x** [a](https://a.example)')).toBeInTheDocument();
  });

  it('applies only a valid accent colour', () => {
    const { container, rerender } = render(<MessageCard view={view} onAcknowledge={() => {}} onClose={() => {}} />);
    expect((container.firstChild as HTMLElement).style.getPropertyValue('--message-accent')).toBe('#336699');
    rerender(
      <MessageCard
        view={{ ...view, branding: { ...view.branding, accent: 'red;background:url(x)' } }}
        onAcknowledge={() => {}}
        onClose={() => {}}
      />,
    );
    expect((container.firstChild as HTMLElement).style.getPropertyValue('--message-accent')).toBe('');
  });
});

describe('MessageCardWindow', () => {
  const api = (): MessageCardApi => ({
    getView: vi.fn(async () => view),
    acknowledge: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  });

  it('invokes the acknowledge command exactly once for the message', async () => {
    const a = api();
    render(<MessageCardWindow messageId={view.messageId} api={a} />);
    const btn = await screen.findByRole('button', { name: 'Acknowledge' });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(a.acknowledge).toHaveBeenCalledTimes(1);
    expect(a.acknowledge).toHaveBeenCalledWith(view.messageId);
    expect(a.close).not.toHaveBeenCalled();
  });

  it('renders nothing and closes the window when the message is unavailable', async () => {
    const a = api();
    (a.getView as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('gone'));
    const { container } = render(<MessageCardWindow messageId={view.messageId} api={a} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container).toBeEmptyDOMElement();
    expect(a.close).toHaveBeenCalledWith(view.messageId);
  });

  it('shows an inline error when the ack fails and lets the user retry', async () => {
    const a = api();
    (a.acknowledge as ReturnType<typeof vi.fn>).mockRejectedValueOnce('Not connected');
    render(<MessageCardWindow messageId={view.messageId} api={a} />);
    const btn = await screen.findByRole('button', { name: 'Acknowledge' });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(a.acknowledge).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/not connected/i);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    });
    expect(a.acknowledge).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
