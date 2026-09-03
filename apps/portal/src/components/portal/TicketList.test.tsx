// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// TicketList only needs types from @/lib/api, but resolving the module pulls
// in astro:transitions/client (via lib/navigation), which vitest can't load.
vi.mock('@/lib/api', () => ({}));

import { TicketList } from './TicketList';
import type { TicketSummary, TicketStatus } from '@/lib/api';

const ticket = (over: Partial<TicketSummary> = {}): TicketSummary => ({
  id: 't1',
  ticketNumber: 'T-1',
  subject: 'Printer offline',
  status: 'open',
  priority: 'normal',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
  sla: {
    firstResponseMinutes: null,
    resolutionMinutes: null,
    responseTargetMinutes: null,
    resolutionTargetMinutes: null,
    status: 'not_configured',
  },
  ...over,
});

describe('TicketList — every API status renders (SSR must never throw)', () => {
  // The API's ticket_status enum. A freshly submitted ticket is 'new', which an
  // earlier status map returned `undefined` for and crashed the Support page.
  const ALL: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'];

  it.each(ALL)('renders a row for status %s', (status) => {
    render(<TicketList tickets={[ticket({ status })]} />);
    expect(screen.getByText('Printer offline')).toBeTruthy();
  });

  it('labels new and open as Open for the customer, and pending as needing their reply', () => {
    render(
      <TicketList
        tickets={[
          ticket({ id: 'a', ticketNumber: 'T-A', subject: 'A', status: 'new' }),
          ticket({ id: 'b', ticketNumber: 'T-B', subject: 'B', status: 'pending' }),
        ]}
      />
    );
    expect(screen.getAllByText('Open')).toHaveLength(1);
    expect(screen.getByText('Awaiting your reply')).toBeTruthy();
  });

  it('counts every not-yet-resolved request in the ledger foot', () => {
    render(
      <TicketList
        tickets={[
          ticket({ id: 'a', ticketNumber: 'T-A', status: 'new' }),
          ticket({ id: 'b', ticketNumber: 'T-B', status: 'pending' }),
          ticket({ id: 'c', ticketNumber: 'T-C', status: 'on_hold' }),
          ticket({ id: 'd', ticketNumber: 'T-D', status: 'resolved' }),
          ticket({ id: 'e', ticketNumber: 'T-E', status: 'closed' }),
        ]}
      />
    );
    expect(screen.getByTestId('ticket-ledger-foot').textContent).toBe('3 open requests');
  });

  it('keeps a single mark per row: priority is plain text, not a second dot', () => {
    render(<TicketList tickets={[ticket({ priority: 'high' })]} />);
    expect(screen.getByText('High priority')).toBeTruthy();
  });
});

it.each([
  ['breached', 'SLA breached'],
  ['at_risk', 'SLA at risk'],
  ['paused', 'SLA paused'],
  ['on_track', 'SLA on track'],
  ['met', 'SLA met'],
  ['not_configured', 'No SLA configured'],
] as const)('renders %s SLA status', (status, copy) => {
  render(<TicketList tickets={[ticket({
    id: status,
    sla: {
      firstResponseMinutes: null,
      resolutionMinutes: null,
      responseTargetMinutes: null,
      resolutionTargetMinutes: null,
      status,
    },
  })]} />);
  expect(screen.getByTestId(`portal-ticket-sla-${status}`).textContent).toContain(copy);
});
