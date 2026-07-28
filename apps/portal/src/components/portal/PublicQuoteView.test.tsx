// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PublicQuoteDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { PublicQuoteView } from './PublicQuoteView';

afterEach(() => cleanup());

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
  lines: [],
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
});
