// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { portalApi, type PublicQuoteDetail, type PublicQuotePayment } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/replaceLocation', () => ({ replaceLocation: vi.fn() }));

import { PublicQuoteView } from './PublicQuoteView';
import { replaceLocation } from '@/lib/replaceLocation';

const PAYMENT: PublicQuotePayment = { amount: '324.00', currencyCode: 'USD', isDeposit: false, invoiceNumber: 'INV-0042' };
const CHECKOUT = 'https://checkout.stripe.com/c/pay/x';

const DETAIL: PublicQuoteDetail = {
  quote: {
    id: '11111111-1111-4111-8111-111111111111', quoteNumber: 'Q-2026-0042', title: 'Managed Services',
    status: 'viewed', currencyCode: 'USD', issueDate: '2026-07-01', expiryDate: '2026-08-01',
    subtotal: '324.00', taxRate: null, taxTotal: '0.00', total: '324.00', oneTimeTotal: '324.00',
    monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', depositType: 'none', depositAmount: null,
    dueOnAcceptanceTotal: '324.00', depositDueTotal: null, categoryBreakdown: [], billToName: 'Acme Co',
    introNotes: null, terms: null, sellerSnapshot: null, coverPage: null, termsAndConditions: null,
  },
  blocks: [],
  lines: [],
  branding: { partnerName: 'Lantern IT', logoUrl: null, primaryColor: '#123456' },
};

const sign = () => {
  fireEvent.change(screen.getByTestId('public-quote-signer'), { target: { value: 'Pat Prospect' } });
  fireEvent.click(screen.getByTestId('public-quote-agree'));
  fireEvent.click(screen.getByTestId('public-quote-accept'));
};

beforeEach(() => vi.mocked(replaceLocation).mockClear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PublicQuoteView — revisiting an accepted quote link (#3740 b)', () => {
  it('turns the spent link into a payment step instead of "invalid or expired"', () => {
    render(<PublicQuoteView token="spent-token" initial={null} accepted={{ partnerName: 'Lantern IT', payment: PAYMENT }} />);

    const step = screen.getByTestId('public-quote-payment-step');
    expect(step.textContent).toContain('Acceptance recorded');
    expect(step.textContent).toContain('$324.00');
    expect(step.textContent).toContain('INV-0042');
    expect(screen.queryByTestId('public-quote-error')).toBeNull();
  });

  it('pays through the quote link and goes to the returned checkout', async () => {
    const paySpy = vi.spyOn(portalApi, 'payPublicQuote').mockResolvedValue({ data: { data: { url: CHECKOUT } } });
    render(<PublicQuoteView token="spent-token" initial={null} accepted={{ partnerName: 'Lantern IT', payment: PAYMENT }} />);

    fireEvent.click(screen.getByTestId('public-quote-pay-now'));

    await waitFor(() => expect(replaceLocation).toHaveBeenCalledWith(CHECKOUT));
    expect(paySpy).toHaveBeenCalledWith('spent-token');
  });

  it('says why payment did not start and stays on the page', async () => {
    vi.spyOn(portalApi, 'payPublicQuote').mockResolvedValue({
      error: 'A payment is already processing', code: 'COLLECTION_IN_PROGRESS', statusCode: 409,
    });
    render(<PublicQuoteView token="spent-token" initial={null} accepted={{ partnerName: 'Lantern IT', payment: PAYMENT }} />);

    fireEvent.click(screen.getByTestId('public-quote-pay-now'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already processing'));
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it('labels a deposit as a deposit', () => {
    render(<PublicQuoteView token="spent-token" initial={null}
      accepted={{ partnerName: 'Lantern IT', payment: { ...PAYMENT, amount: '97.20', isDeposit: true } }} />);
    expect(screen.getByTestId('public-quote-pay-now').textContent).toBe('Pay deposit $97.20');
  });

  it('shows no Pay button when nothing can be paid online', () => {
    render(<PublicQuoteView token="spent-token" initial={null} accepted={{ partnerName: 'Lantern IT', payment: null }} />);

    expect(screen.getByTestId('public-quote-accepted').textContent).toContain('accepted');
    expect(screen.queryByTestId('public-quote-pay-now')).toBeNull();
    expect(screen.queryByTestId('public-quote-error')).toBeNull();
  });

  it('offers the payment step on a still-live link to an accepted quote', () => {
    render(<PublicQuoteView token="live-token" initial={{ ...DETAIL, quote: { ...DETAIL.quote, status: 'converted' } }}
      accepted={{ partnerName: 'Lantern IT', payment: PAYMENT }} />);

    expect(screen.getByTestId('public-quote-payment-step').textContent).toContain('$324.00');
  });
});

describe('PublicQuoteView — accept with no invoice page to land on (#3740 a)', () => {
  it('makes payment the next step when payment is due', async () => {
    vi.spyOn(portalApi, 'acceptPublicQuote').mockResolvedValue({ data: { data: {
      status: 'converted', invoiceNumber: null, invoiceUrl: null, checkoutUrl: null, payDeferred: true, payment: PAYMENT,
    } } });
    render(<PublicQuoteView token="public-token" initial={{ ...DETAIL, payOnAccept: true }} />);

    sign();

    await waitFor(() => expect(screen.getByTestId('public-quote-payment-step').textContent).toContain('one more step'));
    expect(screen.getByTestId('public-quote-pay-now').textContent).toBe('Pay $324.00');
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it('does not promise an email it cannot guarantee when nothing can be paid here', async () => {
    vi.spyOn(portalApi, 'acceptPublicQuote').mockResolvedValue({ data: { data: {
      status: 'converted', invoiceNumber: null, invoiceUrl: null, checkoutUrl: null, payDeferred: true, payment: null,
    } } });
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    sign();

    await waitFor(() => expect(screen.getByTestId('public-quote-accepted').textContent).toContain('Signed and accepted'));
    expect(screen.getByTestId('public-quote-accepted').textContent).not.toMatch(/email/i);
    expect(screen.queryByTestId('public-quote-pay-now')).toBeNull();
  });

  it('shows no payment step when nothing is due (recurring-only accept)', async () => {
    vi.spyOn(portalApi, 'acceptPublicQuote').mockResolvedValue({ data: { data: {
      status: 'converted', invoiceNumber: null, invoiceUrl: null, checkoutUrl: null, payDeferred: false, payment: null,
    } } });
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    sign();

    await waitFor(() => expect(screen.getByTestId('public-quote-accepted').textContent).toContain('Thank you'));
    expect(screen.queryByTestId('public-quote-payment-step')).toBeNull();
  });
});
