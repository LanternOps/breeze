import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import TicketQueueList, { queueOptionId } from './TicketQueueList';
import type { TicketSummary } from './ticketConfig';

const makeTicket = (overrides: Partial<TicketSummary> & { id: string }): TicketSummary => ({
  internalNumber: 'T-1',
  subject: 'A ticket',
  status: 'open',
  priority: 'normal',
  source: 'portal',
  orgId: 'org-1',
  orgName: 'Acme',
  deviceId: null,
  deviceHostname: null,
  assignedTo: null,
  assigneeName: null,
  categoryId: null,
  dueDate: null,
  slaBreachedAt: null,
  firstResponseAt: null,
  createdAt: new Date('2026-06-01T10:00:00Z').toISOString(),
  updatedAt: new Date('2026-06-01T10:00:00Z').toISOString(),
  ...overrides
});

describe('TicketQueueList loading skeleton', () => {
  it('shows the skeleton only on a cold load (loading with no rows yet)', () => {
    render(<TicketQueueList tickets={[]} selectedId={null} onSelect={vi.fn()} loading />);
    expect(screen.getByTestId('tickets-queue-loading')).toBeInTheDocument();
  });

  it('keeps showing existing rows during a background reconcile (loading but rows present)', () => {
    render(
      <TicketQueueList
        tickets={[makeTicket({ id: 'tk-1', subject: 'Stays visible' })]}
        selectedId={null}
        onSelect={vi.fn()}
        loading
      />
    );
    // A background refresh must not blank the list with the skeleton.
    expect(screen.queryByTestId('tickets-queue-loading')).toBeNull();
    expect(screen.getByTestId('ticket-row-tk-1')).toBeInTheDocument();
  });
});

