// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiGet, apiPost } from '@/lib/api';
import AutopaySetupPage from './AutopaySetupPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(cleanup);
const disclosure = { text: 'I authorize Example MSP under these schedule terms.', hash: 'a'.repeat(64), feeText: 'No fee applies.' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', logoUrl: null,
    scheduleText: 'Invoices are charged on the later date.', achMode: 'ach_only', enrollment: { status: 'requested' }, method: null,
    disclosures: { card: disclosure, us_bank_account: disclosure } } });
});
it('ACH-only never offers card, requires consent, and reports stale terms', async () => {
  vi.mocked(apiPost).mockResolvedValue({ error: 'Terms changed. Reload this page.', statusCode: 409 });
  render(<AutopaySetupPage token="test-token" />);
  expect(await screen.findByTestId('autopay-method-us_bank_account')).toBeChecked();
  expect(screen.queryByTestId('autopay-method-card')).toBeNull();
  expect(screen.getByTestId('autopay-setup-submit')).toBeDisabled();
  fireEvent.click(screen.getByTestId('autopay-consent'));
  fireEvent.click(screen.getByTestId('autopay-setup-submit'));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/autopay/public/test-token/setup-session',
    { methodType: 'us_bank_account', consentAccepted: true, disclosureHash: disclosure.hash }, { redirectOnUnauthorized: false }));
  expect(await screen.findByTestId('autopay-feedback')).toHaveTextContent('Terms changed');
});
it('a scanner mounting the stop page never stops payments', async () => {
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', orgName: 'Example client', processingWarning: true } });
  render(<AutopaySetupPage token="stop-token" mode="stop" />);
  expect(await screen.findByTestId('autopay-stop-confirm')).toBeTruthy();
  expect(apiPost).not.toHaveBeenCalled();
  vi.mocked(apiPost).mockResolvedValue({ data: { success: true } });
  fireEvent.click(screen.getByTestId('autopay-stop-submit'));
  await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
});
it('a return page does not activate on mount and distinguishes debit fee outcome', async () => {
  window.history.replaceState({}, '', '/autopay/return?target=public&session_id=cs_test_1');
  sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue({ data: { outcome: 'activated', orgId: 'org', methodLabel: 'Visa debit ••1234', feeText: 'No fee applies.' } });
  render(<AutopaySetupPage mode="return" />);
  expect(apiPost).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('autopay-return-submit'));
  expect(await screen.findByTestId('autopay-return-outcome')).toHaveTextContent('Visa debit ••1234 — No fee applies.');
  expect(apiPost).toHaveBeenCalledWith('/autopay/public/setup-return', { checkoutSessionId: 'cs_test_1', token: 'test-token' }, { redirectOnUnauthorized: false });
});
it('uses the actual Stripe portal return target and never sends a public token', async () => {
  window.history.replaceState({}, '', '/autopay/return?target=portal&session_id=cs_test_2');
  sessionStorage.setItem('autopay-return-token', 'another-public-tab');
  vi.mocked(apiPost).mockResolvedValue({ data: { outcome: 'pending_verification', orgId: 'org', methodLabel: 'Bank ••6789', feeText: 'No fee applies.' } });
  render(<AutopaySetupPage mode="return" />);
  fireEvent.click(screen.getByTestId('autopay-return-submit'));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/portal/payment-methods/setup-return', { checkoutSessionId: 'cs_test_2' }, { redirectOnUnauthorized: true }));
});
