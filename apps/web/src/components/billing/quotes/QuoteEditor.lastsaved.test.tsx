// The quiet "Saving…" / "Saved 2:41 PM" sync indicator near the autosave hint
// (QuoteEditor.tsx). Uses the terms-field PATCH as the mutation under test —
// same runScoped path every other editor mutation goes through.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({
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
}));

vi.mock('../../../lib/api/quotes', () => ({
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  removeLine: vi.fn(),
  moveLine: vi.fn(),
  uploadQuoteImage: vi.fn(),
  quoteImageUrl: vi.fn().mockReturnValue('/quotes/q-1/images/img-1'),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function draftDetail(): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', billToName: null, introNotes: null, terms: null,
      termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: null, declinedAt: null, convertedAt: null, convertedInvoiceId: null,
      sentAt: null, viewedAt: null, createdBy: null,
      createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    blocks: [],
    lines: [],
  };
}

describe('QuoteEditor — last-saved indicator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is absent before any save, shows "Saving…" while the mutation is in flight, then "Saved <time>" once it settles', async () => {
    let resolvePatch!: (v: Response) => void;
    const patchPromise = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input === '/quotes/q-1' && opts?.method === 'PATCH') return patchPromise;
      return json({ data: {} });
    });

    render(<QuoteEditor detail={draftDetail()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-editor')).toBeInTheDocument());

    // Nothing has saved yet this session — the indicator renders nothing at all
    // (never an empty "Saved" line) rather than blocking anything.
    expect(screen.queryByTestId('quote-editor-last-saved')).not.toBeInTheDocument();

    const textarea = screen.getByTestId('quote-terms');
    fireEvent.change(textarea, { target: { value: 'Net 30' } });
    fireEvent.blur(textarea);

    await waitFor(() => expect(screen.getByTestId('quote-editor-last-saved')).toHaveTextContent('Saving'));

    resolvePatch(json({ data: {} }));

    await waitFor(() => expect(screen.getByTestId('quote-editor-last-saved')).toHaveTextContent(/Saved/));
    expect(screen.getByTestId('quote-editor-last-saved')).not.toHaveTextContent('Saving');
  });
});
