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

function converted(overrides: {
  acceptanceOrigin: 'customer' | 'on_behalf' | null;
  acceptedAt?: string | null;
  /** The branding block is optional on QuoteDetail (an older API response, or
   *  a portal with no branding row), which is how partnerName goes missing. */
  omitBranding?: boolean;
}): QuoteDetail {
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
      acceptedAt: overrides.acceptedAt === undefined ? '2026-07-15T10:00:00.000Z' : overrides.acceptedAt,
      acceptanceOrigin: overrides.acceptanceOrigin,
    },
    blocks: [],
    lines: [],
    branding: overrides.omitBranding ? undefined : {
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

  it('names the partner and the date when both are present', () => {
    render(<QuoteDetailView detail={converted({ acceptanceOrigin: 'on_behalf' })} />);
    expect(screen.getByTestId('quote-accepted-on-behalf').textContent)
      .toMatch(/Accepted on your behalf by Lantern IT on .+\.$/);
  });

  // Both values are nullable in the serializer. Rendering them raw printed
  // "Accepted on your behalf by  on ." — a blank that reads as a broken record
  // on the one screen whose whole job is to be credible to the customer.
  it('falls back to "your provider" and drops the date when both are missing', () => {
    render(<QuoteDetailView detail={converted({
      acceptanceOrigin: 'on_behalf', acceptedAt: null, omitBranding: true,
    })} />);
    const text = screen.getByTestId('quote-accepted-on-behalf').textContent ?? '';
    expect(text).toBe('Accepted on your behalf by your provider.');
    expect(text).not.toMatch(/\bon\s*\.|by\s{2,}/);
  });

  // The method and reference are the MSP's internal evidence trail — the portal
  // serializer never sends them, and this asserts the view never invents them.
  it('never renders a method or a reference', () => {
    const { container } = render(<QuoteDetailView detail={converted({ acceptanceOrigin: 'on_behalf' })} />);
    expect(container.textContent).not.toMatch(/purchase order|PO \d/i);
  });
});
