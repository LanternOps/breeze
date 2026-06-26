import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('hides the canned-response picker when there are no templates', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    expect(screen.queryByTestId('canned-picker-button')).toBeNull();
  });

  it('inserts a canned response (with variables substituted) into the draft', () => {
    render(
      <TicketComposer
        requesterName="Pat"
        onSend={onSend}
        templates={[{ id: '1', name: 'Greeting', body: 'Hi {{requester_name}}', category: null, sortOrder: 0, isActive: true }]}
        templateVars={{ requester_name: 'Pat' }}
      />,
    );
    fireEvent.click(screen.getByTestId('canned-picker-button'));
    fireEvent.click(screen.getByTestId('canned-picker-option-1'));
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('Hi Pat');
  });

  it('splices a canned response at the caret (not just append)', () => {
    render(
      <TicketComposer
        requesterName="Pat"
        onSend={onSend}
        templates={[{ id: '1', name: 'Sig', body: '[sig]', category: null, sortOrder: 0, isActive: true }]}
        templateVars={{}}
      />,
    );
    const input = screen.getByTestId('ticket-composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Hello  world' } });
    // Place the caret between the two spaces (index 6).
    input.setSelectionRange(6, 6);
    fireEvent.click(screen.getByTestId('canned-picker-button'));
    fireEvent.click(screen.getByTestId('canned-picker-option-1'));
    expect(input.value).toBe('Hello [sig] world');
  });

  it('replaces the current selection when inserting a canned response', () => {
    render(
      <TicketComposer
        requesterName="Pat"
        onSend={onSend}
        templates={[{ id: '1', name: 'Sig', body: 'X', category: null, sortOrder: 0, isActive: true }]}
        templateVars={{}}
      />,
    );
    const input = screen.getByTestId('ticket-composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'aBBBc' } });
    input.setSelectionRange(1, 4); // select "BBB"
    fireEvent.click(screen.getByTestId('canned-picker-button'));
    fireEvent.click(screen.getByTestId('canned-picker-option-1'));
    expect(input.value).toBe('aXc');
  });

  it('keeps the draft and re-enables send when onSend rejects', async () => {
    onSend.mockRejectedValueOnce(new Error('network down'));
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);

    const input = screen.getByTestId('ticket-composer-input');
    fireEvent.change(input, { target: { value: 'important draft' } });
    fireEvent.click(screen.getByTestId('ticket-composer-send'));

    await waitFor(() => {
      expect(screen.getByTestId('ticket-composer-send')).toHaveTextContent('Send reply');
    });
    expect(input).toHaveValue('important draft');
    expect(screen.getByTestId('ticket-composer-send')).not.toBeDisabled();
    expect(input).not.toBeDisabled();
  });
});
