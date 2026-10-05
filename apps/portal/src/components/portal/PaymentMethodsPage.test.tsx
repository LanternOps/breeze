// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiGet, apiPost } from '@/lib/api';
import PaymentMethodsPage from './PaymentMethodsPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

const card = { type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242', cardExpMonth: 12, cardExpYear: 2031, status: 'active' };
const bank = { type: 'us_bank_account', bankName: 'STRIPE TEST BANK', bankLast4: '6789', status: 'active' };
function page(enrollment: Record<string, unknown> | null, method: Record<string, unknown> | null = null, extra: Record<string, unknown> = {}) {
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', supportEmail: 'billing@msp.example', achMode: 'ach_preferred',
    scheduleText: 'Due date', enrollment, method, disclosures: {}, ...extra } } as never);
  render(<PaymentMethodsPage />);
}
const status = () => screen.findByTestId('autopay-status');

describe('one honest summary per state, never an internal code', () => {
  it('not set up', async () => {
    page(null);
    expect(await status()).toHaveTextContent('Not set up');
    expect(screen.getByText(/Example MSP hasn't set up automatic payments for your account/)).toBeInTheDocument();
    expect(screen.queryByTestId('autopay-update-method')).toBeNull();
    expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Payment methods' })).toBeInTheDocument();
    expect(document.querySelector('main')).toBeNull();
  });
  it('requested: asks the client to act, offers setup and no stop (nothing to stop yet)', async () => {
    page({ status: 'requested', needsAttentionReason: null });
    expect(await status()).toHaveTextContent('Waiting for you');
    expect(screen.getByTestId('autopay-update-method')).toHaveTextContent('Set up automatic payments');
    expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
  });
  it('active card: the method in words, its expiry, since when, and what happens before each payment', async () => {
    page({ status: 'active', needsAttentionReason: null, effectiveFrom: '2026-10-05T04:05:08.366Z' }, card);
    expect(await status()).toHaveTextContent('On');
    expect(screen.getByTestId('autopay-saved-method')).toHaveTextContent('Visa credit card ending in 4242');
    expect(screen.getByText('Expires December 2031')).toBeInTheDocument();
    expect(screen.getByText(/On since October/)).toBeInTheDocument();
    expect(screen.getByText('We email you the amount and date before each payment.')).toBeInTheDocument();
    expect(screen.getByTestId('autopay-update-method')).toHaveTextContent('Change payment method');
    expect(document.body.textContent).not.toMatch(/\bactive\b|visa credit|2026-10-05/);
  });
  it('active bank: names the account and its bank', async () => {
    page({ status: 'active', needsAttentionReason: null }, bank);
    expect(await screen.findByTestId('autopay-saved-method')).toHaveTextContent('Bank account ending in 6789');
    expect(screen.getByText('STRIPE TEST BANK')).toBeInTheDocument();
  });
  it('pending verification: says what to do and that nothing is charged until then', async () => {
    page({ status: 'active', needsAttentionReason: null }, { ...bank, status: 'pending_verification' });
    expect(await status()).toHaveTextContent('Verify your bank');
    expect(screen.getByText(/Stripe will email you instructions to verify this account/)).toBeInTheDocument();
    expect(screen.getByTestId('autopay-update-method')).toHaveTextContent('Use a different method');
  });
  it('method unusable: needs attention, update offered, and invoices meanwhile are pointed at', async () => {
    page({ status: 'active', needsAttentionReason: 'method_unusable' }, { ...card, status: 'unusable' });
    expect(await status()).toHaveTextContent('Needs attention');
    expect(screen.getByTestId('autopay-needs-attention')).toHaveTextContent("This payment method can't be charged any more.");
    expect(screen.getByTestId('autopay-update-method')).toHaveTextContent('Update payment method');
    expect(document.body.textContent).not.toContain('method_unusable');
  });
  it('method unusable with no method row still never says "No payment method on file" beside "On"', async () => {
    page({ status: 'active', needsAttentionReason: 'method_unusable' });
    expect(await screen.findByTestId('autopay-needs-attention')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('No payment method on file');
  });
  it('bank verification failed', async () => {
    page({ status: 'active', needsAttentionReason: 'verification_failed' }, bank);
    expect(await screen.findByTestId('autopay-needs-attention')).toHaveTextContent("We couldn't verify your bank account ending in 6789");
    expect(screen.getByTestId('autopay-update-method')).toBeInTheDocument();
  });
  it.each(['stripe_account_changed', 'key_missing_permissions'])('provider-side %s hold: on hold, no update that would fail', async reason => {
    page({ status: 'active', needsAttentionReason: reason }, card);
    expect(await status()).toHaveTextContent('On hold');
    expect(screen.getByTestId('autopay-needs-attention')).toHaveTextContent("You don't need to do anything");
    expect(screen.queryByTestId('autopay-update-method')).toBeNull();
    expect(screen.getByTestId('autopay-saved-method')).toHaveTextContent('4242');
  });
  it('paused by the MSP: when, what it means, and only stop', async () => {
    page({ status: 'paused', needsAttentionReason: null, pausedAt: '2026-10-06T10:00:00Z' }, card);
    expect(await status()).toHaveTextContent('Paused');
    expect(screen.getByText(/Example MSP paused automatic payments on October 6, 2026/)).toBeInTheDocument();
    expect(screen.queryByTestId('autopay-update-method')).toBeNull();
    expect(screen.getByTestId('autopay-portal-stop')).toBeInTheDocument();
  });
  it('paused with an unusable method points to the MSP (portal updates are refused while paused)', async () => {
    page({ status: 'paused', needsAttentionReason: 'method_unusable' });
    expect(await screen.findByTestId('autopay-needs-attention')).toHaveTextContent('Contact Example MSP to update it.');
    expect(screen.queryByTestId('autopay-update-method')).toBeNull();
  });
  it.each([['client', 'You stopped automatic payments on October 6, 2026.'], ['msp', 'Example MSP turned off automatic payments on October 6, 2026.']])(
    'stopped by %s', async (source, text) => {
      page({ status: 'cancelled', needsAttentionReason: 'method_unusable', cancelSource: source, cancelledAt: '2026-10-06T10:00:00Z' });
      expect(await status()).toHaveTextContent('Off');
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.queryByTestId('autopay-needs-attention')).toBeNull();
      expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
    });
  it('a card expiring within 30 days asks for an update', async () => {
    const soon = new Date(); soon.setUTCDate(soon.getUTCDate() + 10);
    page({ status: 'active', needsAttentionReason: null }, { ...card, cardExpMonth: soon.getUTCMonth() + 1, cardExpYear: soon.getUTCFullYear() });
    expect(await screen.findByText(/: update it soon/)).toBeInTheDocument();
  });
});

describe('actions', () => {
  it('stop: confirms inline before posting, then refreshes and says what happened', async () => {
    const data = { partnerName: 'Example MSP', achMode: 'ach_only', enrollment: { status: 'active' }, method: { ...bank, status: 'pending_verification' }, disclosures: {} };
    vi.mocked(apiGet).mockResolvedValue({ data } as never);
    render(<PaymentMethodsPage />);
    fireEvent.click(await screen.findByTestId('autopay-portal-stop'));
    expect(await screen.findByTestId('autopay-stop-confirm')).toHaveTextContent("A payment that has already started can't be stopped.");
    expect(screen.getByRole('heading', { level: 2, name: 'Stop automatic payments to Example MSP?' })).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    vi.mocked(apiGet).mockResolvedValue({ data: { ...data, enrollment: { status: 'cancelled', cancelSource: 'client' }, method: null } } as never);
    vi.mocked(apiPost).mockResolvedValue({ data: { success: true } } as never);
    fireEvent.click(screen.getByTestId('autopay-stop-submit'));
    expect(await screen.findByTestId('autopay-stop-feedback')).toHaveTextContent('Automatic payments are off.');
    await waitFor(() => expect(screen.getByTestId('autopay-status')).toHaveTextContent('Off'));
    expect(apiPost).toHaveBeenCalledWith('/portal/autopay/stop', {}, { redirectOnUnauthorized: true });
    expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
  });
  it('"Keep them on" returns to the summary without posting', async () => {
    page({ status: 'active', needsAttentionReason: null }, card);
    fireEvent.click(await screen.findByTestId('autopay-portal-stop'));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep them on' }));
    expect(await screen.findByTestId('autopay-status')).toHaveTextContent('On');
    expect(apiPost).not.toHaveBeenCalled();
  });
  it('change method opens the inline form with a Cancel', async () => {
    page({ status: 'active', needsAttentionReason: null }, card,
      { disclosures: { card: { text: 'Card terms', hash: 'a'.repeat(64), feeText: 'x' }, us_bank_account: { text: 'Bank terms', hash: 'b'.repeat(64), feeText: 'y' } } });
    fireEvent.click(await screen.findByTestId('autopay-update-method'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Change your payment method' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('autopay-update-method')).toBeInTheDocument();
  });
  it.each(['active', 'paused', 'verification_failed'])('switched off with a %s enrollment: stop only, and the stop lands without an error', async state => {
    vi.mocked(apiGet).mockResolvedValue({ statusCode: 200, data: { stopOnly: true, partnerName: 'Example MSP',
      enrollment: { status: state === 'verification_failed' ? 'active' : state, needsAttentionReason: state === 'verification_failed' ? state : null }, method: card } } as never);
    render(<PaymentMethodsPage />);
    expect(await screen.findByTestId('autopay-saved-method')).toHaveTextContent('4242');
    expect(screen.queryByTestId('autopay-update-method')).toBeNull();
    fireEvent.click(screen.getByTestId('autopay-portal-stop'));
    vi.mocked(apiPost).mockResolvedValue({ data: { success: true } } as never);
    vi.mocked(apiGet).mockResolvedValue({ statusCode: 404, error: 'Automatic payments are not enabled' } as never);
    fireEvent.click(await screen.findByTestId('autopay-stop-submit'));
    expect(await screen.findByTestId('autopay-stop-feedback')).toHaveTextContent('Automatic payments are off.');
    expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
    expect(screen.queryByTestId('autopay-payment-methods-error')).toBeNull();
    expect(apiPost).toHaveBeenCalledExactlyOnceWith('/portal/autopay/stop', {}, { redirectOnUnauthorized: true });
  });
  it('a load failure is an error with a refresh, not a blank page', async () => {
    vi.mocked(apiGet).mockResolvedValue({ statusCode: 404, error: 'Automatic payments are not enabled' } as never);
    render(<PaymentMethodsPage />);
    expect(await screen.findByTestId('autopay-payment-methods-error')).toHaveTextContent("We couldn't load your payment details.");
    expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
  });
});
