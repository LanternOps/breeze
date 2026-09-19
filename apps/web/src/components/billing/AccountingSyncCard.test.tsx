import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AccountingSyncCard from './AccountingSyncCard';
import type { AccountingSyncSummary, InvoiceStatus } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const sync = (over: Partial<AccountingSyncSummary> = {}): AccountingSyncSummary => ({
  provider: 'quickbooks',
  syncStatus: 'pending',
  lastSyncedAt: null,
  lastError: null,
  remoteDocNumber: null,
  remoteDeleted: false,
  ...over,
});

describe('AccountingSyncCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(json({ syncStatus: 'synced', docNumber: 'INV-0007', taxVarianceCents: null }));
  });

  it('renders nothing when there is no accounting sync row (no connection, or RLS-hidden)', () => {
    const { container } = render(
      <AccountingSyncCard invoiceId="inv-1" sync={null} invoiceStatus="sent" canPush onChanged={vi.fn()} />,
    );
    expect(screen.queryByTestId('invoice-detail-accounting-sync')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the pending state with a Push affordance', () => {
    render(<AccountingSyncCard invoiceId="inv-1" sync={sync()} invoiceStatus="sent" canPush onChanged={vi.fn()} />);

    expect(screen.getByTestId('invoice-detail-accounting-sync')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Not pushed yet');
    expect(screen.getByTestId('invoice-accounting-sync-push')).toBeInTheDocument();
  });

  it('renders the synced state with the QuickBooks document number and no Push button', () => {
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync({ syncStatus: 'synced', remoteDocNumber: 'QB-1042', lastSyncedAt: '2026-09-01T10:00:00Z' })}
        invoiceStatus="sent"
        canPush
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Synced');
    expect(screen.getByTestId('invoice-accounting-sync-docnumber')).toHaveTextContent('QB-1042');
    expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
  });

  it('renders the error state with the sanitized lastError and a retry Push button', () => {
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync({ syncStatus: 'error', lastError: 'QuickBooks rejected the invoice sync (HTTP 500)' })}
        invoiceStatus="sent"
        canPush
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Sync failed');
    expect(screen.getByTestId('invoice-accounting-sync-error')).toHaveTextContent(
      'QuickBooks rejected the invoice sync (HTTP 500)',
    );
    expect(screen.getByTestId('invoice-accounting-sync-push')).toBeInTheDocument();
  });

  // Phase D writes a mapping-error marker onto the same `lastError` column when
  // a reconcile finds the QuickBooks invoice gone. This pins the copy path the
  // spec relies on — but with remoteDeleted explicitly false (i.e. the API
  // itself did not flag this as the marker), the Push button must still
  // render: the component decides purely off the typed `remoteDeleted` flag,
  // never by string-matching `lastError` itself (#4544).
  it('renders a reconcile-sourced lastError verbatim, not just push failures — and does not itself infer remoteDeleted from the string', () => {
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync({ syncStatus: 'error', lastError: 'Deleted in QuickBooks', remoteDeleted: false })}
        invoiceStatus="sent"
        canPush
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByTestId('invoice-accounting-sync-error')).toHaveTextContent(
      'Deleted in QuickBooks',
    );
    expect(screen.getByTestId('invoice-accounting-sync-push')).toBeInTheDocument();
  });

  it('renders tax variance with its own copy — never as "pending" and never as a plain "Synced"', () => {
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync({ syncStatus: 'synced_with_tax_variance', remoteDocNumber: 'QB-1042' })}
        invoiceStatus="sent"
        canPush
        onChanged={vi.fn()}
      />,
    );

    const pill = screen.getByTestId('invoice-accounting-sync-status');
    expect(pill).toHaveTextContent('Synced with tax difference');
    expect(pill).not.toHaveTextContent('Not pushed yet');
    expect(screen.getByTestId('invoice-accounting-sync-variance')).toBeInTheDocument();
    // A tax-variance row IS synced — pushing again is not the remedy.
    expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
  });

  it('hides the Push button without invoices:write even when the row is pushable', () => {
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync({ syncStatus: 'error', lastError: 'boom' })}
        invoiceStatus="sent"
        canPush={false}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByTestId('invoice-detail-accounting-sync')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
  });

  // `remoteDeleted` is optional (absent on an older API response — deploy
  // skew). This pins the intentional default direction: missing degrades to
  // "button renders, a real push attempt gets the server's 409" rather than
  // crashing or silently misreading `undefined` as some other truthy state.
  it('does not crash and renders the button when remoteDeleted is omitted from the API response', () => {
    const { remoteDeleted: _omit, ...syncWithoutRemoteDeleted } = sync({ syncStatus: 'pending' });
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={syncWithoutRemoteDeleted as AccountingSyncSummary}
        invoiceStatus="sent"
        canPush
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByTestId('invoice-accounting-sync-push')).toBeInTheDocument();
  });

  // #4544 — voided invoice: the mapping row's own syncStatus can still read
  // 'pending'/'error' from before the void, so the guard must be independent
  // of `sync` and keyed off the invoice's own status.
  describe('voided invoice (#4544)', () => {
    it('hides the Push button and shows an explanatory hint on an otherwise-pushable (pending) mapping', () => {
      render(
        <AccountingSyncCard
          invoiceId="inv-1"
          sync={sync({ syncStatus: 'pending' })}
          invoiceStatus="void"
          canPush
          onChanged={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
      expect(screen.getByTestId('invoice-accounting-sync-voided-hint')).toBeInTheDocument();
    });

    it('hides the Push button on an otherwise-pushable (error) mapping', () => {
      render(
        <AccountingSyncCard
          invoiceId="inv-1"
          sync={sync({ syncStatus: 'error', lastError: 'boom' })}
          invoiceStatus="void"
          canPush
          onChanged={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
    });

    it('does not render the voided hint for a synced mapping — there was never a Push button to explain away', () => {
      render(
        <AccountingSyncCard
          invoiceId="inv-1"
          sync={sync({ syncStatus: 'synced', remoteDocNumber: 'QB-1042' })}
          invoiceStatus="void"
          canPush
          onChanged={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
      expect(screen.queryByTestId('invoice-accounting-sync-voided-hint')).not.toBeInTheDocument();
    });
  });

  // #4544 — remote-deleted (Phase D `markInvoiceDeletedRemotely`): the API
  // surfaces this as a typed boolean, not something this component derives
  // itself from `lastError`.
  describe('remote-deleted mapping (#4544)', () => {
    it('hides the Push button and shows an explanatory hint', () => {
      render(
        <AccountingSyncCard
          invoiceId="inv-1"
          sync={sync({ syncStatus: 'error', lastError: 'Deleted in QuickBooks', remoteDeleted: true })}
          invoiceStatus="sent"
          canPush
          onChanged={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
      expect(screen.getByTestId('invoice-accounting-sync-remote-deleted-hint')).toBeInTheDocument();
      // The raw error text is still shown verbatim underneath.
      expect(screen.getByTestId('invoice-accounting-sync-error')).toHaveTextContent('Deleted in QuickBooks');
    });

    it('prefers the voided hint over the remote-deleted hint when both apply, without rendering both', () => {
      render(
        <AccountingSyncCard
          invoiceId="inv-1"
          sync={sync({ syncStatus: 'error', lastError: 'Deleted in QuickBooks', remoteDeleted: true })}
          invoiceStatus="void"
          canPush
          onChanged={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
      expect(screen.getByTestId('invoice-accounting-sync-voided-hint')).toBeInTheDocument();
      expect(screen.queryByTestId('invoice-accounting-sync-remote-deleted-hint')).not.toBeInTheDocument();
    });
  });

  it('pushes through runAction, disables the button in flight, and refetches on success', async () => {
    const onChanged = vi.fn();
    let release!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { release = r; }));

    render(<AccountingSyncCard invoiceId="inv-1" sync={sync()} invoiceStatus="sent" canPush onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('invoice-accounting-sync-push'));

    await waitFor(() => expect(screen.getByTestId('invoice-accounting-sync-push')).toBeDisabled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/accounting/quickbooks/invoices/inv-1/push',
      expect.objectContaining({ method: 'POST' }),
    );

    release(json({ syncStatus: 'synced', docNumber: 'INV-0007', taxVarianceCents: null }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('surfaces a typed push rejection and does not refetch', async () => {
    const onChanged = vi.fn();
    fetchMock.mockResolvedValue(
      json({ error: 'currency_mismatch', message: 'Invoice currency EUR does not match the QuickBooks home currency USD.' }, false, 409),
    );

    render(<AccountingSyncCard invoiceId="inv-1" sync={sync()} invoiceStatus="sent" canPush onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('invoice-accounting-sync-push'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onChanged).not.toHaveBeenCalled();
    // Button must come back so the operator can retry after fixing the mapping.
    await waitFor(() => expect(screen.getByTestId('invoice-accounting-sync-push')).not.toBeDisabled());
  });

  // #4544: a typed `remote_deleted` 409 must surface through the same
  // runAction/ActionError path as any other rejection — no special-casing
  // needed in the click handler, since the button is already hidden for a
  // known-remote-deleted mapping and this only exercises a race (button was
  // rendered off stale data, then the server catches it).
  it('surfaces a remote_deleted 409 push rejection through the standard runAction toast path', async () => {
    const onChanged = vi.fn();
    fetchMock.mockResolvedValue(
      json({ error: 'remote_deleted', message: 'QuickBooks reports this invoice as deleted — pushing again would create a duplicate.' }, false, 409),
    );

    render(<AccountingSyncCard invoiceId="inv-1" sync={sync()} invoiceStatus="sent" canPush onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('invoice-accounting-sync-push'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('deleted') }),
    ));
    expect(onChanged).not.toHaveBeenCalled();
  });
});

/**
 * Live sync status after Issue (paper cut, prod v0.110.0). The auto-push
 * worker lands a second or two AFTER the issue response, so the card used to
 * sit on the stale "Not pushed yet" + "Push to QuickBooks" it was rendered
 * with until the operator hand-reloaded — inviting a double submit or a
 * "auto-push is broken" bug report. The card now watches the invoice's own
 * draft -> issued transition (works no matter which copy of InvoiceActions
 * owns the Issue button) and polls the invoice refetch until the mapping row
 * reaches a terminal status, then falls back to the old view on timeout.
 */
describe('AccountingSyncCard live sync watch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const issued = (onChanged: () => void, initialSync: AccountingSyncSummary | null = null) => {
    const view = render(
      <AccountingSyncCard invoiceId="inv-1" sync={initialSync} invoiceStatus="draft" canPush onChanged={onChanged} />,
    );
    const show = (next: AccountingSyncSummary | null, status: InvoiceStatus = 'sent') =>
      act(() => {
        view.rerender(
          <AccountingSyncCard invoiceId="inv-1" sync={next} invoiceStatus={status} canPush onChanged={onChanged} />,
        );
      });
    // The Issue action flips the invoice out of draft and the refetch brings
    // back the freshly-claimed (still pending) mapping row.
    show(sync());
    return { ...view, show };
  };

  it('shows Syncing and hides the Push button once the invoice leaves draft', () => {
    issued(vi.fn());

    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Syncing');
    expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
  });

  it('polls the invoice every 3s while syncing and stops as soon as the row reads synced', () => {
    const onChanged = vi.fn();
    const { show } = issued(onChanged);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(onChanged).toHaveBeenCalledTimes(1);

    show(sync({ syncStatus: 'synced', remoteDocNumber: 'QB-1042', lastSyncedAt: '2026-09-01T10:00:00Z' }));
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Synced');
    expect(screen.getByTestId('invoice-accounting-sync-docnumber')).toHaveTextContent('QB-1042');

    act(() => { vi.advanceTimersByTime(30000); });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('stops polling and surfaces the failure when the row reads error', () => {
    const onChanged = vi.fn();
    const { show } = issued(onChanged);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(onChanged).toHaveBeenCalledTimes(1);

    show(sync({ syncStatus: 'error', lastError: 'QuickBooks rejected the invoice sync (HTTP 500)' }));
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Sync failed');
    expect(screen.getByTestId('invoice-accounting-sync-error')).toHaveTextContent('HTTP 500');
    // Error is a retryable state, so the manual affordance comes back.
    expect(screen.getByTestId('invoice-accounting-sync-push')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(30000); });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  // `advanceTimersByTimeAsync` (not the sync form) because each poll only
  // releases the next one when its refetch promise settles — a microtask,
  // which the synchronous form never flushes.
  it('falls back to Not pushed yet with the Push button when the watch times out', async () => {
    const onChanged = vi.fn();
    issued(onChanged);

    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });

    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Not pushed yet');
    expect(screen.getByTestId('invoice-accounting-sync-push')).toBeInTheDocument();
    const calls = onChanged.mock.calls.length;
    // Discriminating: the fallback must be reached by the watch EXPIRING, not
    // by a watch that never polled in the first place.
    expect(calls).toBeGreaterThan(1);
    act(() => { vi.advanceTimersByTime(30000); });
    expect(onChanged).toHaveBeenCalledTimes(calls);
  });

  it('clears the poll timer on unmount', () => {
    const onChanged = vi.fn();
    const { unmount } = issued(onChanged);
    // Control: the watch really did install a timer, so the post-unmount
    // assertions below discriminate instead of passing on an empty queue.
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    act(() => { vi.advanceTimersByTime(30000); });
    expect(onChanged).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  // The manual push route is SYNCHRONOUS — it awaits the QuickBooks call and
  // returns the settled syncStatus (routes/accounting/index.ts) — so the
  // refetch that follows already reads the outcome. Arming the watch here
  // would strand a retry from an `error` row on a 60s spinner, because the
  // row's status never changes again to end it.
  it('does not arm the watch after a manual push — the route is synchronous', async () => {
    const onChanged = vi.fn();
    fetchMock.mockResolvedValue(json({ syncStatus: 'synced', docNumber: 'QB-1042', taxVarianceCents: null }));

    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync({ syncStatus: 'error', lastError: 'QuickBooks rejected the invoice sync (HTTP 500)' })}
        invoiceStatus="sent"
        canPush
        onChanged={onChanged}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('invoice-accounting-sync-push'));
    });

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('invoice-accounting-sync-status')).not.toHaveTextContent('Syncing');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the watch when the invoice is voided mid-window', () => {
    const onChanged = vi.fn();
    const { show } = issued(onChanged);
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Syncing');

    // The operator voids the invoice while the push is still in flight — a
    // spinning "Syncing…" over the "nothing to push" hint is a contradiction.
    show(sync(), 'void');
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Not pushed yet');
    expect(screen.getByTestId('invoice-accounting-sync-voided-hint')).toBeInTheDocument();

    const calls = onChanged.mock.calls.length;
    act(() => { vi.advanceTimersByTime(30000); });
    expect(onChanged).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The watch must not give up early on a mapping row that has not appeared
  // yet: under a worker backlog the row is claimed well after the issue
  // response, and nothing else would restart the watch.
  it('keeps polling the whole window while no mapping row has appeared yet', async () => {
    const onChanged = vi.fn();
    const view = render(
      <AccountingSyncCard invoiceId="inv-1" sync={null} invoiceStatus="draft" canPush onChanged={onChanged} />,
    );
    const show = (next: AccountingSyncSummary | null) =>
      act(() => {
        view.rerender(
          <AccountingSyncCard invoiceId="inv-1" sync={next} invoiceStatus="sent" canPush onChanged={onChanged} />,
        );
      });
    show(null);

    // 30s of a backlogged worker: no row yet, still polling.
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(onChanged.mock.calls.length).toBeGreaterThanOrEqual(9);
    // Nothing is rendered while there is no row to show...
    expect(screen.queryByTestId('invoice-detail-accounting-sync')).not.toBeInTheDocument();

    // ...and the late row is still picked up by the same live watch.
    show(sync());
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Syncing');
    show(sync({ syncStatus: 'synced' }));
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Synced');
  });

  it('skips a tick while the previous refetch is still in flight', async () => {
    let resolveRefetch: (() => void) | undefined;
    const onChanged = vi.fn(() => new Promise<void>((resolve) => { resolveRefetch = resolve; }));
    const view = render(
      <AccountingSyncCard invoiceId="inv-1" sync={null} invoiceStatus="draft" canPush onChanged={onChanged} />,
    );
    act(() => {
      view.rerender(
        <AccountingSyncCard invoiceId="inv-1" sync={sync()} invoiceStatus="sent" canPush onChanged={onChanged} />,
      );
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(onChanged).toHaveBeenCalledTimes(1);

    // Three more ticks pass while the first refetch is still pending — a slow
    // response must not queue up refetches that can land out of order.
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(onChanged).toHaveBeenCalledTimes(1);

    // Once it settles the cadence resumes.
    await act(async () => { resolveRefetch?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});

/**
 * The primary prod flow never sees the draft -> issued transition at all:
 * InvoiceWorkspace opens a draft on the Editor tab and only renders
 * InvoiceDetail when the Detail tab is active, so a header Issue click flips
 * the status, unmounts the editor and mounts the Detail tab (and this card)
 * FRESH — already in the issued state. The card therefore also arms the watch
 * on mount for an invoice that was touched seconds ago and has no settled
 * mapping row.
 */
describe('AccountingSyncCard live sync watch on a fresh mount', () => {
  const NOW = Date.parse('2026-09-06T12:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it('shows Syncing on mount when the invoice was just issued', () => {
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync()}
        invoiceStatus="sent"
        invoiceTouchedAt={at(2000)}
        canPush
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Syncing');
    expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
  });

  it('polls on a fresh mount and settles on the pushed row', () => {
    const onChanged = vi.fn();
    const view = render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync()}
        invoiceStatus="sent"
        invoiceTouchedAt={at(2000)}
        canPush
        onChanged={onChanged}
      />,
    );

    act(() => { vi.advanceTimersByTime(3000); });
    expect(onChanged).toHaveBeenCalledTimes(1);

    act(() => {
      view.rerender(
        <AccountingSyncCard
          invoiceId="inv-1"
          sync={sync({ syncStatus: 'synced', remoteDocNumber: 'QB-1042' })}
          invoiceStatus="sent"
          invoiceTouchedAt={at(2000)}
          canPush
          onChanged={onChanged}
        />,
      );
    });
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Synced');
    act(() => { vi.advanceTimersByTime(30000); });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  // Control for the case above: an old invoice with a pending row is a
  // settled fact (manual push mode, or a push that never happened), not a
  // push in flight — it must mount straight to the actionable view.
  it('mounts straight to Not pushed yet for an invoice issued an hour ago', () => {
    const onChanged = vi.fn();
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync()}
        invoiceStatus="sent"
        invoiceTouchedAt={at(3600000)}
        canPush
        onChanged={onChanged}
      />,
    );

    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Not pushed yet');
    expect(screen.getByTestId('invoice-accounting-sync-push')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(60000); });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('does not arm the mount watch for a settled row or a draft', () => {
    const { unmount } = render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync({ syncStatus: 'synced' })}
        invoiceStatus="sent"
        invoiceTouchedAt={at(2000)}
        canPush
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Synced');
    expect(vi.getTimerCount()).toBe(0);
    unmount();

    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync()}
        invoiceStatus="draft"
        invoiceTouchedAt={at(2000)}
        canPush
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Not pushed yet');
    expect(vi.getTimerCount()).toBe(0);
  });

  // Deploy skew: `updatedAt` is not declared on the web's InvoiceSummary today,
  // so an older payload can omit it entirely. No timestamp = no mount watch,
  // never a watch armed on a guess.
  it('does not arm the mount watch without a timestamp', () => {
    const onChanged = vi.fn();
    render(
      <AccountingSyncCard invoiceId="inv-1" sync={sync()} invoiceStatus="sent" canPush onChanged={onChanged} />,
    );

    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Not pushed yet');
    act(() => { vi.advanceTimersByTime(60000); });
    expect(onChanged).not.toHaveBeenCalled();
  });
});
