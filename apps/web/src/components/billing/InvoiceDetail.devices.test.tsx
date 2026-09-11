import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InvoiceDetail from './InvoiceDetail';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

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
const line = (id: string, deviceCount: number): InvoiceDetailData['lines'][number] => ({
  id, invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  name: `Line ${id}`, description: null, quantity: '1.00', unitPrice: '10.00', costBasis: null,
  revenueAllocation: null, taxable: false, customerVisible: true, lineTotal: '10.00',
  isUnapprovedTime: false, sortOrder: 0, deviceCount,
});

beforeEach(() => {
  vi.mocked(fetchWithAuth).mockResolvedValue({
    ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }),
  } as unknown as Response);
});

function renderDetail(over: Partial<InvoiceDetailData>) {
  return render(<InvoiceDetail detail={{ invoice, lines: [line('a', 2), line('b', 0)], ...over }} onChanged={vi.fn()} />);
}

describe('InvoiceDetail device evidence (#3205 W07)', () => {
  it('renders the not-recorded notice ONCE above the line table when evidenceVersion is null', () => {
    renderDetail({ invoice: { ...invoice, evidenceVersion: null } });
    expect(screen.getAllByTestId('invoice-devices-not-recorded')).toHaveLength(1);
    const notice = screen.getByTestId('invoice-devices-not-recorded');
    const table = screen.getByTestId('invoice-detail-lines');
    expect(notice.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders NO notice for a recorded invoice, even when a line has zero devices', () => {
    renderDetail({ invoice: { ...invoice, evidenceVersion: 1 }, lines: [line('a', 0)] });
    expect(screen.queryByTestId('invoice-devices-not-recorded')).toBeNull();
  });

  it('renders a toggle only for lines with deviceCount > 0', () => {
    renderDetail({ lines: [line('a', 3), line('b', 0)] });
    expect(screen.getByTestId('invoice-line-devices-toggle-a')).toBeTruthy();
    expect(screen.queryByTestId('invoice-line-devices-toggle-b')).toBeNull();
  });
});
