import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TicketList } from './TicketList';
import type { AddinTicketSummary, MatchedTicket } from './api';

afterEach(cleanup);

const matched: MatchedTicket = {
  id: 't-matched',
  partnerId: 'p-1',
  orgId: 'org-1',
  status: 'open',
  emailThreadKey: 'key-1',
  internalNumber: 'T-2026-0001',
};

function ticket(id: string, overrides: Partial<AddinTicketSummary> = {}): AddinTicketSummary {
  return {
    id,
    internalNumber: `T-2026-000${id}`,
    subject: `Subject ${id}`,
    status: 'open',
    priority: null,
    updatedAt: '2026-08-15T00:00:00Z',
    submitterEmail: null,
    matchesSubmitter: false,
    ...overrides,
  };
}

describe('TicketList', () => {
  it('shows the empty state when there are no tickets at all', () => {
    render(
      <TicketList threadMatchedTicket={null} openTickets={[]} recentTickets={[]} onSelect={vi.fn()} />,
    );
    expect(screen.getByTestId('ticket-list-empty')).toBeTruthy();
  });

  it('pins threadMatchedTicket first, then open, then recent', () => {
    const open1 = ticket('2');
    const recent1 = ticket('3');
    render(
      <TicketList
        threadMatchedTicket={matched}
        openTickets={[open1]}
        recentTickets={[recent1]}
        onSelect={vi.fn()}
      />,
    );
    const list = screen.getByTestId('ticket-list');
    const rows = list.querySelectorAll('[data-testid^="ticket-row-"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.getAttribute('data-testid')).toBe('ticket-row-t-matched');
    expect(rows[0]!.textContent).toContain('Matched to this thread');
    expect(rows[1]!.getAttribute('data-testid')).toBe('ticket-row-2');
    expect(rows[2]!.getAttribute('data-testid')).toBe('ticket-row-3');
  });

  it('de-duplicates a ticket that appears in both the matched and open/recent lists', () => {
    const openSameAsMatched = ticket('t-matched', { subject: 'dup' });
    render(
      <TicketList
        threadMatchedTicket={matched}
        openTickets={[openSameAsMatched]}
        recentTickets={[]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('ticket-row-t-matched')).toHaveLength(1);
  });

  it('calls onSelect with the clicked ticket', () => {
    const onSelect = vi.fn();
    const open1 = ticket('2');
    render(
      <TicketList threadMatchedTicket={null} openTickets={[open1]} recentTickets={[]} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByTestId('ticket-row-2'));
    expect(onSelect).toHaveBeenCalledWith(open1);
  });
});
