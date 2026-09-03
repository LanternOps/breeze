import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AccountingSyncCard from './AccountingSyncCard';
import type { AccountingSyncSummary } from './invoiceTypes';
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
