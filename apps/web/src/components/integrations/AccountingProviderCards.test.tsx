import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: m.fetchWithAuth }));
import AccountingProviderCards from './AccountingProviderCards';

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const caps = { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true };

describe('AccountingProviderCards', () => {
  it('shows one card per configured provider only', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'quickbooks', displayName: 'QuickBooks', configured: true, capabilities: caps },
      { id: 'xero', displayName: 'Xero', configured: false, capabilities: caps },
    ], activeConnection: null }));
    render(<AccountingProviderCards selected={null} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('accounting-provider-card-quickbooks')).toBeTruthy());
    expect(screen.queryByTestId('accounting-provider-card-xero')).toBeNull();
  });

  it('greys out another provider\'s card while one is connected (one provider per partner)', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'quickbooks', displayName: 'QuickBooks', configured: true, capabilities: caps },
      { id: 'xero', displayName: 'Xero', configured: true, capabilities: { ...caps, invoicePush: false } },
    ], activeConnection: { provider: 'quickbooks', status: 'connected' } }));
    render(<AccountingProviderCards selected="quickbooks" onSelect={() => {}} />);
    const xero = await screen.findByTestId('accounting-provider-card-xero');
    expect(xero.getAttribute('aria-disabled')).toBe('true');
    expect(xero.textContent).toContain('Disconnect QuickBooks first');
  });

  it('shows an unconfigured provider\'s card while it holds the active connection, so it can still be disconnected', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'quickbooks', displayName: 'QuickBooks', configured: false, capabilities: caps },
      { id: 'xero', displayName: 'Xero', configured: false, capabilities: caps },
    ], activeConnection: { provider: 'quickbooks', status: 'connected' } }));
    render(<AccountingProviderCards selected="quickbooks" onSelect={() => {}} />);
    const qbo = await screen.findByTestId('accounting-provider-card-quickbooks');
    expect(qbo.getAttribute('aria-disabled')).toBe('false');
    expect(qbo.textContent).toContain('Connected');
    // An unconfigured provider that is NOT the active connection stays hidden.
    expect(screen.queryByTestId('accounting-provider-card-xero')).toBeNull();
  });

  it('shows an empty state when no provider card is visible', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'quickbooks', displayName: 'QuickBooks', configured: false, capabilities: caps },
      { id: 'xero', displayName: 'Xero', configured: false, capabilities: caps },
    ], activeConnection: null }));
    render(<AccountingProviderCards selected={null} onSelect={() => {}} />);
    expect(await screen.findByTestId('accounting-provider-cards-empty')).toHaveTextContent(
      'No accounting provider is configured on this instance.',
    );
    expect(screen.queryByTestId('accounting-provider-card-quickbooks')).toBeNull();
  });

  it('shows "Reconnect required" instead of "Connected" for a reauth-required connection', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'quickbooks', displayName: 'QuickBooks', configured: true, capabilities: caps },
    ], activeConnection: { provider: 'quickbooks', status: 'reauth_required' } }));
    render(<AccountingProviderCards selected="quickbooks" onSelect={() => {}} />);
    const qbo = await screen.findByTestId('accounting-provider-card-quickbooks');
    expect(qbo.textContent).toContain('Reconnect required');
    expect(qbo.textContent).not.toContain('Connected');
  });

  it('shows "Choose an organisation" for the connection\'s own card while pending_tenant', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'xero', displayName: 'Xero', configured: true, capabilities: caps },
    ], activeConnection: { provider: 'xero', status: 'pending_tenant' } }));
    render(<AccountingProviderCards selected="xero" onSelect={() => {}} />);
    const xero = await screen.findByTestId('accounting-provider-card-xero');
    expect(xero.textContent).toContain('Choose an organisation');
    expect(xero.textContent).not.toContain('Connected');
  });

  it('shows "Finish or cancel the ... connection first" on another card while one is pending_tenant', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'quickbooks', displayName: 'QuickBooks', configured: true, capabilities: caps },
      { id: 'xero', displayName: 'Xero', configured: true, capabilities: caps },
    ], activeConnection: { provider: 'xero', status: 'pending_tenant' } }));
    render(<AccountingProviderCards selected="xero" onSelect={() => {}} />);
    const qbo = await screen.findByTestId('accounting-provider-card-quickbooks');
    expect(qbo.textContent).toContain('Finish or cancel the Xero connection first');
    expect(qbo.textContent).not.toContain('Disconnect Xero first');
  });

  it('re-fetches when refreshKey changes', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'quickbooks', displayName: 'QuickBooks', configured: true, capabilities: caps },
    ], activeConnection: null }));
    const { rerender } = render(<AccountingProviderCards selected={null} onSelect={() => {}} refreshKey={0} />);
    await waitFor(() => expect(m.fetchWithAuth).toHaveBeenCalledTimes(1));
    rerender(<AccountingProviderCards selected={null} onSelect={() => {}} refreshKey={1} />);
    await waitFor(() => expect(m.fetchWithAuth).toHaveBeenCalledTimes(2));
  });
});
