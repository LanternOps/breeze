import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_REPORT_PERIOD,
  ReportPeriodField,
  isReportPeriodValid,
  reportPeriodFromConfig,
} from './ReportPeriodField';

describe('ReportPeriodField (#3198 W03)', () => {
  it('defaults to the last full month — the period an MSP actually reports on', () => {
    expect(DEFAULT_REPORT_PERIOD).toEqual({ kind: 'last_full_month' });
  });

  it('hides the custom date inputs until the custom kind is chosen', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ReportPeriodField value={DEFAULT_REPORT_PERIOD} onChange={onChange} />);
    expect(screen.queryByTestId('report-period-start')).toBeNull();

    await userEvent.setup().selectOptions(screen.getByTestId('report-period-kind'), 'custom');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'custom' });

    rerender(<ReportPeriodField value={{ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }} onChange={onChange} />);
    expect(screen.getByTestId('report-period-start')).toHaveValue('2026-08-01');
    expect(screen.getByTestId('report-period-end')).toHaveValue('2026-08-31');
  });

  it('drops start/end when switching away from custom, so the API never sees a stale window', async () => {
    const onChange = vi.fn();
    render(<ReportPeriodField value={{ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }} onChange={onChange} />);
    await userEvent.setup().selectOptions(screen.getByTestId('report-period-kind'), 'last_quarter');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'last_quarter' });
  });

  it('drops a cleared boundary rather than sending an empty string', () => {
    const onChange = vi.fn();
    render(<ReportPeriodField value={{ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('report-period-start'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'custom', end: '2026-08-31' });
  });

  it('shows no error for a preset or a valid custom window (a single day is valid: end is inclusive)', () => {
    const { rerender } = render(<ReportPeriodField value={DEFAULT_REPORT_PERIOD} onChange={() => {}} />);
    expect(screen.queryByTestId('report-period-error')).toBeNull();
    rerender(<ReportPeriodField value={{ kind: 'custom', start: '2026-08-15', end: '2026-08-15' }} onChange={() => {}} />);
    expect(screen.queryByTestId('report-period-error')).toBeNull();
  });

  it('explains an incomplete custom window inline', () => {
    render(<ReportPeriodField value={{ kind: 'custom', start: '2026-08-01' }} onChange={() => {}} />);
    expect(screen.getByTestId('report-period-error')).toHaveTextContent(/both/i);
  });

  it('explains a custom window whose start is after its end inline', () => {
    render(<ReportPeriodField value={{ kind: 'custom', start: '2026-08-31', end: '2026-08-01' }} onChange={() => {}} />);
    expect(screen.getByTestId('report-period-error')).toHaveTextContent(/after/i);
  });

  it('explains a custom boundary that is not a real calendar date inline', () => {
    render(<ReportPeriodField value={{ kind: 'custom', start: '2026-02-31', end: '2026-03-31' }} onChange={() => {}} />);
    expect(screen.getByTestId('report-period-error')).toHaveTextContent(/real/i);
  });

  it('reads a persisted config back, and falls back to the default for junk', () => {
    expect(reportPeriodFromConfig({ kind: 'last_30_days' })).toEqual({ kind: 'last_30_days' });
    expect(reportPeriodFromConfig({ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }))
      .toEqual({ kind: 'custom', start: '2026-08-01', end: '2026-08-31' });
    expect(reportPeriodFromConfig({ kind: 'since_forever' })).toEqual(DEFAULT_REPORT_PERIOD);
    expect(reportPeriodFromConfig(undefined)).toEqual(DEFAULT_REPORT_PERIOD);
    // Anything the server's periodSchema would 400 on must not seed the form.
    expect(reportPeriodFromConfig({ kind: 'custom', start: '2026-08-01' })).toEqual(DEFAULT_REPORT_PERIOD);
    expect(reportPeriodFromConfig({ kind: 'custom', start: '2026-02-31', end: '2026-03-31' })).toEqual(DEFAULT_REPORT_PERIOD);
    expect(reportPeriodFromConfig({ kind: 'custom', start: '2026-08-31', end: '2026-08-01' })).toEqual(DEFAULT_REPORT_PERIOD);
    // A preset never carries stale boundaries.
    expect(reportPeriodFromConfig({ kind: 'last_quarter', start: '2026-08-01', end: '2026-08-31' }))
      .toEqual({ kind: 'last_quarter' });
  });

  it('agrees with the server schema on validity', () => {
    expect(isReportPeriodValid({ kind: 'last_full_month' })).toBe(true);
    expect(isReportPeriodValid({ kind: 'custom', start: '2026-08-01', end: '2026-08-31' })).toBe(true);
    expect(isReportPeriodValid({ kind: 'custom', start: '2026-08-01', end: '2026-08-01' })).toBe(true);
    expect(isReportPeriodValid({ kind: 'custom' })).toBe(false);
    expect(isReportPeriodValid({ kind: 'custom', start: '2026-09-01', end: '2026-08-01' })).toBe(false);
    expect(isReportPeriodValid({ kind: 'custom', start: '2026-02-30', end: '2026-03-01' })).toBe(false);
  });
});
