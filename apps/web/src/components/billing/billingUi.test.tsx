import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarginPanel } from './billingUi';
import type { QuoteProfit } from '@breeze/shared';

// Task A(2) of the quote-editor UX follow-up pass: MarginPanel shows profit as
// a percent (margin = net/revenue) alongside the dollar figure, guards
// div-by-zero, and self-hides the percent when a cadence has nothing to
// compute one from — never a misleading 0%/NaN.

const profit = (over: Partial<QuoteProfit> = {}): QuoteProfit => ({
  oneTimeNet: '0.00', monthlyRecurringNet: '0.00', annualRecurringNet: '0.00',
  totalCost: '0.00', oneTimeRevenue: '0.00', monthlyRecurringRevenue: '0.00',
  annualRecurringRevenue: '0.00', linesMissingCost: 0, ...over,
});

describe('MarginPanel — profit margin percent', () => {
  it('shows the one-time profit percent (margin, not markup) alongside the dollar figure', () => {
    render(<MarginPanel profit={profit({ oneTimeNet: '30.00', oneTimeRevenue: '50.00', totalCost: '20.00' })} currency="USD" />);
    expect(screen.getByTestId('quote-margin-net-onetime')).toHaveTextContent('$30.00');
    expect(screen.getByTestId('quote-margin-pct-onetime')).toHaveTextContent('(60.0%)');
  });

  it('hides the percent (div-by-zero guard) when the cadence has zero revenue', () => {
    render(<MarginPanel profit={profit()} currency="USD" />);
    expect(screen.getByTestId('quote-margin-net-onetime')).toHaveTextContent('$0.00');
    expect(screen.queryByTestId('quote-margin-pct-onetime')).not.toBeInTheDocument();
  });

  it('hides the percent when every line in the cadence is missing cost (fully incomplete estimate)', () => {
    render(<MarginPanel profit={profit({ oneTimeNet: '0.00', oneTimeRevenue: '0.00', linesMissingCost: 2 })} currency="USD" />);
    expect(screen.queryByTestId('quote-margin-pct-onetime')).not.toBeInTheDocument();
    // The existing missing-cost notice is the shared "estimate incomplete"
    // caveat — no separate copy is needed for the suppressed percent.
    expect(screen.getByTestId('quote-margin-missing-cost')).toBeInTheDocument();
  });

  it('still computes a percent from the available lines when only partially incomplete', () => {
    // computeQuoteProfit already excludes missing-cost lines from both net and
    // revenue, so a partial figure (1 of 2 lines missing cost) yields an exact
    // percent for what IS knowable, alongside the missing-cost warning.
    render(<MarginPanel profit={profit({ oneTimeNet: '30.00', oneTimeRevenue: '50.00', linesMissingCost: 1 })} currency="USD" />);
    expect(screen.getByTestId('quote-margin-pct-onetime')).toHaveTextContent('(60.0%)');
    expect(screen.getByTestId('quote-margin-missing-cost')).toBeInTheDocument();
  });

  it('shows independent monthly/annual percents next to their own rows', () => {
    render(<MarginPanel profit={profit({
      monthlyRecurringNet: '15.00', monthlyRecurringRevenue: '40.00',
      annualRecurringNet: '200.00', annualRecurringRevenue: '1200.00',
    })} currency="USD" />);
    expect(screen.getByTestId('quote-margin-pct-monthly')).toHaveTextContent('(37.5%)');
    expect(screen.getByTestId('quote-margin-pct-annual')).toHaveTextContent('(16.7%)');
  });

  it('handles a negative margin (a loss) without crashing', () => {
    render(<MarginPanel profit={profit({ oneTimeNet: '-10.00', oneTimeRevenue: '50.00' })} currency="USD" />);
    expect(screen.getByTestId('quote-margin-pct-onetime')).toHaveTextContent('(-20.0%)');
  });

  it('namespaces testids per idPrefix (invoice callers don\'t collide with quote callers)', () => {
    render(<MarginPanel profit={profit({ oneTimeNet: '30.00', oneTimeRevenue: '50.00' })} currency="USD" idPrefix="invoice" />);
    expect(screen.getByTestId('invoice-margin-pct-onetime')).toHaveTextContent('(60.0%)');
  });
});
