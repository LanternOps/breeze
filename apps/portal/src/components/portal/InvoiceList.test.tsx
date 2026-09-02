// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api', () => ({}));

import { InvoiceList } from './InvoiceList';
import type { InvoiceSummary } from '@/lib/api';

const inv = (over: Partial<InvoiceSummary> = {}): InvoiceSummary => ({
  id: 'a',
  invoiceNumber: 'INV-1',
  title: null,
  status: 'sent',
  currencyCode: 'USD',
  issueDate: null,
  dueDate: null,
  total: '100.00',
  amountPaid: '0',
  balance: '100.00',
  depositDue: null,
  ...over,
});

describe('InvoiceList — ledger foot', () => {
  it('totals the BALANCE column (not total) when every invoice shares one currency', () => {
    render(
      <InvoiceList
        invoices={[
          inv({ id: 'a', balance: '40.00' }),
          inv({ id: 'b', invoiceNumber: 'INV-2', total: '500.00', balance: '10.50' }),
        ]}
      />
    );
    const foot = screen.getByTestId('invoice-ledger-foot').textContent ?? '';
    expect(foot).toContain('Total outstanding');
    expect(foot).toContain('$50.50');
  });

  it('omits the foot entirely on mixed currencies — a mixed sum is a made-up number', () => {
    render(
      <InvoiceList
        invoices={[inv({ id: 'a' }), inv({ id: 'b', invoiceNumber: 'INV-2', currencyCode: 'EUR' })]}
      />
    );
    expect(screen.queryByTestId('invoice-ledger-foot')).toBeNull();
  });

  it('reads "All settled" at zero balance', () => {
    render(<InvoiceList invoices={[inv({ balance: '0.00', status: 'paid' })]} />);
    expect(screen.getByTestId('invoice-ledger-foot').textContent).toContain('All settled');
  });
});

describe('InvoiceList — names', () => {
  it('leads with the derived title and trails the number; number leads when title is null', () => {
    render(
      <InvoiceList
        invoices={[
          inv({ id: 'a', title: 'Managed IT — August' }),
          inv({ id: 'b', invoiceNumber: 'INV-2', title: null }),
        ]}
      />
    );
    expect(screen.getByText('Managed IT — August').closest('a')).toBeTruthy();
    expect(screen.getByText('INV-1')).toBeTruthy(); // trailing number for the titled row
    expect(screen.getByText('INV-2').closest('a')).toBeTruthy(); // number leads untitled row
  });

  it('keeps one mark per row: deposit state is plain text', () => {
    render(<InvoiceList invoices={[inv({ depositDue: '50.00', amountPaid: '0' })]} />);
    expect(screen.getByTestId('deposit-unpaid-badge').textContent).toBe('Deposit unpaid');
  });
});
