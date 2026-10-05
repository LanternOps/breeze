// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiGet, apiPost } from '@/lib/api';
import AutopaySetupPage from './AutopaySetupPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });

const cardText = 'I authorize Example MSP to save this card and use it to pay future invoices automatically.';
const bankText = 'I authorize Example MSP to save this US bank account and to initiate ACH debits from it.';
const schedule = { offsetDays: 0, rule: 'later', cap: { enabled: false } };
const card = { text: cardText, hash: 'a'.repeat(64), feeText: 'Card fee text', scheduleTerms: schedule };
const bank = { text: bankText, hash: 'b'.repeat(64), feeText: 'Bank fee text', scheduleTerms: schedule };
function page(over: Record<string, unknown> = {}) {
  return { data: { partnerName: 'Example MSP', logoUrl: null, supportEmail: 'billing@msp.example', scheduleText: 'Old schedule sentence.',
    achMode: 'ach_preferred', enrollment: { status: 'requested' }, method: null, disclosures: { card, us_bank_account: bank },
    fees: { card: { kind: 'card_percent', feeAmount: '3.00', appliedBps: 300 }, debit: { kind: 'none', feeAmount: '0.00' },
      us_bank_account: { kind: 'ach_flat', feeAmount: '1.00' } }, ...over } } as never;
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(apiGet).mockResolvedValue(page()); });

