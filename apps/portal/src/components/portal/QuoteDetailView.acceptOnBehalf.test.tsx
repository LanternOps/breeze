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

function converted(overrides: { acceptanceOrigin: 'customer' | 'on_behalf' | null }): QuoteDetail {
  return {
    quote: {
      id: '22222222-2222-4222-8222-222222222222',
      quoteNumber: 'Q-2026-0099',
      title: 'Managed Services',
      status: 'converted',
      currencyCode: 'USD',
      issueDate: '2026-07-01',
      expiryDate: '2026-08-01',
      total: '432.00',
      acceptedAt: '2026-07-15T10:00:00.000Z',
      acceptanceOrigin: overrides.acceptanceOrigin,
    },
    blocks: [],
    lines: [],
    branding: {
      partnerName: 'Lantern IT',
      logoUrl: null,
      primaryColor: '#123456',
    },
  };
}

describe('portal on-behalf notice', () => {
  it('tells the customer their provider recorded the acceptance', () => {
    render(<QuoteDetailView detail={converted({ acceptanceOrigin: 'on_behalf' })} />);
    expect(screen.getByTestId('quote-accepted-on-behalf').textContent).toContain('on your behalf');
  });

  it('shows nothing extra when the customer accepted it themselves', () => {
    render(<QuoteDetailView detail={converted({ acceptanceOrigin: 'customer' })} />);
    expect(screen.queryByTestId('quote-accepted-on-behalf')).toBeNull();
  });

  // The method and reference are the MSP's internal evidence trail — the portal
  // serializer never sends them, and this asserts the view never invents them.
  it('never renders a method or a reference', () => {
    const { container } = render(<QuoteDetailView detail={converted({ acceptanceOrigin: 'on_behalf' })} />);
    expect(container.textContent).not.toMatch(/purchase order|PO \d/i);
  });
});
