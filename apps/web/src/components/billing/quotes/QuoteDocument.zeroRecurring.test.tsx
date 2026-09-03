import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { QuoteDocument } from './QuoteDocument';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: { id: string; name: string }[] }) => unknown) =>
    selector({ organizations: [{ id: 'org-1', name: 'Acme' }] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

/**
 * #3205 W05 decision 21. A device-set line counting ZERO devices is a
 * first-class, expected state (quoting a brand-new customer). Visibility is
 * therefore keyed on recurrence, while every displayed amount remains the
 * money-derived 0.00.
 */
const zeroQuote = {
  id: 'q1', quoteNumber: 'Q-ZERO', orgId: 'org-1', status: 'draft', currencyCode: 'USD',
  subtotal: '0.00', taxRate: null, taxTotal: '0.00', total: '0.00',
  oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
  dueOnAcceptanceTotal: '0.00', categoryBreakdown: [
    { category: 'other', oneTimeTotal: '0.00', monthlyTotal: '0.00', annualTotal: '0.00' },
  ],
};
const zeroLine = {
  id: 'l1', quoteId: 'q1', blockId: 'b1', orgId: 'org-1', sourceType: 'manual', catalogItemId: null,
  parentLineId: null, name: 'Servers', description: null, quantity: '0.00', unitPrice: '40.00',
  unitCost: null, sku: null, partNumber: null, lineTotal: '0.00', recurrence: 'monthly', taxable: false,
  customerVisible: true, termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-09-03T00:00:00Z', contractLineType: 'per_device_role', deviceRoles: ['server'],
  deviceGroupId: null, deviceGroupName: null, siteId: null, siteName: null,
  includedQuantity: null, overageMode: null, overageUnitPrice: null,
};
const block = {
  id: 'b1', quoteId: 'q1', orgId: 'org-1', blockType: 'line_items',
  content: { showSubtotal: true }, sortOrder: 0, createdAt: '2026-09-03T00:00:00Z',
};

function renderZero(line: Record<string, unknown> = zeroLine) {
  render(<QuoteDocument detail={{ quote: zeroQuote, blocks: [block], lines: [line] } as never} customerName="Acme" />);
}

describe('QuoteDocument with a zero-quantity recurring device-set line', () => {
  it('still renders the recurring summary, cadence row, table subtotal and category row', () => {
    renderZero();
    expect(screen.getByTestId('quote-document-first-period')).toBeInTheDocument();
    expect(screen.getByText(/Monthly recurring/i)).toBeInTheDocument();
    expect(screen.getByTestId('quote-table-subtotal')).toHaveTextContent('$0.00');
    expect(screen.getByTestId('quote-document-category-other')).toHaveTextContent('$0.00/mo');
  });

  it('renders the estimate sentence', () => {
    renderZero();
    expect(screen.getByText(/Estimated quantity/i)).toBeInTheDocument();
    expect(screen.getByTestId('quote-line-device-set-l1')).toHaveTextContent(/each billing period/i);
  });

  it('uses the canonical case-sensitive nouns for IoT and NAS roles', () => {
    renderZero({ ...zeroLine, deviceRoles: ['iot', 'nas'] });
    expect(screen.getByTestId('quote-line-device-set-l1')).toHaveTextContent('IoT devices, NAS devices');
  });

  it('renders identically for a plain manual recurring line at quantity 0', () => {
    renderZero({ ...zeroLine, contractLineType: null, deviceRoles: null });
    expect(screen.getByTestId('quote-document-first-period')).toBeInTheDocument();
    expect(screen.getByText(/Monthly recurring/i)).toBeInTheDocument();
  });
});
