import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InvoiceDetail from './InvoiceDetail';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';
import { _resetShowMarginMemoryForTests, SHOW_INTERNAL_MARGIN_KEY } from './billingUi';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const invoice: InvoiceDetailData['invoice'] = {
  id: 'inv-1', invoiceNumber: 'INV-1', orgId: 'org-1', siteId: null, status: 'sent',
  currencyCode: 'USD', issueDate: '2026-07-01', dueDate: '2026-07-31', sentAt: null,
  subtotal: '20.00', taxRate: null, taxTotal: '0.00', total: '20.00', amountPaid: '0.00',
  balance: '20.00', billToName: 'Acme', notes: null, termsAndConditions: null,
  sellerSnapshot: null, createdAt: '2026-07-01T00:00:00.000Z', evidenceVersion: 1,
};
const line = (id: string, over: Partial<InvoiceDetailData['lines'][number]>): InvoiceDetailData['lines'][number] => ({
  id, invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  name: 'Item', description: 'Blurb', quantity: '1.00', unitPrice: '10.00', costBasis: '4.00',
  revenueAllocation: null, taxable: false, customerVisible: true, lineTotal: '10.00',
  isUnapprovedTime: false, sortOrder: 0, deviceCount: 0, ...over,
});

beforeEach(() => {
  localStorage.clear();
  _resetShowMarginMemoryForTests();
  vi.mocked(fetchWithAuth).mockResolvedValue({
    ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }),
  } as unknown as Response);
});

describe('InvoiceDetail staff rows use the shared description cell (#9423)', () => {
  it('renders an internal-only line with the hidden marker in the internal view — never dropped', () => {
    localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '1');
    render(<InvoiceDetail onChanged={vi.fn()} detail={{
      autopay: null, invoice,
      lines: [
        line('a', { name: 'Visible one' }),
        line('b', { name: 'Internal only', customerVisible: false, description: 'secret\nnote' }),
      ],
    }} />);
    const hidden = screen.getByTestId('invoice-detail-line-b');
    expect(hidden.textContent).toContain('Internal only');
    expect(hidden.textContent).toContain('(hidden)');
    expect(screen.getByTestId('invoice-detail-line-a').textContent).not.toContain('(hidden)');
    // Each row keeps its own description, not its neighbour's.
    expect(screen.getByTestId('document-line-blurb-b').textContent).toBe('secret\nnote');
    expect(screen.getByTestId('document-line-blurb-a').textContent).toBe('Blurb');
  });

  it('hides the child-line arrow from assistive tech', () => {
    render(<InvoiceDetail onChanged={vi.fn()} detail={{
      autopay: null, invoice,
      lines: [line('a', {}), line('c', { name: 'Child', parentLineId: 'a' })],
    }} />);
    const arrow = screen.getByTestId('invoice-detail-line-c').querySelector('[aria-hidden="true"]');
    expect(arrow?.textContent).toContain('↳');
  });

  it('omits the internal-only line from the customer view', () => {
    render(<InvoiceDetail onChanged={vi.fn()} detail={{
      autopay: null, invoice,
      lines: [line('a', {}), line('b', { name: 'Internal only', customerVisible: false })],
    }} />);
    expect(screen.queryByTestId('invoice-detail-line-b')).toBeNull();
    expect(screen.getByTestId('document-line-blurb-a')).toBeTruthy();
  });
});
