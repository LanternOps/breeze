import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import QuoteWorkspace from './QuoteWorkspace';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
// QuoteDocument (Preview tab) reads the org list off orgStore; stub it so the
// real module (which registers an org-id provider at import time) never pulls
// a partially-mocked auth store into scope.
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: { id: string; name: string }[] }) => unknown) =>
    selector({ organizations: [] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// A non-draft quote so the Editor tab (and QuoteEditor's own catalog/distributor
// probes) never mounts — this test only cares about the tab bar's labels.
const sentQuote = {
  quote: {
    id: 'q-1', quoteNumber: 'Q-2026-0001', partnerId: 'p-1', orgId: 'org-1', siteId: null,
    status: 'sent', currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '100.00',
    taxRate: null, taxTotal: '0.00', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', billToName: 'Acme', introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: '2026-06-01T00:00:00Z', viewedAt: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [],
  lines: [],
};

describe('QuoteWorkspace tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/quotes/q-1') return json({ data: sentQuote });
      return json({ data: {} });
    });
  });

  it('labels the third tab "Details" (not the bare, easy-to-misread "Detail")', async () => {
    render(<QuoteWorkspace id="q-1" />);
    await waitFor(() => expect(screen.getByTestId('quote-workspace')).toBeInTheDocument());

    expect(screen.getByTestId('quote-tab-detail')).toHaveTextContent('Details');
    // The Editor tab only renders for drafts (this quote is 'sent') — Preview
    // is always present, confirming the tab bar itself rendered correctly.
    expect(screen.getByTestId('quote-tab-preview')).toHaveTextContent('Preview');
    expect(screen.queryByTestId('quote-tab-editor')).not.toBeInTheDocument();
  });

  // The Editor tab previously had no status cue at all (only Preview/Details
  // showed it) — the workspace header now always carries a status badge next
  // to the title/tabs, reusing the same StatusPill + STATUS_ROLES vocabulary
  // as QuotesPage/QuoteDetail/QuoteDocument.
  it('shows a status badge in the workspace header matching the quote status', async () => {
    render(<QuoteWorkspace id="q-1" />);
    await waitFor(() => expect(screen.getByTestId('quote-workspace')).toBeInTheDocument());

    expect(screen.getByTestId('quote-workspace-status')).toHaveTextContent('Sent');
  });

  it('renders an "Accepted" status badge for a different quote status (proves the badge is status-driven, not hardcoded)', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/quotes/q-1') {
        return json({ data: { ...sentQuote, quote: { ...sentQuote.quote, status: 'accepted', acceptedAt: '2026-06-02T00:00:00Z' } } });
      }
      return json({ data: {} });
    });

    render(<QuoteWorkspace id="q-1" />);
    await waitFor(() => expect(screen.getByTestId('quote-workspace')).toBeInTheDocument());

    expect(screen.getByTestId('quote-workspace-status')).toHaveTextContent('Accepted');
  });
});


describe('QuoteWorkspace — revision banner', () => {
  // A revision draft is indistinguishable from any other draft in the editor,
  // and drafts open on the Editor tab — so the consequence of sending (the
  // original is retired, the customer's existing link dies) would otherwise
  // first appear in the send dialog.
  const revisionDraft = {
    ...sentQuote,
    quote: { ...sentQuote.quote, status: 'draft', revisionOfQuoteId: 'q-0', revisionNumber: 2 },
    revisionOf: { id: 'q-0', quoteNumber: 'Q-2026-0001', recipients: [] as string[] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('warns on a revision draft, naming the quote it will replace', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/quotes/q-1') return json({ data: revisionDraft });
      // A draft mounts the Editor tab, whose catalog/distributor probes call
      // .filter() on data — an object fallback surfaces as an unhandled
      // rejection that Vitest flags as a false-positive risk.
      return json({ data: [] });
    });
    render(<QuoteWorkspace id="q-1" />);

    await waitFor(() => expect(screen.getByTestId('quote-workspace-revision-banner')).toBeInTheDocument());
    expect(screen.getByTestId('quote-workspace-revision-banner')).toHaveTextContent('Q-2026-0001');
  });

  it('does not warn once the revision has been sent — the replacement already happened', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/quotes/q-1') {
        return json({ data: { ...revisionDraft, quote: { ...revisionDraft.quote, status: 'sent' } } });
      }
      return json({ data: [] });
    });
    render(<QuoteWorkspace id="q-1" />);

    await waitFor(() => expect(screen.getByTestId('quote-workspace')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-workspace-revision-banner')).not.toBeInTheDocument();
  });

  it('does not warn on an ordinary draft', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/quotes/q-1') return json({ data: sentQuote });
      return json({ data: {} });
    });
    render(<QuoteWorkspace id="q-1" />);

    await waitFor(() => expect(screen.getByTestId('quote-workspace')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-workspace-revision-banner')).not.toBeInTheDocument();
  });
});


