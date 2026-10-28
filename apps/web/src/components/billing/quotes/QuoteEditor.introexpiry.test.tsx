// "Valid until" (quotes.expiry_date) and intro notes (quotes.intro_notes) print
// on the proposal the customer reads, so the draft editor must be able to set
// them (#9859). Both blur-save through PATCH /quotes/:id like the other header
// fields.
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
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

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

function draftDetail(extra: Partial<QuoteDetailData['quote']> = {}): QuoteDetailData {
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
      ...extra,
    },
    blocks: [],
    lines: [],
  };
}

const patchBodies = () => fetchMock.mock.calls
  .filter((c) => c[0] === '/quotes/q-1' && (c[1] as RequestInit)?.method === 'PATCH')
  .map((c) => JSON.parse((c[1] as RequestInit).body as string));

describe('QuoteEditor — Valid until + intro notes (#9859)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => json({ data: {} }));
  });

  it('pre-fills both fields from the quote', () => {
    render(<QuoteEditor detail={draftDetail({ expiryDate: '2099-12-31', introNotes: 'Thanks for the call.' })} onChanged={vi.fn()} />);
    expect((screen.getByTestId('quote-expiry-date') as HTMLInputElement).value).toBe('2099-12-31');
    expect((screen.getByTestId('quote-intro-notes') as HTMLTextAreaElement).value).toBe('Thanks for the call.');
    expect(screen.getByLabelText('Valid until')).toBe(screen.getByTestId('quote-expiry-date'));
    expect(screen.getByLabelText('Intro notes')).toBe(screen.getByTestId('quote-intro-notes'));
  });

  it('picking a date and blurring PATCHes { expiryDate } only', async () => {
    render(<QuoteEditor detail={draftDetail()} onChanged={vi.fn()} />);
    const input = screen.getByTestId('quote-expiry-date');
    fireEvent.change(input, { target: { value: '2099-11-30' } });
    fireEvent.blur(input);
    await waitFor(() => expect(patchBodies()).toEqual([{ expiryDate: '2099-11-30' }]));
    await waitFor(() => expect(screen.getByTestId('quote-expiry-date-saved')).toHaveTextContent('Saved'));
  });

  it('clearing the date sends expiryDate: null (no expiry)', async () => {
    render(<QuoteEditor detail={draftDetail({ expiryDate: '2099-12-31' })} onChanged={vi.fn()} />);
    const input = screen.getByTestId('quote-expiry-date');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(patchBodies()).toEqual([{ expiryDate: null }]));
  });

  it('blurring an unchanged field sends nothing', async () => {
    render(<QuoteEditor detail={draftDetail({ expiryDate: '2099-12-31', introNotes: 'Hi' })} onChanged={vi.fn()} />);
    fireEvent.blur(screen.getByTestId('quote-expiry-date'));
    fireEvent.blur(screen.getByTestId('quote-intro-notes'));
    await new Promise((r) => setTimeout(r, 20));
    expect(patchBodies()).toEqual([]);
  });

  it('warns when the date has already passed', () => {
    render(<QuoteEditor detail={draftDetail()} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('quote-expiry-date-past')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('quote-expiry-date'), { target: { value: '2000-01-01' } });
    expect(screen.getByTestId('quote-expiry-date-past')).toBeInTheDocument();
  });

  it('editing intro notes and blurring PATCHes { introNotes } only', async () => {
    render(<QuoteEditor detail={draftDetail()} onChanged={vi.fn()} />);
    const textarea = screen.getByTestId('quote-intro-notes');
    fireEvent.change(textarea, { target: { value: 'Here is the plan we discussed.\nSee below.' } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(patchBodies()).toEqual([{ introNotes: 'Here is the plan we discussed.\nSee below.' }]));
    await waitFor(() => expect(screen.getByTestId('quote-intro-notes-saved')).toHaveTextContent('Saved'));
  });

  it('blanking intro notes sends introNotes: null so nothing prints', async () => {
    render(<QuoteEditor detail={draftDetail({ introNotes: 'Old intro' })} onChanged={vi.fn()} />);
    const textarea = screen.getByTestId('quote-intro-notes');
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(patchBodies()).toEqual([{ introNotes: null }]));
  });

  it('caps intro notes at the API limit (5000)', () => {
    render(<QuoteEditor detail={draftDetail()} onChanged={vi.fn()} />);
    expect(screen.getByTestId('quote-intro-notes')).toHaveAttribute('maxlength', '5000');
  });

  it('a failed save keeps the draft, toasts, and names the field to the Send gate', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'boom' }, false, 500));
    const onUnsavedEditsChange = vi.fn();
    render(<QuoteEditor detail={draftDetail()} onChanged={vi.fn()} onUnsavedEditsChange={onUnsavedEditsChange} />);
    const textarea = screen.getByTestId('quote-intro-notes') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Draft intro' } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(textarea.value).toBe('Draft intro');
    await waitFor(() => expect(onUnsavedEditsChange).toHaveBeenLastCalledWith('Intro notes'));
  });
});
