import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData, QuoteBlock, QuoteLine } from './quoteTypes';
import { fetchWithAuth } from '../../../stores/auth';
import { updateLine } from '../../../lib/api/quotes';

vi.mock('../../../stores/auth', () => ({
  // orgStore (imported by QuoteEditor for the customer select) registers an
  // org-id provider against the auth store at module scope.
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: [] }) } as unknown as Response,
  ),
  createCatalogItem: vi.fn(),
  catalogItemImagePath: vi.fn().mockReturnValue('/catalog/img'),
}));
vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(), deleteBlock: vi.fn(), addManualLine: vi.fn(), addCatalogLine: vi.fn(),
  updateLine: vi.fn().mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: {} }) }),
  removeLine: vi.fn(), moveLine: vi.fn(), reorderBlocks: vi.fn(), reorderLines: vi.fn(),
  uploadQuoteImage: vi.fn(), quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
  updateBlock: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const updateLineMock = vi.mocked(updateLine);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function line(extra: Partial<QuoteLine> = {}): QuoteLine {
  return {
    id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
    catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
    name: 'Server', description: null, quantity: '1', unitPrice: '1000.00', taxable: false,
    customerVisible: true, lineTotal: '1000.00', recurrence: 'one_time', termMonths: null,
    billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    depositEligible: false, itemType: 'hardware', ...extra,
  };
}
const block: QuoteBlock = {
  id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {},
  sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

function detail(quoteExtra: Partial<QuoteDetailData['quote']> = {}, lines: QuoteLine[] = [line()]): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '1000.00', taxRate: null,
      taxTotal: '0.00', total: '1000.00', oneTimeTotal: '1000.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '1000.00', depositType: 'none', depositPercent: null,
      billToName: null, introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: null, declinedAt: null, convertedAt: null, convertedInvoiceId: null,
      sentAt: null, viewedAt: null, createdBy: null,
      createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...quoteExtra,
    },
    blocks: [block],
    lines,
  };
}

const depositPatchCalls = () =>
  fetchMock.mock.calls.filter((c) => c[0] === '/quotes/q-1' && (c[1] as RequestInit | undefined)?.method === 'PATCH'
    && String((c[1] as RequestInit).body).includes('deposit'));

describe('QuoteEditor deposit controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => json({ data: {} }));
  });

  it('selecting Percent defers the PATCH until a percent is entered, then blur-saves both fields', async () => {
    render(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-deposit-controls')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('quote-deposit-type'), { target: { value: 'percent' } });
    // No percent yet → no deposit PATCH.
    expect(depositPatchCalls()).toHaveLength(0);

    const input = await screen.findByTestId('deposit-percent-input');
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.blur(input);

    await waitFor(() => expect(depositPatchCalls()).toHaveLength(1));
    const body = JSON.parse(String((depositPatchCalls()[0][1] as RequestInit).body));
    expect(body).toEqual({ depositType: 'percent', depositPercent: 30 });
  });

  it('shows the live Deposit due figure for a configured percent deposit', async () => {
    render(<QuoteEditor detail={detail({ depositType: 'percent', depositPercent: '30.00' })} onChanged={vi.fn()} />);
    const figure = await screen.findByTestId('deposit-due-figure');
    expect(figure).toHaveTextContent('$300.00');
  });

  it('Selected lines mode saves the type and reveals a per-line deposit checkbox that PATCHes the line', async () => {
    render(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-deposit-controls')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('quote-deposit-type'), { target: { value: 'selected_lines' } });
    await waitFor(() => expect(depositPatchCalls()).toHaveLength(1));
    expect(JSON.parse(String((depositPatchCalls()[0][1] as RequestInit).body))).toEqual({ depositType: 'selected_lines' });

    const checkbox = await screen.findByTestId('line-deposit-eligible-l-1');
    fireEvent.click(checkbox);
    await waitFor(() => expect(updateLineMock).toHaveBeenCalledWith('q-1', 'l-1', { depositEligible: true }));
  });

  it('reverts the type select to the persisted value when the deposit PATCH is rejected', async () => {
    // The deposit PATCH 400s (e.g. selecting Selected lines when the deposit would
    // equal the full due-on-acceptance total); every other request still succeeds.
    fetchMock.mockImplementation(async (path, init) => {
      const isDepositPatch = path === '/quotes/q-1'
        && (init as RequestInit | undefined)?.method === 'PATCH'
        && String((init as RequestInit).body).includes('deposit');
      if (isDepositPatch) {
        return json(
          { error: 'Deposit must be less than the amount due on acceptance — remove the deposit instead', code: 'DEPOSIT_NOT_BELOW_TOTAL' },
          false,
          400,
        );
      }
      return json({ data: {} });
    });

    render(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-deposit-controls')).toBeInTheDocument());

    const select = screen.getByTestId('quote-deposit-type') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'selected_lines' } });

    // The optimistic switch fires one PATCH, which is rejected...
    await waitFor(() => expect(depositPatchCalls()).toHaveLength(1));
    // ...so the select snaps back to the persisted 'none' instead of lying as
    // 'selected_lines' — a mode that never saved and would vanish on reload.
    await waitFor(() => expect(select.value).toBe('none'));
  });

  it('renders no deposit controls figure when deposit is none', async () => {
    render(<QuoteEditor detail={detail()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-deposit-controls')).toBeInTheDocument());
    expect(screen.queryByTestId('deposit-due-figure')).not.toBeInTheDocument();
    expect(screen.queryByTestId('line-deposit-eligible-l-1')).not.toBeInTheDocument();
  });
});
