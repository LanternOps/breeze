import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  AuthSessionExpiredError: class AuthSessionExpiredError extends Error {},
}));
vi.mock('../integrations/LinkSubscriptionPicker', () => ({
  default: () => <div data-testid="mock-picker" />,
}));

import ContractPax8Drawer from './ContractPax8Drawer';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

const baseSub = {
  id: 'sub-1',
  orgId: 'org-1',
  productName: 'Microsoft 365 E3',
  vendorName: 'Microsoft',
  quantity: 5,
  unitPrice: '42.5',
  currencyCode: 'USD',
  contractLineId: null,
};

function renderOpen() {
  return render(
    <ContractPax8Drawer open orgId="org-1" integrationId="int-1" onClose={vi.fn()} onLinked={vi.fn()} />,
  );
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('ContractPax8Drawer pick list', () => {
  it('shows the Pax8 sell price alongside vendor and quantity', async () => {
    fetchWithAuth.mockResolvedValue(ok([baseSub]));
    renderOpen();
    const meta = await screen.findByTestId('contract-pax8-meta-sub-1');
    expect(meta.textContent).toBe('Microsoft · qty 5 · USD 42.50/ea');
  });

  it('omits the price segment when the subscription has no sell price', async () => {
    fetchWithAuth.mockResolvedValue(ok([{ ...baseSub, unitPrice: null }]));
    renderOpen();
    const meta = await screen.findByTestId('contract-pax8-meta-sub-1');
    expect(meta.textContent).toBe('Microsoft · qty 5');
  });

  it('omits a zero price and marks an already-linked subscription', async () => {
    fetchWithAuth.mockResolvedValue(ok([{ ...baseSub, unitPrice: '0', contractLineId: 'line-9' }]));
    renderOpen();
    const meta = await screen.findByTestId('contract-pax8-meta-sub-1');
    expect(meta.textContent).toBe('Microsoft · qty 5 · already linked');
  });

  it('defaults to USD when the subscription has no currency code', async () => {
    fetchWithAuth.mockResolvedValue(ok([{ ...baseSub, currencyCode: null }]));
    renderOpen();
    const meta = await screen.findByTestId('contract-pax8-meta-sub-1');
    expect(meta.textContent).toBe('Microsoft · qty 5 · USD 42.50/ea');
  });
});

describe('ContractPax8Drawer dialog semantics', () => {
  it('renders a modal dialog and moves focus inside on open', async () => {
    fetchWithAuth.mockResolvedValue(ok([baseSub]));
    renderOpen();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Focus lands on the first focusable control inside the dialog (the close button).
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });
});

describe('ContractPax8Drawer load failures', () => {
  it('surfaces an error when the subscriptions request is not ok', async () => {
    fetchWithAuth.mockResolvedValue(new Response('{"error":"nope"}', { status: 500 }));
    renderOpen();
    expect(await screen.findByTestId('contract-pax8-error')).toBeTruthy();
  });

  it('surfaces an error instead of hanging when the request throws', async () => {
    // A network failure rejects the fetch; the drawer must not sit on "Loading…".
    fetchWithAuth.mockRejectedValue(new TypeError('network down'));
    renderOpen();
    expect(await screen.findByTestId('contract-pax8-error')).toBeTruthy();
  });
});
