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

  it('renders a row when an older API response has no SLA payload', () => {
    render(<TicketList tickets={[ticket({ sla: undefined })]} />);
    expect(screen.getByText('Printer offline')).toBeTruthy();
    expect(screen.queryByTestId('portal-ticket-sla-t1')).toBeNull();
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
  render(<TicketList enableSupportUsage tickets={[ticket({
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

it('hides SLA status unless support usage is enabled', () => {
  render(<TicketList tickets={[ticket()]} />);
  expect(screen.queryByTestId('portal-ticket-sla-t1')).toBeNull();
});

describe('TicketList — the SLA line keeps the one-mark-per-row diet', () => {
  const withSla = (status: TicketSummary['sla']['status']) =>
    ticket({
      sla: {
        firstResponseMinutes: null,
        resolutionMinutes: null,
        responseTargetMinutes: null,
        resolutionTargetMinutes: null,
        status,
      },
    });

  it('renders the SLA state as quiet text, never a second dot', () => {
    render(<TicketList enableSupportUsage tickets={[withSla('at_risk')]} />);

    const sla = screen.getByTestId('portal-ticket-sla-t1');
    // StatusMark's dot is an aria-hidden span; the SLA line must not grow one.
    expect(sla.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(sla.className).toContain('text-xs');
    expect(sla.className).toContain('text-muted-foreground');
  });

  it('reserves the destructive foreground for a breached target', () => {
    render(<TicketList enableSupportUsage tickets={[withSla('breached')]} />);

    expect(screen.getByTestId('portal-ticket-sla-t1').className).toContain(
      'text-destructive-on-tint',
    );
  });

  it('keeps the SLA line inside the status cell as a secondary line', () => {
    render(<TicketList enableSupportUsage tickets={[withSla('on_track')]} />);

    const sla = screen.getByTestId('portal-ticket-sla-t1');
    const cell = sla.closest('td');
    expect(cell).not.toBeNull();
    expect(cell?.textContent).toContain('Open');
    expect(sla.className).toContain('block');
  });
});