describe('setup page', () => {
  it('opens as the MSP asking, with the terms at a glance instead of the schedule paragraph twice', async () => {
    render(<AutopaySetupPage token="test-token" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Pay future invoices automatically' })).toBeInTheDocument();
    expect(screen.getAllByText('Example MSP').length).toBeGreaterThan(0);
    expect(screen.getByText("On each invoice's due date")).toBeInTheDocument();
    expect(screen.queryByText('Old schedule sentence.')).toBeNull();
    expect(screen.queryByText(/This applies to new invoices after enrollment/)).toBeNull();
    expect(screen.getByRole('link', { name: 'billing@msp.example' })).toBeInTheDocument();
    expect(document.querySelector('main')).toBeNull();
    // V-38: plain labels.
    expect(screen.getByText('Notice')).toBeInTheDocument();
    expect(screen.getByText('Control')).toBeInTheDocument();
    expect(screen.queryByText('Your say')).toBeNull();
  });

  it('names each method with its fee and only recommends bank when it is not the dearer option', async () => {
    render(<AutopaySetupPage token="test-token" />);
    expect(await screen.findByTestId('autopay-fee-us_bank_account')).toHaveTextContent('$1.00 fee');
    expect(screen.getByTestId('autopay-fee-card')).toHaveTextContent('Credit cards: up to 3% fee');
    expect(screen.getByText('Recommended by Example MSP')).toBeInTheDocument();
    expect(screen.getByTestId('autopay-method-us_bank_account')).toBeChecked();
    cleanup();
    vi.mocked(apiGet).mockResolvedValue(page({ fees: { card: { kind: 'none', feeAmount: '0.00', appliedBps: null },
      debit: { kind: 'none', feeAmount: '0.00' }, us_bank_account: { kind: 'ach_flat', feeAmount: '1.00' } } }));
    render(<AutopaySetupPage token="test-token" />);
    expect(await screen.findByTestId('autopay-fee-card')).toHaveTextContent('No fee');
    expect(screen.queryByText('Recommended by Example MSP')).toBeNull();
  });

  it('shows the full authorization beside its checkbox and re-asks when the method changes', async () => {
    render(<AutopaySetupPage token="test-token" />);
    expect(await screen.findByTestId('autopay-consent-text')).toHaveTextContent(bankText);
    const submit = screen.getByTestId('autopay-setup-submit');
    expect(submit).toBeDisabled();
    expect(screen.getByText('Tick the box above to continue.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('autopay-consent'));
    expect(submit).toBeEnabled();
    fireEvent.click(screen.getByTestId('autopay-method-card'));
    expect(screen.getByTestId('autopay-consent-text')).toHaveTextContent(cardText);
    expect(screen.getByTestId('autopay-consent')).not.toBeChecked();
    expect(screen.getByText('The authorization changed. Please read it and agree again.')).toBeInTheDocument();
  });

  it('stores who is asking for the return page (V-19)', async () => {
    vi.mocked(apiPost).mockResolvedValue({ data: { url: 'https://checkout.stripe.com/c/pay/x' } } as never);
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as never);
    render(<AutopaySetupPage token="test-token" />);
    fireEvent.click(await screen.findByTestId('autopay-consent'));
    fireEvent.click(screen.getByTestId('autopay-setup-submit'));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(JSON.parse(sessionStorage.getItem('autopay-return-branding')!)).toEqual({ partnerName: 'Example MSP', logoUrl: null, supportEmail: 'billing@msp.example' });
  });
  it('sends the displayed terms once, stores the return token and opens Stripe', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as never);
    let resolve!: (value: unknown) => void;
    vi.mocked(apiPost).mockReturnValue(new Promise(r => { resolve = r; }) as never);
    render(<AutopaySetupPage token="test-token" />);
    fireEvent.click(await screen.findByTestId('autopay-consent'));
    fireEvent.click(screen.getByTestId('autopay-setup-submit'));
    fireEvent.click(screen.getByTestId('autopay-setup-submit'));
    expect(screen.getByTestId('autopay-setup-submit')).toHaveTextContent('Opening Stripe…');
    resolve({ data: { url: 'https://checkout.stripe.com/c/pay' } });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay'));
    expect(apiPost).toHaveBeenCalledExactlyOnceWith('/autopay/public/test-token/setup-session',
      { methodType: 'us_bank_account', consentAccepted: true, disclosureHash: bank.hash }, { redirectOnUnauthorized: false });
    expect(sessionStorage.getItem('autopay-return-token')).toBe('test-token');
  });

  it('terms changed on the server: warns, reloads the terms and asks again', async () => {
    vi.mocked(apiPost).mockResolvedValue({ error: 'The terms changed. Review them and try again.', statusCode: 409, code: 'INVALID_STATE',
      errorDetails: { reason: 'terms_changed' } } as never);
    render(<AutopaySetupPage token="test-token" />);
    fireEvent.click(await screen.findByTestId('autopay-consent'));
    fireEvent.click(screen.getByTestId('autopay-setup-submit'));
    expect(await screen.findByText('Example MSP updated these terms a moment ago.')).toBeInTheDocument();
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('autopay-consent')).not.toBeChecked();
  });

  it('any other failure keeps the agreement and offers a retry', async () => {
    vi.mocked(apiPost).mockResolvedValue({ error: 'boom', statusCode: 500 } as never);
    render(<AutopaySetupPage token="test-token" />);
    fireEvent.click(await screen.findByTestId('autopay-consent'));
    fireEvent.click(screen.getByTestId('autopay-setup-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't open Stripe's secure page.");
    expect(screen.getByTestId('autopay-consent')).toBeChecked();
    expect(screen.getByTestId('autopay-setup-submit')).toBeEnabled();
  });

  it('ACH-only shows bank as a single method; card-only shows card', async () => {
    vi.mocked(apiGet).mockResolvedValue(page({ achMode: 'ach_only' }));
    render(<AutopaySetupPage token="test-token" />);
    expect(await screen.findByTestId('autopay-fee-us_bank_account')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByTestId('autopay-fee-card')).toBeNull();
    cleanup();
    vi.mocked(apiGet).mockResolvedValue(page({ achMode: 'card_only' }));
    render(<AutopaySetupPage token="test-token" />);
    expect(await screen.findByTestId('autopay-consent-text')).toHaveTextContent(cardText);
  });

  it('an unusable link explains itself instead of "not found"', async () => {
    vi.mocked(apiGet).mockResolvedValue({ error: 'This link was already used.', code: 'link_used', statusCode: 404,
      errorData: { partnerName: 'Example MSP', enrollmentStatus: 'active' } } as never);
    render(<AutopaySetupPage token="test-token" />);
    expect(await screen.findByRole('heading', { name: "You're already set up" })).toBeInTheDocument();
  });

  it('a load failure offers a refresh', async () => {
    vi.mocked(apiGet).mockResolvedValue({ error: 'Network error' } as never);
    render(<AutopaySetupPage token="test-token" />);
    expect(await screen.findByRole('heading', { name: "We couldn't load this page" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});

describe('changing an existing method (card-expiring link or portal)', () => {
  const active = page({ enrollment: { status: 'active' },
    method: { type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242', status: 'active' } });
  it('says what it replaces and preselects the current method type (P-4)', async () => {
    vi.mocked(apiGet).mockResolvedValue(active);
    render(<AutopaySetupPage token="test-token" />);
    expect(await screen.findByRole('heading', { name: 'Change your payment method' })).toBeInTheDocument();
    expect(screen.getByText(/replaces your Visa credit card ending in 4242/)).toBeInTheDocument();
    expect(screen.getByTestId('autopay-method-card')).toBeChecked();
    // V-38: a change applies to payments not yet started, and the tab says so.
    expect(screen.getByText('Payments not yet started')).toBeInTheDocument();
    expect(screen.queryByText(/Issued after you set this up/)).toBeNull();
    expect(document.title).toBe('Change payment method');
  });
  it('in the portal: an inline form with a Cancel, posting to the portal route', async () => {
    vi.mocked(apiGet).mockResolvedValue(active);
    const onCancel = vi.fn();
    render(<AutopaySetupPage portal onCancel={onCancel} />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Change your payment method' })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/portal/payment-methods', { redirectOnUnauthorized: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
  it('switched off in the portal: no form, a plain explanation', async () => {
    vi.mocked(apiGet).mockResolvedValue({ data: { stopOnly: true, partnerName: 'Example MSP', enrollment: { status: 'active' }, method: null } } as never);
    render(<AutopaySetupPage portal />);
    expect(await screen.findByText("Changing your payment method isn't available right now.")).toBeInTheDocument();
    expect(screen.queryByTestId('autopay-setup-submit')).toBeNull();
  });
});

// R6: only a changed terms hash reloads and re-asks; every other refusal says setup can't happen
// right now and who to ask, instead of looping on "updated these terms".
describe('setup refusals other than changed terms', () => {
  it.each(['Stripe account is not ready', 'Stripe connection changed', 'Payment method unavailable', 'Request automatic payments first', 'Automatic payment setup was cancelled'])(
    '%s: a plain "can\'t set up right now" with the MSP to contact, and no reload', async message => {
      vi.mocked(apiPost).mockResolvedValue({ error: message, statusCode: 409, code: 'INVALID_STATE' } as never);
      render(<AutopaySetupPage token="test-token" />);
      fireEvent.click(await screen.findByTestId('autopay-consent'));
      fireEvent.click(screen.getByTestId('autopay-setup-submit'));
      expect(await screen.findByRole('heading', { name: "Automatic payments can't be set up right now" })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Email Example MSP' })).toHaveAttribute('href', 'mailto:billing@msp.example');
      expect(screen.queryByText(/updated these terms/)).toBeNull();
      expect(apiGet).toHaveBeenCalledTimes(1);
    });
  it('a terms reload keeps the method the client chose', async () => {
    vi.mocked(apiPost).mockResolvedValue({ error: 'The terms changed.', statusCode: 409, code: 'INVALID_STATE', errorDetails: { reason: 'terms_changed' } } as never);
    render(<AutopaySetupPage token="test-token" />);
    fireEvent.click(await screen.findByTestId('autopay-method-card'));
    fireEvent.click(screen.getByTestId('autopay-consent'));
    fireEvent.click(screen.getByTestId('autopay-setup-submit'));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await screen.findByText('Example MSP updated these terms a moment ago.');
    expect(screen.getByTestId('autopay-method-card')).toBeChecked();
    expect(screen.getByTestId('autopay-consent-text')).toHaveTextContent(cardText);
  });
});
