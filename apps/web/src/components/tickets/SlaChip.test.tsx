import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SlaChip from './SlaChip';
import type { TicketSummary } from './ticketConfig';

const NOW = new Date(); // must match slaState's default which uses new Date()

const makeTicket = (overrides: Partial<TicketSummary> & { id: string }): TicketSummary => ({
  internalNumber: null,
  subject: 'Test',
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
  createdAt: '2026-06-11T09:00:00.000Z',
  updatedAt: '2026-06-11T09:00:00.000Z',
  ...overrides,
});

describe('SlaChip', () => {
  it('renders nothing (null) when no SLA is configured', () => {
    const { container } = render(
      <SlaChip ticket={makeTicket({ id: 'tk-1' })} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a resolved ticket (no SLA applies)', () => {
    const { container } = render(
      <SlaChip ticket={makeTicket({ id: 'tk-2', status: 'resolved', resolutionSlaMinutes: 60 })} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the time remaining for an ok SLA', () => {
    // 30 minutes elapsed of a 120-minute SLA (25% = well within ok)
    const ticket = makeTicket({
      id: 'tk-3',
      resolutionSlaMinutes: 120,
      createdAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    });
    render(<SlaChip ticket={ticket} />);
    expect(screen.getByTestId('ticket-sla-tk-3')).toBeInTheDocument();
  });

  it('renders an at-risk chip for a nearly-breached SLA', () => {
    // 90 minutes elapsed of a 100-minute SLA (90% > 80% threshold)
    const ticket = makeTicket({
      id: 'tk-4',
      resolutionSlaMinutes: 100,
      createdAt: new Date(NOW.getTime() - 90 * 60_000).toISOString(),
    });
    render(<SlaChip ticket={ticket} />);
    const chip = screen.getByTestId('ticket-sla-tk-4');
    expect(chip.textContent).toContain('left');
  });

  it('renders "Breached" when slaBreachedAt is set', () => {
    const ticket = makeTicket({
      id: 'tk-5',
      slaBreachedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    });
    render(<SlaChip ticket={ticket} />);
    expect(screen.getByTestId('ticket-sla-tk-5').textContent).toBe('Breached');
  });
});
