// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { portalApi, type PublicQuoteDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { PublicQuoteView } from './PublicQuoteView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DETAIL: PublicQuoteDetail = {
  quote: {
    id: '11111111-1111-4111-8111-111111111111',
    quoteNumber: 'Q-2026-0042',
    title: 'Managed Services',
    status: 'viewed',
    currencyCode: 'USD',
    issueDate: '2026-07-01',
    expiryDate: '2026-08-01',
    subtotal: '432.00',
    taxRate: '0.08000',
    taxTotal: '32.00',
    total: '432.00',
    oneTimeTotal: '300.00',
    monthlyRecurringTotal: '75.00',
    annualRecurringTotal: '25.00',
    depositType: 'percent',
    depositAmount: '97.20',
    dueOnAcceptanceTotal: '324.00',
    depositDueTotal: '97.20',
    categoryBreakdown: [
      { category: 'hardware', oneTimeTotal: '300.00', monthlyTotal: '0.00', annualTotal: '0.00' },
      { category: 'service', oneTimeTotal: '0.00', monthlyTotal: '75.00', annualTotal: '25.00' },
    ],
    billToName: 'Acme Co',
    introNotes: 'A customer-ready proposal.',
    terms: 'Net 30',
    sellerSnapshot: {
      name: 'Lantern IT',
      address: {
        line1: '1 Main Street',
        line2: null,
        city: 'Denver',
        region: 'CO',
        postalCode: '80202',
        country: 'US',
      },
      phone: '555-0100',
      email: 'sales@example.test',
      website: 'https://example.test',
    },
    coverPage: null,
    termsAndConditions: 'Customer-facing terms and conditions.',
  },
  blocks: [],
  lines: [
    {
      id: 'monthly-line', blockId: null, name: 'Monthly service', description: '',
      quantity: '1.00', unitPrice: '75.00', lineTotal: '75.00', recurrence: 'monthly',
      customerVisible: true, sortOrder: 0,
    },
    {
      id: 'annual-line', blockId: null, name: 'Annual service', description: '',
      quantity: '1.00', unitPrice: '25.00', lineTotal: '25.00', recurrence: 'annual',
      customerVisible: true, sortOrder: 1,
    },
  ],
  branding: {
    partnerName: 'Lantern IT',
    logoUrl: null,
    primaryColor: '#123456',
  },
};

describe('PublicQuoteView exact public quote contract', () => {
  it('renders seller, recurring totals, deposit, categories, dates, and terms', () => {
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    const document = screen.getByTestId('public-quote');
    expect(document.textContent).toContain('Lantern IT');
    expect(document.textContent).toContain('sales@example.test');
    expect(document.textContent).toContain('Monthly recurring');
    expect(document.textContent).toContain('$75.00/mo');
    expect(document.textContent).toContain('Annual recurring');
    expect(document.textContent).toContain('$25.00/yr');
    expect(screen.getByTestId('public-quote-deposit-due').textContent).toContain('$97.20');
    expect(screen.getByTestId('public-quote-category-breakdown').textContent).toContain('hardware');
    expect(document.textContent).toContain('Issued');
    expect(document.textContent).toContain('Valid until');
    expect(document.textContent).toContain('Net 30');
    expect(screen.getByTestId('public-quote-terms-conditions').textContent)
      .toContain('Customer-facing terms and conditions.');
  });

  it('stamps data-doc-theme="condensed" when the DTO resolves the condensed theme', () => {
    render(
      <PublicQuoteView
        token="public-token"
        initial={{ ...DETAIL, presentation: { theme: 'condensed', pageSize: 'letter' } }}
      />
    );
    expect(screen.getByTestId('public-quote').getAttribute('data-doc-theme')).toBe('condensed');
  });

  it('defaults data-doc-theme to "classic" when the DTO omits presentation', () => {
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);
    expect(screen.getByTestId('public-quote').getAttribute('data-doc-theme')).toBe('classic');
  });
});

describe('PublicQuoteView decline confirmation', () => {
  // Regression: decline used to fire from window.prompt(), which returns null on
  // Cancel/Escape — coerced to undefined and passed straight to the API, so backing
  // out declined the proposal anyway. Nothing may reach the API but "Yes, decline".
  it('does not decline when the customer backs out with "Keep reviewing"', () => {
    const declineSpy = vi.spyOn(portalApi, 'declinePublicQuote');
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    fireEvent.click(screen.getByTestId('public-quote-decline'));
    expect(screen.getByTestId('public-quote-decline-panel')).toBeTruthy();

    fireEvent.click(screen.getByTestId('public-quote-decline-cancel'));

    expect(declineSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('public-quote-decline-panel')).toBeNull();
    // Back to the normal row, still acceptable.
    expect(screen.getByTestId('public-quote-accept')).toBeTruthy();
  });

  it('declines with the optional reason only once "Yes, decline" is pressed', async () => {
    const declineSpy = vi
      .spyOn(portalApi, 'declinePublicQuote')
      .mockResolvedValue({ data: { data: { status: 'declined' } } });
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    fireEvent.click(screen.getByTestId('public-quote-decline'));
    fireEvent.change(screen.getByTestId('public-quote-decline-reason'), {
      target: { value: 'Went with another vendor' },
    });
    expect(declineSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('public-quote-decline-confirm'));
    await waitFor(() =>
      expect(declineSpy).toHaveBeenCalledWith('public-token', 'Went with another vendor')
    );
  });
});

describe('PublicQuoteView accept validation', () => {
  // The Accept button stays enabled so a click can explain what is missing; a
  // disabled button takes neither focus nor click, so the hint was unreachable.
  it('explains what is missing instead of accepting when the form is incomplete', () => {
    const acceptSpy = vi.spyOn(portalApi, 'acceptPublicQuote');
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    const accept = screen.getByTestId('public-quote-accept');
    expect(accept.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(accept);

    const hint = screen.getByTestId('public-quote-sign-hint');
    expect(hint.getAttribute('role')).toBe('alert');
    expect(hint.textContent).toContain('full name');
    expect(accept.getAttribute('aria-describedby')).toBe('public-quote-sign-hint');
    expect(acceptSpy).not.toHaveBeenCalled();
  });
});
