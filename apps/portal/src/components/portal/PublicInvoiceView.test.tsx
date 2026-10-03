// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import type { PublicInvoiceDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { PublicInvoiceView } from './PublicInvoiceView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function detail(overrides: Partial<PublicInvoiceDetail> = {}): PublicInvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: 'INV-2026-0001', status: 'sent', currencyCode: 'USD',
      issueDate: '2026-08-01', dueDate: '2026-08-31', total: '100.00', amountPaid: '0.00',
      balance: '100.00', depositDue: null, subtotal: '100.00', taxTotal: '0.00', taxRate: null,
    },
    lines: [],
    chargeNow: { amount: '100.00', isDeposit: false },
    payable: true,
    branding: { partnerName: 'Lantern MSP', contactEmail: null, logoUrl: null, primaryColor: null, theme: 'classic', pageSize: 'letter' },
    ...overrides,
  } as PublicInvoiceDetail;
}

describe('PublicInvoiceView — autopay collection in flight (#7824)', () => {
  it('shows an enabled Pay button when nothing is in flight (positive control)', () => {
    render(<PublicInvoiceView token="t" initial={detail({ collectionInProgress: null })} />);
    expect((screen.getByTestId('public-invoice-pay') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables Pay and shows the processing note while a collection is in flight', async () => {
    const { portalApi } = await import('@/lib/api');
    const pay = vi.spyOn(portalApi, 'payPublicInvoice' as never);
    render(<PublicInvoiceView token="t" initial={detail({ collectionInProgress: { amount: '100.00' } })} />);
    const btn = screen.getByTestId('public-invoice-pay') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(pay).not.toHaveBeenCalled();
    const note = screen.getByTestId('public-invoice-collection-processing');
    expect(note.textContent).toContain('Payment processing via autopay');
    expect(note.textContent).toContain('$100.00');
  });
});
