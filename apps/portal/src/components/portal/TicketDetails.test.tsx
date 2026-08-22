// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const addTicketComment = vi.fn();
vi.mock('@/lib/api', () => ({
  portalApi: { addTicketComment: (...args: unknown[]) => addTicketComment(...args) },
}));

import { TicketDetails } from './TicketDetails';
import type { TicketDetails as TicketDetailsType, TicketStatus } from '@/lib/api';

const ticket = (over: Partial<TicketDetailsType> = {}): TicketDetailsType => ({
  id: 't1',
  ticketNumber: 'T-1',
  subject: 'Printer offline',
  status: 'new',
  priority: 'normal',
  description: 'Drops every afternoon.',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  comments: [
    { id: 'c2', authorName: 'Tech', content: 'second', createdAt: '2026-08-02T00:00:00Z' },
    { id: 'c1', authorName: 'Tech', content: 'first', createdAt: '2026-08-01T00:00:00Z' },
  ],
  ...over,
});

beforeEach(() => addTicketComment.mockReset());

describe('TicketDetails — statuses', () => {
  const ALL: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'];
  it.each(ALL)('renders status %s without throwing and with activity copy', (status) => {
    render(<TicketDetails ticket={ticket({ status })} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Printer offline');
    expect(screen.getByTestId('ticket-activity-status').textContent).not.toBe('');
  });

  it('hides the composer on a closed ticket and offers a new one instead', () => {
    render(<TicketDetails ticket={ticket({ status: 'closed' })} />);
    expect(screen.queryByTestId('ticket-reply-form')).toBeNull();
    expect(screen.getByTestId('ticket-closed-note')).toBeTruthy();
  });
});

describe('TicketDetails — reply composer', () => {
  it('renders replies oldest-first even though the API returns newest-first', () => {
    render(<TicketDetails ticket={ticket()} />);
    const items = screen.getAllByTestId('ticket-comment').map((li) => li.textContent ?? '');
    expect(items[0]).toContain('first');
    expect(items[1]).toContain('second');
  });

  it('does not submit whitespace-only content', () => {
    render(<TicketDetails ticket={ticket()} />);
    fireEvent.change(screen.getByTestId('ticket-reply-input'), { target: { value: '   ' } });
    expect((screen.getByTestId('ticket-reply-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(addTicketComment).not.toHaveBeenCalled();
  });

  it('posts the trimmed reply, appends it to the thread and clears the box', async () => {
    addTicketComment.mockResolvedValue({
      data: { id: 'c3', authorName: 'Nadia', content: 'hi', createdAt: '2026-08-03T00:00:00Z' },
    });
    render(<TicketDetails ticket={ticket()} />);
    const input = screen.getByTestId('ticket-reply-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '  hi  ' } });
    fireEvent.click(screen.getByTestId('ticket-reply-submit'));
    await waitFor(() => expect(addTicketComment).toHaveBeenCalledWith('t1', 'hi'));
    await waitFor(() => expect(screen.getAllByTestId('ticket-comment')).toHaveLength(3));
    expect(input.value).toBe('');
  });

  it('shows the API error and keeps the draft when the post fails', async () => {
    addTicketComment.mockResolvedValue({ error: 'Tickets are disabled for this organization' });
    render(<TicketDetails ticket={ticket()} />);
    const input = screen.getByTestId('ticket-reply-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByTestId('ticket-reply-submit'));
    expect((await screen.findByRole('alert')).textContent).toContain('Tickets are disabled');
    expect(input.value).toBe('hi');
    expect(screen.getAllByTestId('ticket-comment')).toHaveLength(2);
  });
});
