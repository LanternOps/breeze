import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_TECHNICIAN_TIME_OPTIONS,
  TechnicianTimeOptionsFields,
  TechnicianTimeOptionsForm,
  technicianTimeConfigFromOptions,
  technicianTimeOptionsFromConfig,
} from './TechnicianTimeOptionsForm';

describe('TechnicianTimeOptionsFields (#3198 W03)', () => {
  it('defaults to 40 hours and says the capacity figure is an assumption', () => {
    render(<TechnicianTimeOptionsFields value={DEFAULT_TECHNICIAN_TIME_OPTIONS} onChange={() => {}} />);
    const input = screen.getByTestId('technician-time-capacity-hours');
    expect(input).toHaveValue(40);
    // Decimals are legal on the server (z.number().min(1).max(80), no .int()).
    expect(input).toHaveAttribute('step', '0.5');
    // Spec §3.3 R2 / Open Decision 3 = A: uniform capacity, no per-tech table.
    expect(screen.getByTestId('technician-time-capacity-help')).toHaveTextContent(/uniform capacity/i);
    expect(screen.getByTestId('technician-time-capacity-help')).toHaveTextContent(/part-time/i);
  });

  it('clamps the capacity input to the server bounds', async () => {
    const onChange = vi.fn();
    render(<TechnicianTimeOptionsFields value={DEFAULT_TECHNICIAN_TIME_OPTIONS} onChange={onChange} />);
    const input = screen.getByTestId('technician-time-capacity-hours');
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, '999');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weeklyCapacityHours: 80 }));
  });

  it('keeps a fractional capacity rather than rounding it', async () => {
    const onChange = vi.fn();
    render(<TechnicianTimeOptionsFields value={DEFAULT_TECHNICIAN_TIME_OPTIONS} onChange={onChange} />);
    const input = screen.getByTestId('technician-time-capacity-hours');
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, '37.5');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weeklyCapacityHours: 37.5 }));
  });

  it('offers the work-type axis and reports it', async () => {
    const onChange = vi.fn();
    render(<TechnicianTimeOptionsFields value={DEFAULT_TECHNICIAN_TIME_OPTIONS} onChange={onChange} />);
    await userEvent.setup().selectOptions(screen.getByTestId('technician-time-group-by'), 'work_type');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'work_type' }));
  });

  it('warns that the organization axis drops org-less time entries', () => {
    render(<TechnicianTimeOptionsFields value={{ ...DEFAULT_TECHNICIAN_TIME_OPTIONS, groupBy: 'organization' }} onChange={() => {}} />);
    expect(screen.getByTestId('technician-time-org-axis-note')).toBeInTheDocument();
  });
});

describe('TechnicianTimeOptionsForm', () => {
  it('disables submit while the custom period is incomplete', () => {
    render(
      <TechnicianTimeOptionsForm
        value={{ ...DEFAULT_TECHNICIAN_TIME_OPTIONS, period: { kind: 'custom', start: '2026-08-01' } }}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('technician-time-create-report')).toBeDisabled();
    expect(screen.getByTestId('report-period-error')).toBeInTheDocument();
  });
});

describe('technicianTimeConfigFromOptions', () => {
  it('emits exactly the three keys the server schema accepts', () => {
    expect(technicianTimeConfigFromOptions({ ...DEFAULT_TECHNICIAN_TIME_OPTIONS, weeklyCapacityHours: 37.5 })).toEqual({
      period: { kind: 'last_full_month' },
      groupBy: 'technician',
      weeklyCapacityHours: 37.5,
    });
  });
});

describe('technicianTimeOptionsFromConfig', () => {
  it('falls back to the schema defaults for an empty config', () => {
    expect(technicianTimeOptionsFromConfig({})).toEqual(DEFAULT_TECHNICIAN_TIME_OPTIONS);
  });

  it('clamps an out-of-range capacity to the server schema bounds, without rounding', () => {
    expect(technicianTimeOptionsFromConfig({ weeklyCapacityHours: 9999 }).weeklyCapacityHours).toBe(80);
    expect(technicianTimeOptionsFromConfig({ weeklyCapacityHours: 0 }).weeklyCapacityHours).toBe(1);
    expect(technicianTimeOptionsFromConfig({ weeklyCapacityHours: 37.5 }).weeklyCapacityHours).toBe(37.5);
    expect(technicianTimeOptionsFromConfig({ weeklyCapacityHours: 'lots' }).weeklyCapacityHours).toBe(40);
  });

  it('rejects a group-by the server schema does not accept', () => {
    expect(technicianTimeOptionsFromConfig({ groupBy: 'priority' }).groupBy).toBe('technician');
    expect(technicianTimeOptionsFromConfig({ groupBy: 'work_type' }).groupBy).toBe('work_type');
  });
});
