// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiGet, apiPost } from '@/lib/api';
import AutopaySetupPage from './AutopaySetupPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
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

it('portal confirmation does not access unavailable session storage', async () => {
  window.history.replaceState({}, '', '/autopay/return?target=portal&session_id=cs_portal');
  const storage = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });
  vi.mocked(apiPost).mockResolvedValue({ data: { outcome: 'activated', orgId: 'org', methodLabel: 'Card', feeText: 'No fee applies.' } });
  render(<AutopaySetupPage mode="return" />);
  fireEvent.click(screen.getByTestId('autopay-return-submit'));
  expect(await screen.findByTestId('autopay-return-outcome')).toHaveTextContent('Automatic payments are set up');
  expect(storage).not.toHaveBeenCalled();
  expect(apiPost).toHaveBeenCalledWith('/portal/payment-methods/setup-return', { checkoutSessionId: 'cs_portal' }, { redirectOnUnauthorized: true });
});
it('public storage read failure reports feedback and allows retry', async () => {
  window.history.replaceState({}, '', '/autopay/return?target=public&session_id=cs_public');
  sessionStorage.setItem('autopay-return-token', 'test-token');
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  render(<AutopaySetupPage mode="return" />);
  fireEvent.click(screen.getByTestId('autopay-return-submit'));
  expect(await screen.findByTestId('autopay-feedback')).toHaveTextContent('Enable session storage');
  expect(screen.getByTestId('autopay-return-submit')).toBeEnabled();
  expect(apiPost).not.toHaveBeenCalled();
  read.mockRestore();
  vi.mocked(apiPost).mockResolvedValue({ data: { outcome: 'activated', orgId: 'org', methodLabel: 'Card', feeText: 'No fee applies.' } });
  fireEvent.click(screen.getByTestId('autopay-return-submit'));
  expect(await screen.findByTestId('autopay-return-outcome')).toHaveTextContent('Automatic payments are set up');
});
it('public storage removal failure preserves the confirmed outcome and reports feedback', async () => {
  window.history.replaceState({}, '', '/autopay/return?target=public&session_id=cs_public');
  sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.mocked(apiPost).mockResolvedValue({ data: { outcome: 'activated', orgId: 'org', methodLabel: 'Card', feeText: 'No fee applies.' } });
  render(<AutopaySetupPage mode="return" />);
  fireEvent.click(screen.getByTestId('autopay-return-submit'));
  expect(await screen.findByTestId('autopay-return-outcome')).toHaveTextContent('Automatic payments are set up');
  expect(screen.getByTestId('autopay-feedback')).toHaveTextContent('could not clear');
  expect(apiPost).toHaveBeenCalledTimes(1);
});
it.each(['in_progress','abandoned'])('renders %s honestly with a next action',async outcome=>{
 window.history.replaceState({},'', '/autopay/return?target=public&session_id=cs_test');sessionStorage.setItem('autopay-return-token','test-token');
 vi.mocked(apiPost).mockResolvedValue({data:{outcome,orgId:'org',methodLabel:null,feeText:''}});
 render(<AutopaySetupPage mode="return"/>);fireEvent.click(screen.getByTestId('autopay-return-submit'));
 expect(await screen.findByTestId('autopay-return-outcome')).toHaveTextContent(outcome==='in_progress'?'Your setup is still being confirmed — check back shortly':'This setup session expired — start again');
 if(outcome==='in_progress'){expect(sessionStorage.getItem('autopay-return-token')).toBe('test-token');expect(screen.getByTestId('autopay-return-submit')).toBeEnabled();}
 else expect(screen.getByTestId('autopay-restart')).toHaveAttribute('href','/portal/autopay/test-token');
});
