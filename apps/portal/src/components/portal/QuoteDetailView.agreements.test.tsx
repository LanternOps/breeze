// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { QuoteDetail } from '@/lib/api';
import { QuoteDetailView } from './QuoteDetailView';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The signed-in portal view shares the public link's layout: agreements sit
// after the totals and the sign panel, collapsed (#7040).
const DETAIL: QuoteDetail = {
  quote: {
    id: '22222222-2222-4222-8222-222222222222',
    quoteNumber: 'Q-2026-0100',
    title: 'Managed Services',
    status: 'sent',
    currencyCode: 'USD',
    issueDate: '2026-07-01',
    expiryDate: '2026-08-01',
    subtotal: '300.00',
    total: '300.00',
    oneTimeTotal: '300.00',
    dueOnAcceptanceTotal: '300.00',
    depositType: 'percent',
    depositAmount: '90.00',
    depositDueTotal: '90.00',
    termsAndConditions: '1. Payment\nNet 30.',
  },
  blocks: [
    {
      id: 'blk-msa',
      blockType: 'contract',
      sortOrder: 0,
      content: {
        label: 'Managed Services Agreement',
        templateName: 'MSA',
        versionNumber: 3,
        sourceType: 'authored',
        renderedHtml: '<p>The customer agrees.</p>',
        fileUrl: null,
      },
    },
  ],
  lines: [
    {
      id: 'line-1', blockId: null, name: 'Setup', description: '',
      quantity: '1.00', unitPrice: '300.00', lineTotal: '300.00', recurrence: 'one_time',
      customerVisible: true, sortOrder: 0,
    },
  ],
  branding: { partnerName: 'Lantern IT', logoUrl: null, primaryColor: '#123456' },
} as QuoteDetail;

describe('portal quote detail — agreements after the price', () => {
  it('renders the agreement collapsed, after the totals and the sign panel, before the T&C', () => {
    render(<QuoteDetailView detail={DETAIL} />);
    const contract = screen.getByTestId('contract-block') as HTMLDetailsElement;
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(contract.open).toBe(false);
    expect(follows(screen.getByTestId('quote-due-on-acceptance'), contract)).toBe(true);
    expect(follows(screen.getByTestId('quote-agree'), contract)).toBe(true);
    expect(follows(contract, screen.getByTestId('quote-terms-conditions'))).toBe(true);
    expect(screen.getByTestId('quote-agreements').contains(contract)).toBe(true);
  });

  it('links the agreement and the T&C from the signature checkbox', () => {
    render(<QuoteDetailView detail={DETAIL} />);
    const hrefs = [...screen.getByTestId('quote-agree').closest('label')!.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#agreement-blk-msa', '#terms']);
  });
});