describe('TicketQueueList type chip (#7900)', () => {
  it('shows the ticket type on each row', () => {
    render(
      <TicketQueueList
        tickets={[
          makeTicket({ id: 'tk-p', ticketType: 'problem' }),
          makeTicket({ id: 'tk-c', ticketType: 'change' }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
        loading={false}
      />
    );
    expect(screen.getByTestId('ticket-type-chip-tk-p')).toHaveTextContent('Problem');
    expect(screen.getByTestId('ticket-type-chip-tk-p')).toHaveAttribute('data-ticket-type', 'problem');
    expect(screen.getByTestId('ticket-type-chip-tk-c')).toHaveTextContent('Change');
  });

  it('reads a row without ticketType (older payload) as Incident', () => {
    render(
      <TicketQueueList tickets={[makeTicket({ id: 'tk-old' })]} selectedId={null} onSelect={vi.fn()} loading={false} />
    );
    expect(screen.getByTestId('ticket-type-chip-tk-old')).toHaveAttribute('data-ticket-type', 'incident');
  });
});

describe('TicketQueueList org label and row activation (#9564)', () => {
  it('shows the org as a plain label, not a link that steals the row click', () => {
    const onSelect = vi.fn();
    const ticket = makeTicket({ id: 'tk-1' });
    render(<TicketQueueList tickets={[ticket]} selectedId={null} onSelect={onSelect} loading={false} />);
    const row = screen.getByTestId('ticket-row-tk-1');
    const org = screen.getByTestId('ticket-org-tk-1');
    expect(org).toHaveTextContent('Acme');
    // No anchor anywhere in the row: a click in the middle (where the org name
    // sits) must open the ticket, never navigate to /organizations/<id>.
    expect(row.querySelector('a')).toBeNull();
    expect(screen.queryByTestId('org-record-link')).toBeNull();
    fireEvent.click(org);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ticket);
  });

  it('selects on row click, Enter and Space', () => {
    const onSelect = vi.fn();
    const ticket = makeTicket({ id: 'tk-1' });
    render(<TicketQueueList tickets={[ticket]} selectedId={null} onSelect={onSelect} loading={false} />);
    const row = screen.getByTestId('ticket-row-tk-1');
    expect(row).toHaveAttribute('role', 'option');
    fireEvent.click(row);
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenCalledWith(ticket);
  });

  it('renders no org label when hideOrg or orgName is null', () => {
    const { unmount } = render(
      <TicketQueueList tickets={[makeTicket({ id: 'tk-1' })]} selectedId={null} onSelect={vi.fn()} loading={false} hideOrg />
    );
    expect(screen.queryByTestId('ticket-org-tk-1')).toBeNull();
    unmount();
    render(
      <TicketQueueList tickets={[makeTicket({ id: 'tk-2', orgName: null })]} selectedId={null} onSelect={vi.fn()} loading={false} />
    );
    expect(screen.queryByTestId('ticket-org-tk-2')).toBeNull();
  });
});

describe('TicketQueueList listbox semantics', () => {
  const three = [
    makeTicket({ id: 'tk-1', internalNumber: 'T-1' }),
    makeTicket({ id: 'tk-2', internalNumber: 'T-2' }),
    makeTicket({ id: 'tk-3', internalNumber: 'T-3' }),
  ];

  it('is one tab stop: only the selected row is tabbable and the list items are presentational', () => {
    render(<TicketQueueList tickets={three} selectedId="tk-2" onSelect={vi.fn()} loading={false} onToggleSelect={vi.fn()} bulkSelectedIds={new Set()} />);
    const listbox = screen.getByRole('listbox', { name: 'Ticket queue' });
    expect(screen.getAllByRole('option')).toHaveLength(3);
    for (const li of listbox.querySelectorAll('li')) expect(li).toHaveAttribute('role', 'presentation');
    expect(screen.getByTestId('ticket-row-tk-1')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('ticket-row-tk-2')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('ticket-row-tk-3')).toHaveAttribute('tabindex', '-1');
    const tabbable = listbox.querySelectorAll('[tabindex="0"], input:not([tabindex="-1"])');
    expect(tabbable).toHaveLength(1);
  });

  it('makes the first row the tab stop when nothing in the list is selected', () => {
    render(<TicketQueueList tickets={three} selectedId="tk-elsewhere" onSelect={vi.fn()} loading={false} />);
    expect(screen.getByTestId('ticket-row-tk-1')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('ticket-row-tk-2')).toHaveAttribute('tabindex', '-1');
  });

  it('keeps row checkboxes out of the tab order and reports bulk state on the option', () => {
    const onToggleSelect = vi.fn();
    render(<TicketQueueList tickets={three} selectedId="tk-1" onSelect={vi.fn()} loading={false} onToggleSelect={onToggleSelect} bulkSelectedIds={new Set(['tk-3'])} />);
    const box = screen.getByTestId('ticket-select-tk-1');
    expect(box).toHaveAttribute('tabindex', '-1');
    // The option carries the state for assistive tech (x toggles it); the
    // pointer-only checkbox is hidden so the listbox owns only options.
    expect(box).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('ticket-row-tk-1')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('ticket-row-tk-3')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box);
    expect(onToggleSelect).toHaveBeenCalledWith('tk-1');
  });

  it('omits aria-checked when the host offers no bulk selection', () => {
    render(<TicketQueueList tickets={three} selectedId="tk-1" onSelect={vi.fn()} loading={false} />);
    expect(screen.getByTestId('ticket-row-tk-1')).not.toHaveAttribute('aria-checked');
  });

  it('shows a row checkbox whenever its row has keyboard focus, not only on hover', () => {
    render(<TicketQueueList tickets={three} selectedId="tk-1" onSelect={vi.fn()} loading={false} onToggleSelect={vi.fn()} bulkSelectedIds={new Set()} />);
    expect(screen.getByTestId('ticket-select-tk-1').className).toContain('group-has-[:focus-visible]:opacity-100');
  });

  it('gives each row a stable id so the page can move focus to it', () => {
    render(<TicketQueueList tickets={three} selectedId="tk-1" onSelect={vi.fn()} loading={false} />);
    expect(screen.getByTestId('ticket-row-tk-2')).toHaveAttribute('id', queueOptionId('tk-2'));
  });

  // A host without the page's j/k hook (the organization record's Tickets
  // tab): with one tab stop, rows 2..N are reachable only through the arrows.
  it('moves focus between rows with ArrowDown/ArrowUp/Home/End when the host has no queue keys', () => {
    const onSelect = vi.fn();
    render(<TicketQueueList tickets={three} selectedId={null} onSelect={onSelect} loading={false} />);
    const [r1, r2, r3] = ['tk-1', 'tk-2', 'tk-3'].map((id) => screen.getByTestId(`ticket-row-${id}`));
    r1.focus();
    fireEvent.keyDown(r1, { key: 'ArrowDown' });
    expect(r2).toHaveFocus();
    // The tab stop follows focus, so Tab out and back returns to this row.
    expect(r2).toHaveAttribute('tabindex', '0');
    expect(r1).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(r2, { key: 'End' });
    expect(r3).toHaveFocus();
    fireEvent.keyDown(r3, { key: 'ArrowDown' });
    expect(r3).toHaveFocus();
    fireEvent.keyDown(r3, { key: 'Home' });
    expect(r1).toHaveFocus();
    fireEvent.keyDown(r1, { key: 'ArrowUp' });
    expect(r1).toHaveFocus();
    // Moving focus never activates (here, activation navigates away).
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('leaves the arrows to a host that owns queue navigation (TicketsPage j/k)', () => {
    render(<TicketQueueList tickets={three} selectedId="tk-1" onSelect={vi.fn()} loading={false} hostHandlesArrowKeys />);
    const r1 = screen.getByTestId('ticket-row-tk-1');
    r1.focus();
    expect(fireEvent.keyDown(r1, { key: 'ArrowDown' })).toBe(true);
    expect(r1).toHaveFocus();
  });
});

describe('TicketQueueList merged chip (#8972)', () => {
  it('marks a merged tombstone row "Merged" and leaves live rows alone', () => {
    render(
      <TicketQueueList
        tickets={[
          makeTicket({ id: 'tk-m', status: 'closed', mergedIntoTicketId: 'tk-surv', mergedAt: '2026-10-20T12:00:00.000Z' }),
          makeTicket({ id: 'tk-l', mergedIntoTicketId: null }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
        loading={false}
      />
    );
    expect(screen.getByTestId('ticket-row-merged-tk-m')).toHaveTextContent('Merged');
    expect(screen.queryByTestId('ticket-row-merged-tk-l')).toBeNull();
  });
});
