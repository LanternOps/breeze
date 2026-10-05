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
    // V-35: Stripe's all-caps bank name reads as a name.
    expect(screen.getByText('Stripe Test Bank')).toBeInTheDocument();
    expect(screen.queryByText('STRIPE TEST BANK')).toBeNull();
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
    // V-33: amber for the lead sentence only; the rest is ordinary text.
    expect(screen.getByTestId('autopay-needs-attention-lead')).toHaveClass('text-warning-on-tint');
    expect(screen.getByTestId('autopay-needs-attention')).not.toHaveClass('text-warning-on-tint');
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
  it('a card expiring within 30 days asks for an update, and Update card is the primary action (V-34)', async () => {
    const soon = new Date(); soon.setUTCDate(soon.getUTCDate() + 10);
    page({ status: 'active', needsAttentionReason: null }, { ...card, cardExpMonth: soon.getUTCMonth() + 1, cardExpYear: soon.getUTCFullYear() });
    expect(await screen.findByText(/: update it soon/)).toBeInTheDocument();
    const update = screen.getByTestId('autopay-update-method');
    expect(update).toHaveTextContent('Update card');
    expect(update.className).toContain('bg-primary');
  });
  // V-33: the failing method is named (ACH-Instant lab case: an active bank account the MSP flagged).
  it('needs attention names the failing method even when it is still marked active', async () => {
    page({ status: 'active', needsAttentionReason: 'method_unusable' }, { ...bank, bankLast4: '1116' });
    expect(await screen.findByTestId('autopay-saved-method')).toHaveTextContent('Bank account ending in 1116');
  });
  // V-36: switched off before the client set up: no "Waiting for you" without a button.
  it('switched off with a requested enrollment says setup is unavailable right now', async () => {
    page({ status: 'requested', needsAttentionReason: null }, null, { stopOnly: true });
    expect(await status()).toHaveTextContent('Not available');
    expect(screen.getByText(/Example MSP asked you to set up automatic payments, but setup isn't available right now/)).toBeInTheDocument();
    expect(screen.queryByText('Waiting for you')).toBeNull();
    expect(screen.queryByTestId('autopay-update-method')).toBeNull();
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
    // V-32: the Off summary says it once, with the confirmation folded in; V-31: bank caveat for a bank account.
    expect(await screen.findByTestId('autopay-stop-feedback')).toHaveTextContent("We're emailing you a confirmation. If a bank payment had already started, it may still complete.");
    await waitFor(() => expect(screen.getByTestId('autopay-status')).toHaveTextContent('Off'));
    expect(screen.queryAllByText(/Automatic payments are off/)).toHaveLength(0);
    expect(apiPost).toHaveBeenCalledWith('/portal/autopay/stop', {}, { redirectOnUnauthorized: true });
    expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
  });
  it('a card client is not told about bank payments after stopping (V-31)', async () => {
    page({ status: 'active', needsAttentionReason: null }, card);
    fireEvent.click(await screen.findByTestId('autopay-portal-stop'));
    vi.mocked(apiPost).mockResolvedValue({ data: { success: true } } as never);
    fireEvent.click(await screen.findByTestId('autopay-stop-submit'));
    expect(await screen.findByTestId('autopay-stop-feedback')).toHaveTextContent("We're emailing you a confirmation.");
    expect(document.body.textContent).not.toMatch(/bank payment/);
  });
  it('a failed portal stop keeps the question and says what to do', async () => {
    page({ status: 'active', needsAttentionReason: null }, card);
    fireEvent.click(await screen.findByTestId('autopay-portal-stop'));
    vi.mocked(apiPost).mockResolvedValue({ error: 'boom', statusCode: 500 } as never);
    fireEvent.click(await screen.findByTestId('autopay-stop-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't stop automatic payments");
    expect(screen.getByTestId('autopay-stop-submit')).toBeEnabled();
    expect(screen.queryByTestId('autopay-stop-feedback')).toBeNull();
  });
  // V-12: inline forms keep a readable measure inside the wide portal sheet.
  it('the inline change form and stop confirm sit in a readable column', async () => {
    page({ status: 'active', needsAttentionReason: null }, card,
      { disclosures: { card: { text: 'Card terms', hash: 'a'.repeat(64), feeText: 'x' }, us_bank_account: { text: 'Bank terms', hash: 'b'.repeat(64), feeText: 'y' } } });
    fireEvent.click(await screen.findByTestId('autopay-portal-stop'));
    expect((await screen.findByTestId('autopay-stop-confirm')).parentElement).toHaveClass('max-w-xl');
    fireEvent.click(screen.getByRole('button', { name: 'Keep them on' }));
    fireEvent.click(await screen.findByTestId('autopay-update-method'));
    expect((await screen.findByTestId('autopay-setup-page')).parentElement).toHaveClass('max-w-xl');
  });
  // V-24: the stop action is a link with a real tap target on phones.
  it('the stop link is a 44px target on phones', async () => {
    page({ status: 'active', needsAttentionReason: null }, card);
    expect(await screen.findByTestId('autopay-portal-stop')).toHaveClass('min-h-11');
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
    expect(await screen.findByTestId('autopay-stop-feedback')).toHaveTextContent("We're emailing you a confirmation.");
    expect(screen.getByTestId('autopay-status')).toHaveTextContent('Off');
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

it.each([['STRIPE TEST BANK', 'Stripe Test Bank'], ['BANK OF AMERICA, N.A.', 'Bank of America, N.A.'], ['JPMORGAN CHASE BANK, NA', 'Jpmorgan Chase Bank, NA'],
  ['Wells Fargo', 'Wells Fargo']])('bank name %s reads as %s', async (raw, shown) => {
  const { bankDisplayName } = await import('./PaymentMethodsPage');
  expect(bankDisplayName(raw)).toBe(shown);
});
