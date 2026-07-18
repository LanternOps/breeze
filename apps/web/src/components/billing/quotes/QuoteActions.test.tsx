import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// QuoteActions is otherwise exercised only in its 'rail' variant (via QuoteDetail).
// This covers the 'header' variant directly — specifically the empty-quote Send
// guard: the disabled button must point at a per-variant hint id so AT announces
// the reason, and the hint must be visible (not sr-only) in the header.
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../../lib/api/quotes', () => ({ sendQuote: vi.fn(), deleteQuote: vi.fn(), quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf') }));
vi.mock('../../shared/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

function draft(extra: Partial<QuoteDetailData['quote']> = {}): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00', billToName: null, introNotes: null,
      terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
      convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...extra,
    },
    blocks: [],
    lines: [],
  };
}

beforeEach(() => vi.clearAllMocks());

describe('QuoteActions — header variant', () => {
  it('an empty draft disables Send and ties it to a visible, per-variant hint', async () => {
    render(<QuoteActions detail={draft()} onChanged={vi.fn()} variant="header" />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    const send = screen.getByTestId('quote-send');
    expect(send).toBeDisabled();
    // The hint id is variant-scoped so the rail + header copies never collide.
    expect(send).toHaveAttribute('aria-describedby', 'quote-send-empty-hint-header');

    const hint = screen.getByTestId('quote-send-empty-hint');
    expect(hint).toHaveAttribute('id', 'quote-send-empty-hint-header');
    // Visible (not sr-only) so sighted keyboard users see why Send is disabled.
    expect(hint).not.toHaveClass('sr-only');
    expect(hint).toHaveTextContent('Add at least one item before sending.');
  });

  it('a non-empty draft enables Send and drops the hint + describedby', async () => {
    const withLine: QuoteDetailData = {
      ...draft(),
      blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
    };
    render(<QuoteActions detail={withLine} onChanged={vi.fn()} variant="header" />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    const send = screen.getByTestId('quote-send');
    expect(send).not.toBeDisabled();
    expect(send).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByTestId('quote-send-empty-hint')).not.toBeInTheDocument();
  });

  it('savePending holds Send with a visible "Saving changes" hint until quiescent', async () => {
    const withLine: QuoteDetailData = {
      ...draft(),
      blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
    };
    const { rerender } = render(<QuoteActions detail={withLine} onChanged={vi.fn()} variant="header" savePending />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    const send = screen.getByTestId('quote-send');
    expect(send).toBeDisabled();
    // The label stays "Send proposal" while edits settle (a spinner marks the
    // wait) — swapping to "Saving…" resized the button and read as send-in-progress.
    expect(send).toHaveTextContent('Send proposal');
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('aria-describedby', 'quote-send-saving-hint-header');
    const hint = screen.getByTestId('quote-send-saving-hint');
    expect(hint).not.toHaveClass('sr-only');
    expect(hint).toHaveTextContent('Saving changes… Send unlocks when everything is saved.');

    // Saves settle → the money-button unlocks and the hint drops.
    rerender(<QuoteActions detail={withLine} onChanged={vi.fn()} variant="header" savePending={false} />);
    expect(screen.getByTestId('quote-send')).not.toBeDisabled();
    expect(screen.getByTestId('quote-send')).toHaveTextContent('Send proposal');
    expect(screen.queryByTestId('quote-send-saving-hint')).not.toBeInTheDocument();
  });
});
