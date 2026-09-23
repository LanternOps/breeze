import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_AR_AGING_OPTIONS,
  ArAgingOptionsFields,
  ArAgingOptionsForm,
  arAgingOptionsFromConfig,
  arAgingConfigFromOptions,
} from './ArAgingOptionsForm';

describe('ArAgingOptionsFields (#3198 W03)', () => {
  it('leaves "as of" empty by default and says it means run time', () => {
    render(<ArAgingOptionsFields value={DEFAULT_AR_AGING_OPTIONS} onChange={() => {}} />);
    expect(screen.getByTestId('ar-aging-as-of')).toHaveValue('');
    expect(screen.getByTestId('ar-aging-as-of-help')).toHaveTextContent(/run/i);
  });

  it('does not claim the as-of date reconstructs historical balances', () => {
    render(<ArAgingOptionsFields value={DEFAULT_AR_AGING_OPTIONS} onChange={() => {}} />);
    // arAgingReport.ts CURRENT_BALANCE_NOTE: asOf moves only the aging
    // reference date; balances are current and later payments are not undone.
    const help = screen.getByTestId('ar-aging-as-of-help');
    expect(help).toHaveTextContent(/not reconstruct/i);
    expect(help).not.toHaveTextContent(/reproduce/i);
  });

  it('reports a chosen as-of date, and a cleared one as null', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ArAgingOptionsFields value={DEFAULT_AR_AGING_OPTIONS} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('ar-aging-as-of'), { target: { value: '2026-08-31' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ asOf: '2026-08-31' }));

    rerender(<ArAgingOptionsFields value={{ ...DEFAULT_AR_AGING_OPTIONS, asOf: '2026-08-31' }} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('ar-aging-as-of'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ asOf: null }));
  });

  it('states the no-FX rule where the currency axis is chosen', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ArAgingOptionsFields value={DEFAULT_AR_AGING_OPTIONS} onChange={onChange} />);
    await userEvent.setup().selectOptions(screen.getByTestId('ar-aging-group-by'), 'currency');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'currency' }));
    rerender(<ArAgingOptionsFields value={{ ...DEFAULT_AR_AGING_OPTIONS, groupBy: 'currency' }} onChange={onChange} />);
    // Open Decision 4 = A: one set of totals per currency, never converted.
    expect(screen.getByTestId('ar-aging-currency-note')).toHaveTextContent(/not converted/i);
  });

  it('labels the paid-invoices toggle as a month-to-date note', async () => {
    const onChange = vi.fn();
    render(<ArAgingOptionsFields value={DEFAULT_AR_AGING_OPTIONS} onChange={onChange} />);
    // T9a: the generator lists invoices fully paid month-to-date of the as-of
    // date as an informational note; it never moves a bucket.
    expect(screen.getByTestId('ar-aging-include-paid-label')).toHaveTextContent(/month to date/i);
    expect(screen.getByTestId('ar-aging-include-paid-help')).toHaveTextContent(/note/i);
    await userEvent.setup().click(screen.getByTestId('ar-aging-include-paid'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ includePaidInPeriod: true }));
  });
});

describe('ArAgingOptionsForm', () => {
  it('disables submit and explains an as-of that is not a real calendar date', () => {
    render(
      <ArAgingOptionsForm
        value={{ ...DEFAULT_AR_AGING_OPTIONS, asOf: '2026-02-31' }}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('ar-aging-create-report')).toBeDisabled();
    expect(screen.getByTestId('ar-aging-as-of-error')).toBeInTheDocument();
  });

  it('enables submit for an unset as-of', () => {
    render(
      <ArAgingOptionsForm
        value={DEFAULT_AR_AGING_OPTIONS}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('ar-aging-create-report')).toBeEnabled();
    expect(screen.queryByTestId('ar-aging-as-of-error')).toBeNull();
  });
});

describe('arAgingConfigFromOptions', () => {
  it('OMITS asOf when unset rather than sending null', () => {
    // The server schema types asOf as an optional date. A null would 400,
    // and today's date would freeze a monthly schedule to its creation day.
    expect(arAgingConfigFromOptions(DEFAULT_AR_AGING_OPTIONS)).toEqual({
      groupBy: 'organization',
      includePaidInPeriod: false,
    });
  });

  it('includes asOf when the user picked one', () => {
    expect(arAgingConfigFromOptions({ ...DEFAULT_AR_AGING_OPTIONS, asOf: '2026-08-31' }))
      .toEqual({ asOf: '2026-08-31', groupBy: 'organization', includePaidInPeriod: false });
  });
});

describe('arAgingOptionsFromConfig', () => {
  it('falls back to the schema defaults for an empty config', () => {
    expect(arAgingOptionsFromConfig({})).toEqual(DEFAULT_AR_AGING_OPTIONS);
  });

  it('drops a malformed or impossible as-of rather than seeding a value the API would reject', () => {
    expect(arAgingOptionsFromConfig({ asOf: 'last tuesday' }).asOf).toBeNull();
    expect(arAgingOptionsFromConfig({ asOf: '2026-02-31' }).asOf).toBeNull();
    expect(arAgingOptionsFromConfig({ asOf: '2026-08-31' }).asOf).toBe('2026-08-31');
  });

  it('keeps includePaidInPeriod off unless it is explicitly true', () => {
    expect(arAgingOptionsFromConfig({ includePaidInPeriod: 'yes' }).includePaidInPeriod).toBe(false);
    expect(arAgingOptionsFromConfig({ includePaidInPeriod: true }).includePaidInPeriod).toBe(true);
  });
});
