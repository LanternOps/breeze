// Save-quiescence gating on the Issue buttons (the quote editor's Send
// contract, normalized onto invoices): while the editor reports pending edits,
// an Issue click is never dead — it queues and fires the moment the editor goes
// quiescent, with a visible hint explaining the hold.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceActions from './InvoiceActions';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToastMock(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const visibleLine: InvoiceDetail['lines'][number] = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  name: null, description: 'Consulting', quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
  taxable: false, customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1,
};

function detail(): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '100.00', taxRate: null,
      taxTotal: '0.00', total: '100.00', amountPaid: '0.00', balance: '100.00', billToName: 'Acme',
      notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
    },
    lines: [visibleLine],
  };
}

const issuePosted = () =>
  fetchMock.mock.calls.some((c) => String(c[0]) === '/invoices/inv-1/issue' && (c[1] as RequestInit)?.method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async () => json({ data: {} }));
});

describe('InvoiceActions — savePending gating', () => {
  it('shows the saving hint and holds an Issue click until quiescence, then fires it', async () => {
    const { rerender } = render(<InvoiceActions detail={detail()} variant="header" savePending />);

    // Visible reason for the hold (both a hint paragraph and the button title).
    expect(screen.getByTestId('invoice-issue-saving-hint')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-issue')).toHaveAttribute(
      'aria-describedby', 'invoice-issue-held-hint-header',
    );

    // Clicking Issue while saving queues it — nothing fires yet.
    fireEvent.click(screen.getByTestId('invoice-issue'));
    expect(issuePosted()).toBe(false);

    // The editor goes quiescent → the queued Issue fires without a second click.
    rerender(<InvoiceActions detail={detail()} variant="header" savePending={false} />);
    await waitFor(() => expect(issuePosted()).toBe(true));
  });

  it('holds an Issue & Send click until quiescence, then opens the confirm dialog (never auto-sends)', async () => {
    const { rerender } = render(<InvoiceActions detail={detail()} variant="header" savePending />);

    fireEvent.click(screen.getByTestId('invoice-issue-send'));
    expect(screen.queryByTestId('invoice-issue-send-confirm')).not.toBeInTheDocument();
    expect(issuePosted()).toBe(false);

    rerender(<InvoiceActions detail={detail()} variant="header" savePending={false} />);
    // Quiescence opens the CONFIRM dialog — the email still needs an explicit yes.
    await waitFor(() => expect(screen.getByTestId('invoice-issue-send-confirm')).toBeInTheDocument());
    expect(issuePosted()).toBe(false);
  });

  it('renders no saving hint and issues immediately when savePending is false', async () => {
    render(<InvoiceActions detail={detail()} variant="header" />);
    expect(screen.queryByTestId('invoice-issue-saving-hint')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('invoice-issue'));
    await waitFor(() => expect(issuePosted()).toBe(true));
  });

  it('flushes deferred deletions when Issue is clicked while saving', () => {
    const onIssueWhilePending = vi.fn();
    render(<InvoiceActions detail={detail()} variant="header" savePending onIssueWhilePending={onIssueWhilePending} />);
    fireEvent.click(screen.getByTestId('invoice-issue'));
    expect(onIssueWhilePending).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued Issue when a save FAILURE is reported — quiescence after a failure must not issue', async () => {
    // A failed delete-flush restores its rows and a failed line blur-save
    // clears its in-flight key: both read as "quiet". Firing the queue then
    // would number an invoice that contradicts what the user last saw.
    const { rerender } = render(
      <InvoiceActions detail={detail()} variant="header" savePending saveFailureNonce={0} />,
    );
    fireEvent.click(screen.getByTestId('invoice-issue'));
    expect(issuePosted()).toBe(false);

    // The failure signal lands (nonce bump), then the editor goes quiescent.
    rerender(<InvoiceActions detail={detail()} variant="header" savePending saveFailureNonce={1} />);
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    rerender(<InvoiceActions detail={detail()} variant="header" savePending={false} saveFailureNonce={1} />);

    // The queue was dropped by the failure — quiescence fires nothing.
    await act(async () => {});
    await waitFor(() => expect(screen.queryByTestId('invoice-issue-saving-hint')).not.toBeInTheDocument());
    expect(issuePosted()).toBe(false);
  });

  it('cancels a queued Issue when the failure and quiescence arrive in the SAME render', async () => {
    // The dangerous shape: one commit in which the nonce bumps AND savePending
    // goes false. Splitting these across two rerenders proves nothing — the
    // first is inert while savePending is still true, so the assertion passes
    // even if the guard is ordered wrongly. Both props must flip at once.
    const { rerender } = render(
      <InvoiceActions detail={detail()} variant="header" savePending saveFailureNonce={0} />,
    );
    fireEvent.click(screen.getByTestId('invoice-issue'));
    expect(issuePosted()).toBe(false);

    rerender(<InvoiceActions detail={detail()} variant="header" savePending={false} saveFailureNonce={1} />);

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await act(async () => {});
    expect(issuePosted()).toBe(false);
  });

  it('refuses (does not queue) an Issue click when a field failed to save and stays dirty', async () => {
    // Queueing here would wait on a save that is never coming. The hint and the
    // toast must name the field instead of promising a save in progress.
    render(<InvoiceActions detail={detail()} variant="header" unsavedFieldLabel="Notes" />);

    expect(screen.queryByTestId('invoice-issue-saving-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoice-issue-unsaved-hint')).toHaveTextContent('Notes');

    fireEvent.click(screen.getByTestId('invoice-issue'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('Notes') }),
    ));
    // No queue, no spinner, and above all no POST.
    expect(issuePosted()).toBe(false);
  });

  it('re-checks the unsaved-field refusal before firing a queued Issue', async () => {
    // The click gate tests savePending FIRST, so a click during a deferred
    // delete queues even while an earlier failed price save keeps a field
    // dirty (its nonce bump happened BEFORE the click, so the captured nonce
    // never changes). When the flush succeeds and the editor goes quiet, the
    // queue must re-check the label and refuse — firing would issue the
    // invoice at the pre-edit money.
    const { rerender } = render(
      <InvoiceActions detail={detail()} variant="header" savePending unsavedFieldLabel="Notes" />,
    );
    fireEvent.click(screen.getByTestId('invoice-issue'));
    expect(issuePosted()).toBe(false);

    // Quiescence arrives with the field STILL flagged unsaved.
    rerender(
      <InvoiceActions detail={detail()} variant="header" savePending={false} unsavedFieldLabel="Notes" />,
    );

    // The refusal surfaces exactly like an immediate click's would — a warning
    // naming the field — and above all no POST.
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('Notes') }),
    ));
    await act(async () => {});
    expect(issuePosted()).toBe(false);
    // The queue is gone (no spinner promising a fire that isn't coming).
    expect(screen.getByTestId('invoice-issue').querySelector('.animate-spin')).toBeNull();
  });

  it('re-checks the visible-lines precondition before firing a queued Issue', async () => {
    // The queue can outlive the gate: flushing the deferred delete of the last
    // customer-visible line is itself what the Issue click triggered.
    const withLine = detail();
    const { rerender } = render(<InvoiceActions detail={withLine} variant="header" savePending />);
    fireEvent.click(screen.getByTestId('invoice-issue'));

    const emptied = detail();
    emptied.lines = [{ ...visibleLine, customerVisible: false }];
    rerender(<InvoiceActions detail={emptied} variant="header" savePending={false} />);

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    expect(issuePosted()).toBe(false);
  });

  it('drops a queued Issue after a bounded wait when a save stays in flight, with an honest still-saving toast', async () => {
    // With failures handled by the nonce signal, the timeout is the slow-save
    // backstop — its copy must not claim a failure nobody saw.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<InvoiceActions detail={detail()} variant="header" savePending />);
      fireEvent.click(screen.getByTestId('invoice-issue'));
      expect(issuePosted()).toBe(false);

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
      // The queue is gone: even if the editor later goes quiescent, nothing fires.
      expect(issuePosted()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
