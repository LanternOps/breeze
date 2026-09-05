import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceWorkspace from './InvoiceWorkspace';
import { _resetShowMarginMemoryForTests } from './billingUi';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // usePermissions() reads grants off the store; grant the admin wildcard so the
  // Issue controls render and the full flow is exercised.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
// The Preview tab's InvoiceDocument reads the org list off orgStore; stub it so
// the real module (which registers an org-id provider on the auth store at import
// time) is never pulled into this partially-mocked auth setup.
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: { id: string; name: string }[] }) => unknown) =>
    selector({ organizations: [] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const line = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  description: 'Consulting', quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
  taxable: false, customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1,
};

function invoice(over: Record<string, unknown>) {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '100.00', taxRate: null,
      taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00', billToName: 'Acme',
      notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z', ...over,
    },
    lines: [line],
    stripeConnected: false,
  };
}

// #3277 — this file ran on a raised Testing Library `asyncUtilTimeout` (5000ms,
// added by #3284) inside a raised per-test ceiling (15000ms, added by #3956).
// Both are gone, and deliberately so: the diagnosis they were built on was wrong.
//
// The theory was that the queued-Issue tests assert the end of a multi-hop
// propagation chain (PATCH settles → editor reports → workspace clears
// `savePending` → header un-gates → queued Issue fires) and that under CI load
// the chain simply outran the 1000ms default. It does not. The chain never
// STARTED: a deferred prop-sync `useEffect` in InvoiceEditor flushed after the
// `fireEvent.change` it never saw, restored the pre-edit notes value and cleared
// `notesDirty`, so the following blur short-circuited and dispatched no PATCH at
// all. `savePending` never went true, so `invoice-issue-saving-hint` could never
// render — no timeout is large enough for a condition that never becomes true,
// which is why enlarging the budget twice — #3284 raised the `waitFor` timeout,
// #3956 added the per-test ceiling above it — never held, and the flake came
// back as #3980 and #4033.
//
// With the race removed at source the hint is present SYNCHRONOUSLY inside the
// blur's own act() flush, for a reason you can check by reading the code rather
// than trusting this comment: `runScoped` marks the key pending BEFORE it awaits
// the request, and `fetchWithAuth` is a bare `vi.fn()` here, so nothing suspends
// before the commit. (That is also what a 200-iteration loaded-CPU harness
// measured while the fix was being developed; the counts are recorded in PR
// #4294 rather than asserted here, since the harness was not committed.)
// The default budget is therefore not merely sufficient, it is unused, and
// keeping the inflation would only buy a slower, less legible failure for every
// genuine future breakage in this file.
describe('InvoiceWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The margin preference persists to localStorage plus an in-memory mirror
    // that survives storage clears — reset both to isolate every test from its
    // neighbours' toggles.
    localStorage.clear();
    _resetShowMarginMemoryForTests();
    // jsdom's `window` persists across tests in this file — reset the hash so
    // one test's tab/devices state can't leak into the next's default-tab
    // assertions.
    window.location.hash = '';
  });

  it('renders a draft as the editor with a "Draft invoice" header', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1') return json({ data: invoice({}) });
      return json({ data: {} });
    });
    render(<InvoiceWorkspace id="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-workspace-title')).toHaveTextContent('Draft invoice'));
    expect(screen.getByTestId('invoice-editor')).toBeInTheDocument();
  });

  it('surfaces an error card when the invoice fails to load', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/invoices/inv-1') return json(null, false, 500);
      return json({ data: {} });
    });
    render(<InvoiceWorkspace id="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-workspace-error')).toBeInTheDocument());
  });

  // #1418: issuing a draft must flip the header from "Draft invoice" to the
  // assigned invoice number in place — no manual reload. The editor refetches
  // via onChanged() after the mutation; this guards that wiring end-to-end.
  it('updates the header from "Draft invoice" to the invoice number after Issue, without a reload', async () => {
    let issued = false;
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') {
        issued = true;
        return json({ data: { id: 'inv-1', status: 'sent', invoiceNumber: 'INV-2026-0002' } });
      }
      if (input === '/invoices/inv-1/payments') return json({ data: [] });
      if (input === '/invoices/inv-1') {
        return json({ data: issued
          ? invoice({ status: 'sent', invoiceNumber: 'INV-2026-0002', sentAt: '2026-06-17T00:00:00Z', issueDate: '2026-06-17', dueDate: '2026-07-17' })
          : invoice({}) });
      }
      return json({ data: {} });
    });

    render(<InvoiceWorkspace id="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-workspace-title')).toHaveTextContent('Draft invoice'));

    fireEvent.click(screen.getByTestId('invoice-issue'));

    await waitFor(() => expect(screen.getByTestId('invoice-workspace-title')).toHaveTextContent('INV-2026-0002'));
    // The draft editor is gone once issued — the read-only detail takes over.
    expect(screen.queryByTestId('invoice-editor')).not.toBeInTheDocument();
  });

  it('keeps the draft editor MOUNTED (hidden, not unmounted) while another tab is active', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1') return json({ data: invoice({}) });
      return json({ data: {} });
    });
    render(<InvoiceWorkspace id="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    // Half-typed editor state (an add-line name) that unmounting would discard.
    fireEvent.click(screen.getByTestId('invoice-add-mode-manual'));
    fireEvent.change(screen.getByTestId('invoice-manual-name'), { target: { value: 'Half-typed line' } });

    fireEvent.click(screen.getByTestId('invoice-tab-preview'));
    // The editor is still in the DOM (hidden via CSS), so its local state — and
    // the savePending gate — survive a "just checking the preview" round-trip.
    expect(screen.getByTestId('invoice-editor')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('invoice-tab-editor'));
    expect(screen.getByTestId('invoice-manual-name')).toHaveValue('Half-typed line');
  });

  it('offers the cost/margin toggle in the pinned header on the Editor tab, gating the margin panel', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1') return json({ data: invoice({}) });
      return json({ data: {} });
    });
    render(<InvoiceWorkspace id="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    // Default is "no margin on screen": panel hidden, header toggle available.
    expect(screen.queryByTestId('invoice-margin')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('invoice-editor-toggle-internal'));
    expect(screen.getByTestId('invoice-margin')).toBeInTheDocument();
    // Persists under the billing-wide key shared with the quote surfaces.
    expect(localStorage.getItem('breeze:quote-editor-show-margin')).toBe('1');

    fireEvent.click(screen.getByTestId('invoice-editor-toggle-internal'));
    expect(screen.queryByTestId('invoice-margin')).not.toBeInTheDocument();
  });

  // End-to-end quiescence wiring: the editor's dirty state must reach the
  // header's Issue gate THROUGH the workspace (savePending / onPendingEditsChange
  // / the queue). Both endpoints are unit-tested; this pins the plumbing —
  // deleting any of the threaded props should fail here.
  it('holds a header Issue click while the editor is dirty, then fires it when the save settles', async () => {
    let resolvePatch!: (v: Response) => void;
    const patchPromise = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1' && opts?.method === 'PATCH') return patchPromise;
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') return json({ data: { id: 'inv-1', status: 'sent' } });
      if (input === '/invoices/inv-1/payments') return json({ data: [] });
      if (input === '/invoices/inv-1') return json({ data: invoice({}) });
      return json({ data: {} });
    });
    render(<InvoiceWorkspace id="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    // Edit + blur → the PATCH is genuinely in flight → the header shows the
    // saving hint. (Typing alone is not "saving": nothing has been sent yet.)
    fireEvent.change(screen.getByTestId('invoice-notes'), { target: { value: 'Edited' } });
    fireEvent.blur(screen.getByTestId('invoice-notes'));
    // Assert the two PRECONDITIONS the rest of this test rests on, before the
    // wait that depends on them (#3277). Both are synchronous, so a regression
    // reports "the edit was discarded" or "no PATCH was sent" by name and
    // instantly, instead of exhausting a `waitFor` on a hint that could never
    // have rendered — which is the failure mode that took five issues to read.
    expect(screen.getByTestId('invoice-notes')).toHaveValue('Edited');
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'PATCH')).toBe(true);
    await waitFor(() => expect(screen.getByTestId('invoice-issue-saving-hint')).toBeInTheDocument());

    // Clicking Issue queues (nothing fires while the save is pending)…
    fireEvent.click(screen.getByTestId('invoice-issue'));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/issue'))).toBe(false);

    // …the save lands → quiescence → the queued Issue fires.
    resolvePatch(json({ data: {} }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/issue') && (c[1] as RequestInit)?.method === 'POST')).toBe(true),
    );
  });

  it('does NOT fire a queued Issue when the pending save fails — the whole point of the failure nonce', async () => {
    // Both halves of this are unit-tested in isolation and never meet there:
    // the editor proves it reports a failure, InvoiceActions proves it cancels
    // on one. This is the wiring. Deleting `saveFailureNonce` from the
    // InvoiceActions element below must fail HERE, or the prop is unguarded.
    let rejectPatch!: (v: Response) => void;
    const patchPromise = new Promise<Response>((resolve) => { rejectPatch = resolve; });
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1' && opts?.method === 'PATCH') return patchPromise;
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') return json({ data: { id: 'inv-1', status: 'sent' } });
      if (input === '/invoices/inv-1/payments') return json({ data: [] });
      if (input === '/invoices/inv-1') return json({ data: invoice({}) });
      return json({ data: {} });
    });
    render(<InvoiceWorkspace id="inv-1" />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('invoice-notes'), { target: { value: 'Edited' } });
    fireEvent.blur(screen.getByTestId('invoice-notes'));
    // Same two preconditions as the sibling case above — see #3277.
    expect(screen.getByTestId('invoice-notes')).toHaveValue('Edited');
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'PATCH')).toBe(true);
    await waitFor(() => expect(screen.getByTestId('invoice-issue-saving-hint')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-issue'));

    // The save FAILS. The in-flight key clears, so the editor now looks quiet —
    // firing the queue here would number the invoice without the edit.
    rejectPatch(json({ error: 'boom' }, false, 500));

    await waitFor(() => expect(screen.getByTestId('invoice-issue-unsaved-hint')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/issue') && (c[1] as RequestInit)?.method === 'POST')).toBe(false);
  });

  // Regression: InvoiceLineDevices composes its open-state into the hash as an
  // `&`-joined `devices=` segment alongside whatever tab segment is already
  // there (`#detail&devices=line-1`) — it never replaces the whole hash. The
  // old `readTab` exact-matched the ENTIRE hash against a tab value, so a
  // composed hash matched nothing and fell through to the draft default
  // (`editor`), snapping a draft invoice back to the Editor tab and hiding the
  // device appendix the click was meant to open. `readTab` must parse only the
  // first `&`-segment as the tab.
  it('honors a composed #detail&devices=… hash on a draft invoice instead of snapping back to Editor', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/payments') return json({ data: [] });
      if (input.startsWith('/invoices/inv-1/lines/line-1/devices')) {
        return json({ data: { recorded: true, total: 0, devices: [], nextCursor: null } });
      }
      if (input === '/invoices/inv-1') return json({ data: invoice({}) });
      return json({ data: {} });
    });
    window.location.hash = '#detail&devices=line-1';
    render(<InvoiceWorkspace id="inv-1" />);

    await waitFor(() => expect(screen.getByTestId('invoice-tab-detail')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByTestId('invoice-tab-editor')).toHaveAttribute('aria-selected', 'false');
  });
});
