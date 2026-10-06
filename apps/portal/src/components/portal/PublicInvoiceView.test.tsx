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

  it('offers no Pay and says the payment is being collected while a collection is in flight', async () => {
    render(<PublicInvoiceView token="t" initial={detail({ collectionInProgress: { amount: '100.00' } })} />);
    expect(screen.queryByTestId('public-invoice-pay')).toBeNull();
    const note = screen.getByTestId('public-invoice-collection-processing');
    expect(note.textContent).toContain('$100.00 is being collected');
    expect(note.textContent).toContain('No action needed.');
    // Informational, not amber: the client has nothing to do (DESIGN.md).
    expect(note.innerHTML).not.toContain('text-warning');
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
    expect(screen.queryByTestId('public-invoice-pay')).toBeNull();
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
    expect(screen.getByTestId('autopay-confirmation-released')).toHaveTextContent('Pay below');
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    await waitFor(() => expect(pay).toHaveBeenCalledWith('t', { saveForAutopay: false }));
  });

  // PR #7983 review: a released payment must stay visibly released, and Pay must work,
  // even when re-reading the invoice afterwards fails or throws.
  it.each([
    ['fails', { error: 'Network error' }],
    ['throws', null],
  ] as const)('keeps the released state and a working Pay when reloading the invoice %s', async (_label, response) => {
    const { portalApi } = await import('@/lib/api');
    vi.spyOn(portalApi, 'releasePublicAutopayConfirmation').mockResolvedValue({ data: { data: { outcome: 'released' } }, statusCode: 200 });
    const reload = vi.spyOn(portalApi, 'getPublicInvoice');
    if (response) reload.mockResolvedValue(response as never); else reload.mockRejectedValue(new Error('offline'));
    const pay = vi.spyOn(portalApi, 'payPublicInvoice').mockResolvedValue({ error: 'stop here', statusCode: 409 });
    render(<PublicInvoiceView token="t" initial={waiting()} />);
    fireEvent.click(screen.getByTestId('autopay-confirmation-continue'));
    expect(await screen.findByTestId('autopay-confirmation-released')).toHaveTextContent('The automatic payment was canceled.');
    await waitFor(() => expect(screen.getByTestId('autopay-confirmation-released')).toHaveTextContent("We couldn't refresh the invoice"));
    expect(document.body.textContent).not.toContain('Continue to cancel');
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

// Visual QA 2026-10-05: one paper, identical on the public and portal pages.
describe('PublicInvoiceView — paper and rail layout', () => {
  const long = { name: 'Managed services for the whole office including https://very-long-unbroken-host-name.example.internal/path/segment', description: '',
    quantity: '1.00', unitPrice: '1234567.00', lineTotal: '1234567.00', taxable: false, ticketNumber: null };
  it('the payment rail sticks at lg from its grid item, not from inside it (V-4)', () => {
    render(<PublicInvoiceView token="t" initial={detail()} />);
    const wrapper = screen.getByTestId('invoice-payment-panel').parentElement!;
    expect(wrapper).toHaveClass('lg:sticky', 'lg:top-6', 'lg:self-start');
    expect(screen.getByTestId('invoice-payment-panel')).not.toHaveClass('lg:sticky');
  });
  it('a long unbroken description wraps, and amounts never wrap (V-6)', () => {
    render(<PublicInvoiceView token="t" initial={detail({ lines: [long] as never })} />);
    const cell = screen.getByText(long.name).closest('td')!;
    expect(cell).toHaveClass('[overflow-wrap:anywhere]');
    const amount = screen.getAllByText('$1,234,567.00').find(el => el.tagName === 'TD')!;
    expect(amount).toHaveClass('whitespace-nowrap');
  });
  it('the balance-due figure speaks the serif, and the paper dates are long (V-26, V-27)', () => {
    render(<PublicInvoiceView token="t" initial={detail()} />);
    expect(screen.getByTestId('public-invoice-balance')).toHaveClass('font-display');
    expect(screen.getByText('August 31, 2026')).toBeInTheDocument();
    expect(screen.getByText('August 1, 2026')).toBeInTheDocument();
  });
});
