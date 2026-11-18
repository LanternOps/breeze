import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_QUOTE_WIN_RATE_OPTIONS,
  QuoteWinRateOptionsFields,
  QuoteWinRateOptionsForm,
  isQuoteWinRateOptionsValid,
  quoteWinRateConfigFromOptions,
  quoteWinRateOptionsFromConfig,
} from './QuoteWinRateOptionsForm';

describe('QuoteWinRateOptionsFields (#9828 W2)', () => {
  it('defaults to Automatic grouping, carries the period wrapper test id and states the first-send rule', () => {
    render(<QuoteWinRateOptionsFields value={DEFAULT_QUOTE_WIN_RATE_OPTIONS} onChange={() => {}} />);
    expect(screen.getByTestId('quote-win-rate-group-by')).toHaveValue('');
    expect(screen.getByTestId('quote-win-rate-period')).toBeInTheDocument();
    expect(screen.getByTestId('quote-win-rate-period')).toContainElement(screen.getByTestId('report-period-kind'));
    expect(screen.getByTestId('quote-win-rate-period-note')).toHaveTextContent(/first sent/i);
  });

  it('offers organization, author and currency, and nothing else', () => {
    render(<QuoteWinRateOptionsFields value={DEFAULT_QUOTE_WIN_RATE_OPTIONS} onChange={() => {}} />);
    const options = Array.from(screen.getByTestId('quote-win-rate-group-by').querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['', 'organization', 'author', 'currency']);
  });

  it('reports the chosen axis, and Automatic as null', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<QuoteWinRateOptionsFields value={DEFAULT_QUOTE_WIN_RATE_OPTIONS} onChange={onChange} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('quote-win-rate-group-by'), 'author');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'author' }));

    rerender(<QuoteWinRateOptionsFields value={{ ...DEFAULT_QUOTE_WIN_RATE_OPTIONS, groupBy: 'author' }} onChange={onChange} />);
    await user.selectOptions(screen.getByTestId('quote-win-rate-group-by'), '');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: null }));
  });
});

describe('QuoteWinRateOptionsForm', () => {
  it('disables submit while the custom period is incomplete', () => {
    render(
      <QuoteWinRateOptionsForm
        value={{ ...DEFAULT_QUOTE_WIN_RATE_OPTIONS, period: { kind: 'custom', start: '2026-08-01' } }}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('quote-win-rate-create-report')).toBeDisabled();
    expect(screen.getByTestId('report-period-error')).toBeInTheDocument();
  });

  it('enables submit for the default period and calls onSubmit', async () => {
    const onSubmit = vi.fn();
    render(
      <QuoteWinRateOptionsForm
        value={DEFAULT_QUOTE_WIN_RATE_OPTIONS}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const submit = screen.getByTestId('quote-win-rate-create-report');
    expect(submit).toBeEnabled();
    await userEvent.setup().click(submit);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe('quoteWinRateConfigFromOptions', () => {
  it('OMITS groupBy for Automatic and emits exactly the keys the server schema accepts', () => {
    expect(quoteWinRateConfigFromOptions(DEFAULT_QUOTE_WIN_RATE_OPTIONS)).toEqual({
      period: { kind: 'last_full_month' },
    });
  });

  it('sends an explicit axis when chosen', () => {
    expect(quoteWinRateConfigFromOptions({ ...DEFAULT_QUOTE_WIN_RATE_OPTIONS, groupBy: 'currency' })).toEqual({
      period: { kind: 'last_full_month' },
      groupBy: 'currency',
    });
  });
});

describe('quoteWinRateOptionsFromConfig', () => {
  it('falls back to the defaults for an empty config', () => {
    expect(quoteWinRateOptionsFromConfig({})).toEqual(DEFAULT_QUOTE_WIN_RATE_OPTIONS);
  });

  it('round-trips: fromConfig(toConfig(x)) === x for every axis and period kind', () => {
    for (const groupBy of [null, 'organization', 'author', 'currency'] as const) {
      for (const period of [{ kind: 'last_full_month' }, { kind: 'last_quarter' }, { kind: 'custom', start: '2026-08-01', end: '2026-08-31' }] as const) {
        const options = { period, groupBy };
        expect(quoteWinRateOptionsFromConfig(quoteWinRateConfigFromOptions(options))).toEqual(options);
      }
    }
  });

  it('ignores an axis the server would reject (e.g. a stale AI-usage "model")', () => {
    expect(quoteWinRateOptionsFromConfig({ groupBy: 'model' }).groupBy).toBeNull();
    expect(quoteWinRateOptionsFromConfig({ groupBy: 'site' }).groupBy).toBeNull();
  });
});

describe('isQuoteWinRateOptionsValid', () => {
  it('is false for an incomplete custom period and true otherwise', () => {
    expect(isQuoteWinRateOptionsValid(DEFAULT_QUOTE_WIN_RATE_OPTIONS)).toBe(true);
    expect(isQuoteWinRateOptionsValid({ ...DEFAULT_QUOTE_WIN_RATE_OPTIONS, period: { kind: 'custom' } })).toBe(false);
  });
});
