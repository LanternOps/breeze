import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TicketComposer from './TicketComposer';

describe('TicketComposer', () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => onSend.mockClear());

  it('defaults to public reply mode', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    expect(screen.getByTestId('ticket-composer-send')).toHaveTextContent('Send reply');
    expect(screen.queryByTestId('ticket-composer-internal-banner')).toBeNull();
    expect(screen.getByTestId('ticket-composer-input')).toHaveAttribute('placeholder', 'Reply to Pat…');
  });

  it('internal mode shows the banner, changes the send label and placeholder', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    expect(screen.getByTestId('ticket-composer-internal-banner')).toHaveTextContent('Internal');
    expect(screen.getByTestId('ticket-composer-send')).toHaveTextContent('Add internal note');
    expect(screen.getByTestId('ticket-composer-input')).toHaveAttribute('placeholder', 'Add an internal note…');
  });

  it('sends with isPublic matching the active mode', async () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'note body' } });
    fireEvent.click(screen.getByTestId('ticket-composer-send'));
    expect(onSend).toHaveBeenCalledWith('note body', false);
  });

  it('disables send on empty content', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    expect(screen.getByTestId('ticket-composer-send')).toBeDisabled();
  });

  it('Cmd+Enter sends', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    const input = screen.getByTestId('ticket-composer-input');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith('hi', true);
  });
});
