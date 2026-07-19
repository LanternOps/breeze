import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  // orgStore (imported by QuoteEditor for the customer select) registers an
  // org-id provider against the auth store at module scope.
  registerOrgIdProvider: vi.fn(),
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
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: null, description: 'Managed support', quantity: '1.00',
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
    annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null,
    declinedAt: null, convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [block],
  lines: [line],
};

beforeEach(() => {
  vi.clearAllMocks();
  // The cost/margin toggle persists to localStorage — clear it so every test
  // starts from the collapsed default regardless of what a prior test toggled.
  localStorage.clear();
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
    expect(screen.queryByTestId('quote-block-actions-blk-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-block-add-line-toggle-blk-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-ghost-row-blk-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-line-actions-line-1')).not.toBeInTheDocument();
  });

  it('quotes:write reveals the add-block form, block remove, add-line builder and line remove', async () => {
    state.permissions = [{ resource: 'quotes', action: 'write' }];
    render(<QuoteEditor detail={detail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    expect(screen.getByTestId('quote-add-block')).toBeInTheDocument();
    expect(screen.getByTestId('quote-add-block-submit')).toBeInTheDocument();
    // Section arrangement (incl. Remove) lives behind the block's gutter menu.
    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1'));
    expect(screen.getByTestId('quote-block-remove-blk-1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quote-block-actions-blk-1')); // close
    // The ghost row is the always-ready manual entry; the full picker discloses.
    expect(screen.getByTestId('quote-ghost-row-blk-1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-blk-1'));
    expect(screen.getByTestId('quote-block-add-line-blk-1')).toBeInTheDocument();
    // Row actions (incl. Remove) live behind the line's overflow menu.
    fireEvent.click(screen.getByTestId('quote-line-actions-line-1'));
    expect(screen.getByTestId('quote-line-remove-line-1')).toBeInTheDocument();
  });

  // Cost/margin is a read affordance: read-only users get the collapse toggle, the
  // per-line internal band, and the rail Margin panel — the same cost surfaces a
  // writer sees. Regression guard for the toggle accidentally being re-gated on
  // write (which would silently hide all cost from readers).
  it('read-only user gets the cost & margin toggle, the rail margin panel, and can expand the per-line band', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }];
    const costed: QuoteDetailData = { ...detail, lines: [{ ...line, unitCost: '30.00' }] };
    render(<QuoteEditor detail={costed} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // The toggle is offered to readers (unlike the write-only autosave hint).
    const toggle = screen.getByTestId('quote-editor-toggle-internal');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // ALL margin surfaces start hidden — the rail panel is governed by the same
    // toggle as the per-line bands, so "off" honestly means no margin on screen.
    expect(screen.queryByTestId('quote-margin-cost')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-line-internal-line-1')).toHaveClass('hidden');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // Rail margin panel is visible to readers once toggled (gated on quotes:read,
    // not write) alongside the expanded per-line band.
    expect(screen.getByTestId('quote-margin-cost')).toHaveTextContent('$30.00');
    expect(screen.getByTestId('quote-line-internal-line-1')).not.toHaveClass('hidden');
    expect(screen.getByTestId('quote-line-cost-line-1')).toHaveTextContent('$30.00');
    // A non-taxable line renders no tax sub-line under its Total.
    expect(screen.getByTestId('quote-line-tax-line-1')).toBeEmptyDOMElement();
  });

  // Tax state lives in the Total cell's sub-line (the dedicated Taxable/Tax
  // columns were folded away): a taxable line with no rate set still announces
  // "Taxable" so read-only users can tell the states apart.
  it('read-only taxable line announces its taxable state under the Total', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }];
    const taxed: QuoteDetailData = { ...detail, lines: [{ ...line, taxable: true }] };
    render(<QuoteEditor detail={taxed} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());
    expect(screen.getByTestId('quote-line-tax-line-1')).toHaveTextContent('Taxable');
  });
});
