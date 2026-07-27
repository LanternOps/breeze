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

describe('InvoiceWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The margin preference persists to localStorage plus an in-memory mirror
    // that survives storage clears — reset both to isolate every test from its
    // neighbours' toggles.
    localStorage.clear();
    _resetShowMarginMemoryForTests();
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
    await waitFor(() => expect(screen.getByTestId('invoice-issue-saving-hint')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-issue'));

    // The save FAILS. The in-flight key clears, so the editor now looks quiet —
    // firing the queue here would number the invoice without the edit.
    rejectPatch(json({ error: 'boom' }, false, 500));

    await waitFor(() => expect(screen.getByTestId('invoice-issue-unsaved-hint')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/issue') && (c[1] as RequestInit)?.method === 'POST')).toBe(false);
  });
});
