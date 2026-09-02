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
  ...over,
});

describe('AccountingSyncCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(json({ syncStatus: 'synced', docNumber: 'INV-0007', taxVarianceCents: null }));
  });

  it('renders nothing when there is no accounting sync row (no connection, or RLS-hidden)', () => {
    const { container } = render(
      <AccountingSyncCard invoiceId="inv-1" sync={null} canPush onChanged={vi.fn()} />,
    );
    expect(screen.queryByTestId('invoice-detail-accounting-sync')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the pending state with a Push affordance', () => {
    render(<AccountingSyncCard invoiceId="inv-1" sync={sync()} canPush onChanged={vi.fn()} />);

    expect(screen.getByTestId('invoice-detail-accounting-sync')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-accounting-sync-status')).toHaveTextContent('Not pushed yet');
    expect(screen.getByTestId('invoice-accounting-sync-push')).toBeInTheDocument();
  });

  it('renders the synced state with the QuickBooks document number and no Push button', () => {
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync({ syncStatus: 'synced', remoteDocNumber: 'QB-1042', lastSyncedAt: '2026-09-01T10:00:00Z' })}
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

  it('renders tax variance with its own copy — never as "pending" and never as a plain "Synced"', () => {
    render(
      <AccountingSyncCard
        invoiceId="inv-1"
        sync={sync({ syncStatus: 'synced_with_tax_variance', remoteDocNumber: 'QB-1042' })}
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
        canPush={false}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByTestId('invoice-detail-accounting-sync')).toBeInTheDocument();
    expect(screen.queryByTestId('invoice-accounting-sync-push')).not.toBeInTheDocument();
  });

  it('pushes through runAction, disables the button in flight, and refetches on success', async () => {
    const onChanged = vi.fn();
    let release!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { release = r; }));

    render(<AccountingSyncCard invoiceId="inv-1" sync={sync()} canPush onChanged={onChanged} />);
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

    render(<AccountingSyncCard invoiceId="inv-1" sync={sync()} canPush onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('invoice-accounting-sync-push'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onChanged).not.toHaveBeenCalled();
    // Button must come back so the operator can retry after fixing the mapping.
    await waitFor(() => expect(screen.getByTestId('invoice-accounting-sync-push')).not.toBeDisabled());
  });
});
