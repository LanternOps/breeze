import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import { type QuoteDetail as QuoteDetailData, type QuoteBlock } from './quoteTypes';
import { useOrgStore } from '../../../stores/orgStore';

// The Detail tab's BlockView only special-cased heading/rich_text/image and
// fell through to the line-items table for everything else — so a `contract`
// (agreement), `table`, or `callout` block rendered as an empty "PRICING /
// No lines in this table." pricing table instead of its own content.
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [{ resource: 'quotes', action: 'read' }] as Perm[] }));

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const ORG_ID = 'aa0e43c8-1111-2222-3333-444455556666';

function detailWith(blocks: QuoteBlock[]): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: ORG_ID, siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00',
      billToName: 'Acme Inc.', introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: null, declinedAt: null, convertedAt: null, convertedInvoiceId: null, sentAt: null,
      viewedAt: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    blocks,
    lines: [],
  };
}

const initialOrgState = useOrgStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'quotes', action: 'read' }];
  useOrgStore.setState({ organizations: [] });
});

afterEach(() => {
  useOrgStore.setState(initialOrgState, true);
});

describe('QuoteDetail — contract/table/callout blocks', () => {
  it('renders a contract block by its template name instead of an empty pricing table', async () => {
    const block: QuoteBlock = {
      id: 'blk-c', quoteId: 'q-1', orgId: ORG_ID, blockType: 'contract',
      content: {
        templateName: 'Master Service Agreement', versionNumber: 3, sourceType: 'authored',
        renderedHtml: '<p>Term begins on signing.</p>', fileUrl: null,
      },
      sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    };
    render(<QuoteDetail detail={detailWith([block])} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail-block-blk-c')).toBeInTheDocument());

    const rendered = screen.getByTestId('quote-detail-block-blk-c');
    expect(rendered).toHaveTextContent('Master Service Agreement');
    expect(rendered).toHaveTextContent('Term begins on signing.');
    expect(screen.queryByText(/No lines in this table/i)).not.toBeInTheDocument();
  });

  it('renders a table block as its own rows instead of the pricing table', async () => {
    const block: QuoteBlock = {
      id: 'blk-t', quoteId: 'q-1', orgId: ORG_ID, blockType: 'table',
      content: {
        columns: [{ label: 'Item' }, { label: 'Notes' }],
        rows: [{ cells: ['Router', 'Optional'] }],
      },
      sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    };
    render(<QuoteDetail detail={detailWith([block])} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail-block-blk-t')).toBeInTheDocument());

    const rendered = screen.getByTestId('quote-detail-block-blk-t');
    expect(rendered).toHaveTextContent('Item');
    expect(rendered).toHaveTextContent('Router');
    expect(screen.queryByText(/No lines in this table/i)).not.toBeInTheDocument();
  });

  it('renders a callout block as its own text instead of the pricing table', async () => {
    const block: QuoteBlock = {
      id: 'blk-o', quoteId: 'q-1', orgId: ORG_ID, blockType: 'callout',
      content: { variant: 'warn', title: 'Heads up', html: '<p>Read carefully</p>' },
      sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    };
    render(<QuoteDetail detail={detailWith([block])} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail-block-blk-o')).toBeInTheDocument());

    const rendered = screen.getByTestId('quote-detail-block-blk-o');
    expect(rendered).toHaveTextContent('Heads up');
    expect(rendered).toHaveTextContent('Read carefully');
    expect(screen.queryByText(/No lines in this table/i)).not.toBeInTheDocument();
  });
});
