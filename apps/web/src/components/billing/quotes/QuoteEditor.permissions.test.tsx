import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from, so each test can vary the
// quote permissions the editor sees. This file covers the NEGATIVE gating
// branches that QuotesPage.test.tsx (which grants the `*:*` wildcard) never
// exercises: a read-only viewer must NOT see any of the write controls (add
// block, remove block, remove line, the per-table add-line builder), while a
// writer must. Send is irrelevant to the editor — its controls all gate on
// quotes:write.
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

// The editor loads the catalog on mount; stub it so the test never hits network.
// (vi.mock factories are hoisted, so the Response literal is inlined rather than
// referencing a module-level helper.)
vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
}));

const block: QuoteDetailData['blocks'][number] = {
  id: 'blk-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items',
  content: { label: 'Monthly services' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const line: QuoteDetailData['lines'][number] = {
  id: 'line-1', quoteId: 'q-1', blockId: 'blk-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, description: 'Managed support', quantity: '1.00',
  unitPrice: '50.00', taxable: false, customerVisible: true, lineTotal: '50.00',
  recurrence: 'monthly', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

// A draft quote with one pricing-table block + one line, so every write control
// (add block, remove block, add-line builder, remove line) is *otherwise*
// renderable — only the permission gate keeps them hidden.
const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '50.00', taxRate: null,
    taxTotal: '0.00', total: '50.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '50.00',
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null, acceptedAt: null,
    declinedAt: null, convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [block],
  lines: [line],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [];
});

describe('QuoteEditor — permission gating', () => {
  it('read-only (quotes:read) hides the add-block form, block remove, add-line builder and line remove', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }];
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // Read-only sees the rendered content (positive control: the block + line are present)…
    expect(screen.getByTestId('quote-block-blk-1')).toBeInTheDocument();
    expect(screen.getByTestId('quote-line-line-1')).toBeInTheDocument();
    expect(screen.getByTestId('quote-live-totals')).toBeInTheDocument();

    // …but none of the write controls.
    expect(screen.queryByTestId('quote-add-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-add-block-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-remove-blk-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-add-line-blk-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-line-remove-line-1')).not.toBeInTheDocument();
  });

  it('quotes:write reveals the add-block form, block remove, add-line builder and line remove', async () => {
    state.permissions = [{ resource: 'quotes', action: 'write' }];
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    expect(screen.getByTestId('quote-add-block')).toBeInTheDocument();
    expect(screen.getByTestId('quote-add-block-submit')).toBeInTheDocument();
    expect(screen.getByTestId('quote-block-remove-blk-1')).toBeInTheDocument();
    expect(screen.getByTestId('quote-block-add-line-blk-1')).toBeInTheDocument();
    expect(screen.getByTestId('quote-line-remove-line-1')).toBeInTheDocument();
  });
});
