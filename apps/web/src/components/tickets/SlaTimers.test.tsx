import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SlaTimers } from './SlaTimers';
import type { TicketDetail } from './ticketConfig';

const NOW = new Date(); // must match the component's default `now = new Date()`

const mkTicket = (overrides: Partial<TicketDetail> = {}): TicketDetail => ({
  id: 'tk-1',
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
  // 10 minutes elapsed by default — well within any target used below.
  createdAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
  updatedAt: NOW.toISOString(),
  description: null,
  submitterName: null,
  submitterEmail: null,
  pendingReason: null,
  resolutionNote: null,
  resolvedAt: null,
  comments: [],
  alertLinks: [],
  ...overrides,
});

describe('SlaTimers', () => {
  it('renders both timers with countdowns', () => {
    render(<SlaTimers ticket={mkTicket({ responseSlaMinutes: 60, resolutionSlaMinutes: 240 })} />);
    expect(screen.getByTestId('sla-timer-response')).toHaveTextContent(/left/);
    expect(screen.getByTestId('sla-timer-resolution')).toHaveTextContent(/left/);
  });

  it('shows response as met once firstResponseAt is set', () => {
    render(
      <SlaTimers
        ticket={mkTicket({
          responseSlaMinutes: 60,
          resolutionSlaMinutes: 240,
          firstResponseAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
        })}
      />
    );
    expect(screen.getByTestId('sla-timer-response')).toHaveTextContent('Met');
    // Resolution target is untouched by the first response.
    expect(screen.getByTestId('sla-timer-resolution')).toHaveTextContent(/left/);
  });

  it('shows resolution as met from resolvedAt', () => {
    render(
      <SlaTimers
        ticket={mkTicket({
          resolutionSlaMinutes: 240,
          status: 'resolved',
          resolvedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
        })}
      />
    );
    expect(screen.getByTestId('sla-timer-resolution')).toHaveTextContent('Met');
  });

  it('shows breached targets from slaBreachReason', () => {
    render(
      <SlaTimers
        ticket={mkTicket({
          responseSlaMinutes: 60,
          resolutionSlaMinutes: 240,
          slaBreachedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
          slaBreachReason: 'response',
        })}
      />
    );
    expect(screen.getByTestId('sla-timer-response')).toHaveTextContent('Breached');
    // The resolution target is not in the breach reason — still counting.
    expect(screen.getByTestId('sla-timer-resolution')).toHaveTextContent(/left/);
  });

  it('shows a paused note while slaPausedAt is set', () => {
    render(
      <SlaTimers
        ticket={mkTicket({
          responseSlaMinutes: 60,
          status: 'pending',
          slaPausedAt: NOW.toISOString(),
          slaPausedMinutes: 0,
        })}
      />
    );
    expect(screen.getByTestId('sla-timers-paused')).toBeInTheDocument();
    expect(screen.getByTestId('sla-timer-response')).toHaveTextContent('Paused');
  });

  it('renders nothing when the ticket has no SLA targets', () => {
    render(<SlaTimers ticket={mkTicket()} />);
    expect(screen.queryByTestId('sla-timers')).toBeNull();
  });

  it('resolved ticket with unmet response SLA shows Not met, not a countdown', () => {
    render(
      <SlaTimers
        ticket={mkTicket({
          responseSlaMinutes: 60,
          firstResponseAt: null,
          status: 'resolved',
          resolvedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
          slaBreachReason: null,
        })}
      />
    );
    expect(screen.getByTestId('sla-timer-response')).toHaveTextContent('Not met');
    expect(screen.getByTestId('sla-timer-response')).not.toHaveTextContent(/left/);
  });

  it('resolved ticket with breached response SLA shows Breached', () => {
    render(
      <SlaTimers
        ticket={mkTicket({
          responseSlaMinutes: 60,
          firstResponseAt: null,
          status: 'resolved',
          resolvedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
          slaBreachReason: 'response',
        })}
      />
    );
    expect(screen.getByTestId('sla-timer-response')).toHaveTextContent('Breached');
  });
});
