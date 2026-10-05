// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
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

describe('PublicInvoiceView — autopay payment waiting on the bank (off-session 3DS)', () => {
  const waiting = () => detail({ collectionInProgress: { amount: '100.00', actionRequired: true } });

  it('tells the truth instead of "no action needed" and offers the way out', () => {
    render(<PublicInvoiceView token="t" initial={waiting()} />);
    const notice = screen.getByTestId('autopay-confirmation-notice');
    expect(notice.textContent).toContain('Your bank needs you to confirm this payment');
    expect(notice.textContent).toContain('$100.00');
    expect(screen.queryByTestId('public-invoice-collection-processing')).toBeNull();
    expect(document.body.textContent).not.toContain('No action needed');
    expect((screen.getByTestId('public-invoice-pay') as HTMLButtonElement).disabled).toBe(true);
  });

  it('releases the off-session payment, reloads the invoice and lets the card Pay button work', async () => {
    const { portalApi } = await import('@/lib/api');
    const release = vi.spyOn(portalApi, 'releasePublicAutopayConfirmation').mockResolvedValue({ data: { data: { outcome: 'released' } }, statusCode: 200 });
    const reload = vi.spyOn(portalApi, 'getPublicInvoice').mockResolvedValue({ data: { data: detail({ collectionInProgress: null }) }, statusCode: 200 });
    const pay = vi.spyOn(portalApi, 'payPublicInvoice').mockResolvedValue({ error: 'stop here', statusCode: 409 });
    render(<PublicInvoiceView token="t" initial={waiting()} />);
    fireEvent.click(screen.getByTestId('autopay-confirmation-continue'));
    await waitFor(() => expect(release).toHaveBeenCalledWith('t'));
    await waitFor(() => expect(reload).toHaveBeenCalledWith('t', { redirectOnUnauthorized: false }));
    await waitFor(() => expect((screen.getByTestId('public-invoice-pay') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId('autopay-confirmation-notice')).toBeNull();
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    await waitFor(() => expect(pay).toHaveBeenCalledWith('t', { saveForAutopay: false }));
  });

  it('reports a payment that is already processing instead of releasing it', async () => {
    const { portalApi } = await import('@/lib/api');
    vi.spyOn(portalApi, 'releasePublicAutopayConfirmation').mockResolvedValue({ data: { data: { outcome: 'processing' } }, statusCode: 200 });
    const reload = vi.spyOn(portalApi, 'getPublicInvoice');
    render(<PublicInvoiceView token="t" initial={waiting()} />);
    fireEvent.click(screen.getByTestId('autopay-confirmation-continue'));
    expect(await screen.findByTestId('autopay-confirmation-result')).toHaveTextContent('already processing');
    expect(reload).not.toHaveBeenCalled();
  });
});
