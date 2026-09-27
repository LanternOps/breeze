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
});
