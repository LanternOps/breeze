import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import BillingOutcome, { type BillingOutcomeStamp } from './BillingOutcome';

describe('BillingOutcome', () => {
  it.each<[BillingOutcomeStamp, string]>([
    [{ coverage: 'included', isBillable: true, hourlyRate: null }, 'Included'],
    [{ coverage: 'non_billable', isBillable: false, hourlyRate: null }, 'Non-billable'],
    [{ coverage: 'billable', isBillable: true, hourlyRate: '225.00', currencyCode: 'USD', minimumMinutes: 60 }, '$225.00/h · 60 min minimum'],
    [{ coverage: 'billable', isBillable: true, hourlyRate: null }, 'Billable · rate not configured'],
  ])('renders the persisted billing stamp %j', (stamp, expected) => {
    render(<BillingOutcome stamp={stamp} testId="outcome" />);
    expect(screen.getByTestId('outcome')).toHaveTextContent(expected);
  });

  it('does not label a changed work type with the previous rate', () => {
    render(<BillingOutcome stamp={{ isBillable: true, hourlyRate: '225', currencyCode: 'USD' }} pending testId="outcome" />);
    expect(screen.getByTestId('outcome')).toHaveTextContent('Billing is recalculated for this work type when saved.');
    expect(screen.getByTestId('outcome')).not.toHaveTextContent('225');
  });
});


it('previews manager rate overrides on included work and billable toggles', () => {
  const { rerender } = render(<BillingOutcome stamp={{ coverage: 'included', isBillable: true, hourlyRate: null, currencyCode: 'USD' }} overrides={{ hourlyRate: '225' }} testId="outcome" />);
  expect(screen.getByTestId('outcome')).toHaveTextContent('$225.00/h');
  rerender(<BillingOutcome stamp={{ coverage: 'included', isBillable: true, currencyCode: 'USD' }} overrides={{ isBillable: false }} testId="outcome" />);
  expect(screen.getByTestId('outcome')).toHaveTextContent('Non-billable');
});