describe('QuoteWorkspace — a mutation whose only signal is "it appears" (#3519)', () => {
  // End-to-end proof of the chain the issue reported: the POST creates the block
  // server-side, the workspace's *quiet* reload then fails, and the editor's
  // canvas therefore never moves. The reload's failure is deliberately silent
  // at this layer (a mid-edit refetch must not remount the form or flash a page
  // error), which used to mean the whole interaction was silent — the reporter
  // re-uploaded four times into ~10 duplicate blocks. `fetchDetail` now answers
  // whether the view actually caught up so the editor can say so.
  const draft = { ...sentQuote, quote: { ...sentQuote.quote, status: 'draft', sentAt: null } };

  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('warns that the section was added when the post-create reload cannot land', async () => {
    let quoteGets = 0;
    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      if (input === '/quotes/q-1/blocks' && init?.method === 'POST') {
        return json({ data: { id: 'blk-new' } });
      }
      if (input === '/quotes/q-1') {
        quoteGets += 1;
        // The initial load succeeds (the editor has to mount at all); every
        // reload after it fails, which is the production state being pinned.
        if (quoteGets === 1) return json({ data: draft });
        return json({ error: 'boom' }, false, 500);
      }
      return json({ data: [] });
    });

    render(<QuoteWorkspace id="q-1" />);
    await waitFor(() => expect(screen.getByTestId('quote-add-block')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-add-block-type-heading'));
    fireEvent.change(screen.getByTestId('quote-block-heading-text'), { target: { value: 'Scope of work' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    // The block really was created...
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/quotes/q-1/blocks',
      expect.objectContaining({ method: 'POST' }),
    ));
    // ...the canvas really is still empty (the reload never landed)...
    expect(screen.getByTestId('quote-blocks-empty')).toBeInTheDocument();
    // ...so the user has to be told, in copy that does not invite a re-submit.
    await waitFor(() => expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Section added') }),
    ));
    expect(vi.mocked(showToast).mock.calls.map((c) => (c[0] as { message: string }).message).join(' | '))
      .not.toMatch(/could not add/i);
  });

  it('stays quiet when the reload lands — the new section appearing is still the signal', async () => {
    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      if (input === '/quotes/q-1/blocks' && init?.method === 'POST') {
        return json({ data: { id: 'blk-new' } });
      }
      if (input === '/quotes/q-1') return json({ data: draft });
      return json({ data: [] });
    });

    render(<QuoteWorkspace id="q-1" />);
    await waitFor(() => expect(screen.getByTestId('quote-add-block')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-add-block-type-heading'));
    fireEvent.change(screen.getByTestId('quote-block-heading-text'), { target: { value: 'Scope of work' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/quotes/q-1/blocks',
      expect.objectContaining({ method: 'POST' }),
    ));
    // Wait for the post-create resync itself (the second GET), so "no toast" is
    // asserted after the code path that would have toasted, not before it.
    await waitFor(() => expect(
      fetchMock.mock.calls.filter(([url]) => url === '/quotes/q-1').length,
    ).toBeGreaterThanOrEqual(2));
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
  });
});


describe('QuoteWorkspace — an older refetch must not clobber a newer one (#3519)', () => {
  // The second stranding vector in the same function. Quiet reloads DO overlap:
  // `runScoped` only serialises calls sharing a key, and the add-block key
  // ('add-block') is not the key a terms blur-save uses ('terms'), so blurring
  // the terms field and then adding a section fires two independent GETs. The
  // editor's `refresh()` throttle fires the first on its leading edge and
  // `resync()` fires the second un-throttled, so both are genuinely in flight.
  // If the OLDER one resolves last, `setDetail` re-renders the canvas from
  // pre-mutation data and the just-created block disappears — the same
  // invisible-block symptom, reached by a different route.
  const draft = { ...sentQuote, quote: { ...sentQuote.quote, status: 'draft', sentAt: null } };
  const newBlock = {
    id: 'blk-new', quoteId: 'q-1', orgId: 'org-1', blockType: 'heading',
    content: { text: 'Scope of work', level: 2 }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('drops a superseded GET that resolves last instead of rolling the canvas back', async () => {
    // Every GET after the initial load is handed out as a deferred promise so
    // the test controls the resolution ORDER independently of the issue order.
    const deferred: { resolve: (r: Response) => void }[] = [];
    let quoteGets = 0;

    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      if (input === '/quotes/q-1/blocks' && init?.method === 'POST') {
        return json({ data: newBlock });
      }
      if (input === '/quotes/q-1') {
        if (init?.method === 'PATCH') return json({ data: draft }); // terms save
        quoteGets += 1;
        if (quoteGets === 1) return json({ data: draft }); // initial mount
        return new Promise<Response>((resolve) => { deferred.push({ resolve }); });
      }
      return json({ data: [] });
    });

    render(<QuoteWorkspace id="q-1" />);
    await waitFor(() => expect(screen.getByTestId('quote-add-block')).toBeInTheDocument());

    // GET #2 — the terms blur-save's refresh() leading edge. Awaited to its own
    // deferred slot BEFORE the add-block interaction starts. Neither GET is
    // issued by the fireEvent that provokes it: #2 comes from an async
    // continuation of the terms PATCH (QuoteEditor.tsx:499, via refresh() ->
    // resync()) and #3 from a continuation of the block POST
    // (QuoteEditor.tsx:1436 -> finishBlockCreate -> resync()). Firing both
    // interactions back-to-back leaves those two continuations unsynchronised,
    // so nothing pins WHICH one lands in deferred[0] — yet every assertion
    // below depends on deferred[0] being the older request and deferred[1] the
    // newer one. Sequencing the provocations pins that order instead of
    // inheriting it from whichever continuation drained first, and gives each
    // chain its own waitFor budget rather than making them share one window.
    fireEvent.change(screen.getByTestId('quote-terms'), { target: { value: 'Net 30' } });
    fireEvent.blur(screen.getByTestId('quote-terms'));
    await waitFor(() => expect(deferred).toHaveLength(1));

    // GET #3 — the add-block resync. #2 is still an unresolved promise here, so
    // the two requests genuinely overlap, exactly as before: this only removes
    // the ambiguity about their order, not the concurrency being tested.
    fireEvent.click(screen.getByTestId('quote-add-block-type-heading'));
    fireEvent.change(screen.getByTestId('quote-block-heading-text'), { target: { value: 'Scope of work' } });
    fireEvent.click(screen.getByTestId('quote-add-block-submit'));
    await waitFor(() => expect(deferred).toHaveLength(2));

    // Neither refetch has answered yet, so the canvas is still pre-mutation.
    // Pinning that here is what stops the "block survives" assertion at the end
    // from passing for the trivial reason that the canvas never moved at all.
    expect(screen.getByTestId('quote-blocks-empty')).toBeInTheDocument();

    // The NEWER request answers first, carrying the block that was just created.
    deferred[1].resolve(json({ data: { ...draft, blocks: [newBlock] } }));
    await waitFor(() => expect(screen.queryByTestId('quote-blocks-empty')).not.toBeInTheDocument());

    // The OLDER request answers second, carrying the pre-mutation canvas. It is
    // superseded, so it must be dropped — not applied on top.
    deferred[0].resolve(json({ data: draft }));

    // Flush the superseded response's continuation before asserting — it has to
    // get all the way to where setDetail WOULD be called, or "nothing changed"
    // would just mean "nothing has happened yet". Each turn covers one await in
    // fetchDetail past the fetch itself (res.json, then the sequence check).
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // The block survives. Without the sequence guard this fails: the stale
    // payload wins by arriving last and the canvas goes empty again. (Verified
    // red against the unguarded fetchDetail, so the flush above is sufficient.)
    expect(screen.queryByTestId('quote-blocks-empty')).not.toBeInTheDocument();
  });
});
