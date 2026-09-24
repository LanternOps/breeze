import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_TICKET_SLA_OPTIONS,
  TicketSlaOptionsFields,
  TicketSlaOptionsForm,
  ticketSlaConfigFromOptions,
  ticketSlaOptionsFromConfig,
} from './TicketSlaOptionsForm';

describe('TicketSlaOptionsFields (#3198 W03)', () => {
  it('states the pause-attribution approximation on the face of the form', () => {
    render(<TicketSlaOptionsFields value={DEFAULT_TICKET_SLA_OPTIONS} onChange={() => {}} />);
    // Spec §3.3 R1: paused minutes are a lifetime total, so pause time after
    // first response slightly flatters response attainment. The reader is told
    // BEFORE they create the report, not only in the PDF footer.
    expect(screen.getByTestId('ticket-sla-approximation-note')).toBeInTheDocument();
  });

  it('defaults the group-by to Automatic, which lets the generator pick by owner scope', () => {
    render(<TicketSlaOptionsFields value={DEFAULT_TICKET_SLA_OPTIONS} onChange={() => {}} />);
    expect(DEFAULT_TICKET_SLA_OPTIONS.groupBy).toBeNull();
    expect(screen.getByTestId('ticket-sla-group-by')).toHaveValue('');
  });

  it('reports a changed group-by axis, and Automatic back to null', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<TicketSlaOptionsFields value={DEFAULT_TICKET_SLA_OPTIONS} onChange={onChange} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('ticket-sla-group-by'), 'technician');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'technician' }));

    rerender(<TicketSlaOptionsFields value={{ ...DEFAULT_TICKET_SLA_OPTIONS, groupBy: 'technician' }} onChange={onChange} />);
    await user.selectOptions(screen.getByTestId('ticket-sla-group-by'), '');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: null }));
  });

  it('labels the technician axis as the CURRENT assignee', () => {
    render(<TicketSlaOptionsFields value={{ ...DEFAULT_TICKET_SLA_OPTIONS, groupBy: 'technician' }} onChange={() => {}} />);
    // `assigned_to` is the current assignee; reassignment history is not
    // tracked (spec §3.3 R1), so the axis must not read as "who answered it".
    expect(screen.getByTestId('ticket-sla-technician-note')).toBeInTheDocument();
  });

  it('toggles the no-SLA denominator', async () => {
    const onChange = vi.fn();
    render(<TicketSlaOptionsFields value={DEFAULT_TICKET_SLA_OPTIONS} onChange={onChange} />);
    await userEvent.setup().click(screen.getByTestId('ticket-sla-include-no-sla'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ includeNoSla: false }));
  });
});

describe('TicketSlaOptionsForm', () => {
  const noop = () => {};

  it('disables submit while the custom period is invalid', () => {
    const { rerender } = render(
      <TicketSlaOptionsForm
        value={{ ...DEFAULT_TICKET_SLA_OPTIONS, period: { kind: 'custom', start: '2026-08-31', end: '2026-08-01' } }}
        onChange={noop}
        submitLabel="Create"
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('ticket-sla-create-report')).toBeDisabled();
    rerender(
      <TicketSlaOptionsForm
        value={{ ...DEFAULT_TICKET_SLA_OPTIONS, period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' } }}
        onChange={noop}
        submitLabel="Create"
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('ticket-sla-create-report')).toBeEnabled();
  });
});

describe('ticketSlaConfigFromOptions', () => {
  it('OMITS groupBy for Automatic — never sends an empty string or a frozen default', () => {
    const config = ticketSlaConfigFromOptions(DEFAULT_TICKET_SLA_OPTIONS);
    expect(config).toEqual({ period: { kind: 'last_full_month' }, includeNoSla: true });
    expect('groupBy' in config).toBe(false);
  });

  it('sends an explicit axis and a custom window verbatim', () => {
    expect(ticketSlaConfigFromOptions({
      period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' },
      groupBy: 'category',
      includeNoSla: false,
    })).toEqual({
      period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' },
      groupBy: 'category',
      includeNoSla: false,
    });
  });
});

describe('ticketSlaOptionsFromConfig', () => {
  it('falls back to the defaults for an empty config', () => {
    expect(ticketSlaOptionsFromConfig({})).toEqual(DEFAULT_TICKET_SLA_OPTIONS);
  });

  it('keeps includeNoSla on unless it is explicitly false', () => {
    expect(ticketSlaOptionsFromConfig({ includeNoSla: false }).includeNoSla).toBe(false);
    expect(ticketSlaOptionsFromConfig({ includeNoSla: 'yes' as never }).includeNoSla).toBe(true);
  });

  it('reads a group-by the server schema accepts, and treats anything else as Automatic', () => {
    expect(ticketSlaOptionsFromConfig({ groupBy: 'site' }).groupBy).toBeNull();
    expect(ticketSlaOptionsFromConfig({ groupBy: '' }).groupBy).toBeNull();
    expect(ticketSlaOptionsFromConfig({ groupBy: 'category' }).groupBy).toBe('category');
  });
});
