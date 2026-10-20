import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import TicketQueueList from './TicketQueueList';
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

describe('TicketQueueList org link and row activation (ui-flow W03)', () => {
  it('links the org name to the org record without selecting the row', () => {
    const onSelect = vi.fn();
    render(<TicketQueueList tickets={[makeTicket({ id: 'tk-1' })]} selectedId={null} onSelect={onSelect} loading={false} />);
    const link = screen.getByTestId('org-record-link');
    expect(link).toHaveAttribute('href', '/organizations/org-1');
    expect(link).toHaveTextContent('Acme');
    fireEvent.click(link);
    expect(onSelect).not.toHaveBeenCalled();
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

  it('does not hijack Enter pressed on the org link inside the row', () => {
    const onSelect = vi.fn();
    render(<TicketQueueList tickets={[makeTicket({ id: 'tk-1' })]} selectedId={null} onSelect={onSelect} loading={false} />);
    fireEvent.keyDown(screen.getByTestId('org-record-link'), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders no org link when hideOrg or orgName is null', () => {
    const { unmount } = render(
      <TicketQueueList tickets={[makeTicket({ id: 'tk-1' })]} selectedId={null} onSelect={vi.fn()} loading={false} hideOrg />
    );
    expect(screen.queryByTestId('org-record-link')).toBeNull();
    unmount();
    render(
      <TicketQueueList tickets={[makeTicket({ id: 'tk-2', orgName: null })]} selectedId={null} onSelect={vi.fn()} loading={false} />
    );
    expect(screen.queryByTestId('org-record-link')).toBeNull();
  });
});

describe('TicketQueueList checklist progress (#9180)', () => {
  it('shows done/total for a ticket with steps, from the row payload (no per-row fetch)', () => {
    render(
      <TicketQueueList
        tickets={[makeTicket({ id: 'tk-1', checklist: { done: 2, total: 5 } })]}
        selectedId={null}
        onSelect={vi.fn()}
        loading={false}
      />
    );
    const chip = screen.getByTestId('ticket-checklist-chip-tk-1');
    expect(chip).toHaveTextContent('2/5');
    expect(chip.getAttribute('title')).toContain('2 of 5');
  });

  it('renders no chip when the ticket has no steps, the field is absent, or total is 0', () => {
    render(
      <TicketQueueList
        tickets={[
          makeTicket({ id: 'tk-null', checklist: null }),
          makeTicket({ id: 'tk-absent' }),
          makeTicket({ id: 'tk-zero', checklist: { done: 0, total: 0 } }),
        ]}
        selectedId={null}
        onSelect={vi.fn()}
        loading={false}
      />
    );
    expect(screen.queryByTestId('ticket-checklist-chip-tk-null')).toBeNull();
    expect(screen.queryByTestId('ticket-checklist-chip-tk-absent')).toBeNull();
    expect(screen.queryByTestId('ticket-checklist-chip-tk-zero')).toBeNull();
  });
});
