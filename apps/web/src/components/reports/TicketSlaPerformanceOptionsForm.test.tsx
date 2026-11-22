import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TICKET_SLA_PERFORMANCE_OPTIONS,
  isTicketSlaPerformanceOptionsValid,
  ticketSlaPerformanceConfigFromOptions,
  ticketSlaPerformanceOptionsFromConfig,
  TicketSlaPerformanceOptionsForm,
} from './TicketSlaPerformanceOptionsForm';

describe('ticketSlaPerformance options mapping', () => {
  it('options form round-trips period and includeSubjects and writes no default keys', () => {
    expect(ticketSlaPerformanceConfigFromOptions(DEFAULT_TICKET_SLA_PERFORMANCE_OPTIONS)).toEqual({});

    const custom = {
      period: { kind: 'custom' as const, start: '2026-10-01', end: '2026-10-31' },
      includeSubjects: true,
    };
    const config = ticketSlaPerformanceConfigFromOptions(custom);
    expect(config).toEqual(custom);
    expect(ticketSlaPerformanceOptionsFromConfig(config)).toEqual(custom);
  });

  it('a stored config with no keys reads as the defaults, and only literal true opts in to subjects', () => {
    expect(ticketSlaPerformanceOptionsFromConfig({})).toEqual(DEFAULT_TICKET_SLA_PERFORMANCE_OPTIONS);
    expect(ticketSlaPerformanceOptionsFromConfig({ includeSubjects: 'yes' }).includeSubjects).toBe(false);
  });

  it('an unusable custom period is not submittable', () => {
    expect(isTicketSlaPerformanceOptionsValid(DEFAULT_TICKET_SLA_PERFORMANCE_OPTIONS)).toBe(true);
    expect(isTicketSlaPerformanceOptionsValid({ period: { kind: 'custom' }, includeSubjects: false })).toBe(false);
  });
});

describe('TicketSlaPerformanceOptionsForm', () => {
  it('warns who can read subjects, leaves them off, and reports the toggle', async () => {
    const onChange = vi.fn();
    render(
      <TicketSlaPerformanceOptionsForm
        value={DEFAULT_TICKET_SLA_PERFORMANCE_OPTIONS}
        onChange={onChange}
        submitLabel="Create"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const toggle = screen.getByTestId('sla-performance-include-subjects') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByTestId('sla-performance-subjects-help').textContent).toMatch(/every portal user/i);

    await userEvent.setup().click(toggle);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_TICKET_SLA_PERFORMANCE_OPTIONS, includeSubjects: true });
  });

  it('blocks submit while the period is invalid', async () => {
    const onSubmit = vi.fn();
    render(
      <TicketSlaPerformanceOptionsForm
        value={{ period: { kind: 'custom' }, includeSubjects: false }}
        onChange={vi.fn()}
        submitLabel="Create"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const submit = screen.getByTestId('sla-performance-create-report');
    expect(submit).toBeDisabled();
    await userEvent.setup().click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
