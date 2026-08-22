// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api', () => ({}));

import { QuoteList } from './QuoteList';
import type { QuoteSummary } from '@/lib/api';

const quote = (over: Partial<QuoteSummary> = {}): QuoteSummary => ({
  id: 'q1',
  quoteNumber: 'Q-1',
  title: null,
  status: 'sent',
  currencyCode: 'USD',
  issueDate: null,
  expiryDate: null,
  total: '100.00',
  ...over,
});

describe('QuoteList — ledger foot', () => {
  it('counts only what still needs the customer: sent + viewed', () => {
    render(
      <QuoteList
        quotes={[
          quote({ id: 'a', status: 'sent' }),
          quote({ id: 'b', status: 'viewed' }),
          quote({ id: 'c', status: 'accepted' }),
          quote({ id: 'd', status: 'declined' }),
          quote({ id: 'e', status: 'expired' }),
        ]}
      />
    );
    expect(screen.getByTestId('quote-ledger-foot').textContent).toBe('2 proposals awaiting your review');
  });

  it('reads singular for one, and "Nothing awaiting" when all are settled', () => {
    const { unmount } = render(<QuoteList quotes={[quote({ status: 'viewed' })]} />);
    expect(screen.getByTestId('quote-ledger-foot').textContent).toBe('1 proposal awaiting your review');
    unmount();
    render(<QuoteList quotes={[quote({ status: 'converted' })]} />);
    expect(screen.getByTestId('quote-ledger-foot').textContent).toBe('Nothing awaiting your review');
  });

  it('shows converted proposals to the customer as Accepted', () => {
    render(<QuoteList quotes={[quote({ status: 'converted' })]} />);
    expect(screen.getByText('Accepted')).toBeTruthy();
  });
});
