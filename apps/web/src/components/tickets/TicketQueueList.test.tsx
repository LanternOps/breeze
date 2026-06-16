import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
