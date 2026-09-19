// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuoteDetailView } from './QuoteDetailView';
import { PublicQuoteView } from './PublicQuoteView';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
afterEach(cleanup);

const detail = {
  quote: {
    id: 'q-zero', quoteNumber: 'Q-ZERO', status: 'sent', currencyCode: 'USD', issueDate: '2026-09-03',
    subtotal: '0.00', taxRate: null, taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00',
    monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00',
    billToName: 'Acme', categoryBreakdown: [], sellerSnapshot: null,
  },
  blocks: [],
  lines: [{
    id: 'l1', description: 'Servers', quantity: '0.00', unitPrice: '40.00', lineTotal: '0.00',
    recurrence: 'monthly', customerVisible: true, sortOrder: 0, contractLineType: 'per_device_role',
    deviceRoles: ['iot', 'nas'], deviceGroupName: null, siteName: null, includedQuantity: null,
    overageMode: null, overageUnitPrice: null,
  }],
  branding: { partnerName: 'Lantern IT', logoUrl: null, primaryColor: '#123456' },
};

describe('portal quote views with zero-money recurring lines', () => {
  it('QuoteDetailView renders the cadence, first-period summary, and estimate sentence', () => {
    render(<QuoteDetailView detail={detail as never} />);
    const monthly = screen.getByText('Monthly recurring');
    expect(monthly.parentElement?.textContent).toContain('$0.00/mo');
    expect(screen.getByText('First-period total')).toBeTruthy();
    expect(screen.getByText(/Estimated quantity/)).toBeTruthy();
    expect(screen.getByText(/IoT devices, NAS devices/)).toBeTruthy();
  });

  it('PublicQuoteView renders the cadence, first-period summary, and estimate sentence', () => {
    render(<PublicQuoteView token="token" initial={detail as never} />);
    const monthly = screen.getByText('Monthly recurring');
    expect(monthly.parentElement?.textContent).toContain('$0.00/mo');
    expect(screen.getByText('First-period total')).toBeTruthy();
    expect(screen.getByText(/Estimated quantity/)).toBeTruthy();
    expect(screen.getByText(/IoT devices, NAS devices/)).toBeTruthy();
  });
});
