// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiGet, apiPost } from '@/lib/api';
import PaymentMethodsPage from './PaymentMethodsPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());
it('shows pending verification and confirms stop before POST', async () => {
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', achMode: 'ach_only', scheduleText: 'Due date',
    enrollment: { status: 'active' }, method: { type: 'us_bank_account', bankName: 'Test bank', bankLast4: '6789', status: 'pending_verification' }, disclosures: {} } });
  render(<PaymentMethodsPage />);
  expect(await screen.findByTestId('autopay-payment-methods')).toHaveTextContent('Verification pending');
  fireEvent.click(screen.getByTestId('autopay-portal-stop'));
  expect(apiPost).not.toHaveBeenCalled();
  expect(await screen.findByTestId('autopay-stop-confirm')).toHaveTextContent('cannot be recalled');
});

it('refreshes the summary after stopping and retains success feedback', async () => {
  const data = { partnerName: 'Example MSP', achMode: 'ach_only', scheduleText: 'Due date',
    enrollment: { status: 'active' }, method: null, disclosures: {} };
  vi.mocked(apiGet).mockResolvedValue({ data });
  render(<PaymentMethodsPage />);
  expect(await screen.findByTestId('autopay-payment-methods')).toHaveTextContent('Automatic payments: Active');
  fireEvent.click(screen.getByTestId('autopay-portal-stop'));
  await screen.findByTestId('autopay-stop-confirm');
  expect(apiPost).not.toHaveBeenCalled();
  vi.mocked(apiGet).mockResolvedValue({ data: { ...data, enrollment: { status: 'cancelled' } } });
  vi.mocked(apiPost).mockResolvedValue({ data: { success: true } });
  fireEvent.click(screen.getByTestId('autopay-stop-submit'));
  await waitFor(() => expect(screen.getByTestId('autopay-payment-methods')).toHaveTextContent('Automatic payments: Stopped'));
  expect(apiPost).toHaveBeenCalledWith('/portal/autopay/stop', {}, { redirectOnUnauthorized: true });
  expect(apiGet).toHaveBeenCalledTimes(3);
  expect(screen.queryByTestId('autopay-update-method')).toBeNull();
  expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
  if (screen.queryByTestId('autopay-back')) fireEvent.click(screen.getByTestId('autopay-back'));
  expect(screen.getByTestId('autopay-payment-methods')).toHaveTextContent('Automatic payments stopped.');
});

it.each(['active','requested','paused','verification_failed'])('offers only Stop for disabled partner with %s enrollment',async status=>{
  vi.mocked(apiGet).mockResolvedValue({statusCode:200,data:{stopOnly:true,partnerName:'Example MSP',enrollment:{status},method:{type:'card',cardLast4:'1234',status:'active'}}});
  render(<PaymentMethodsPage/>);
  expect(await screen.findByTestId('autopay-saved-method')).toHaveTextContent('1234');
  expect(screen.queryByTestId('autopay-update-method')).toBeNull();
  expect(screen.queryByText('Ask your service provider to send an automatic payment request.')).toBeNull();
  fireEvent.click(screen.getByTestId('autopay-portal-stop'));
  expect(await screen.findByTestId('autopay-stop-confirm')).toHaveTextContent('Example MSP');
  expect(apiPost).not.toHaveBeenCalled();
  vi.mocked(apiPost).mockResolvedValue({data:{success:true}});
  vi.mocked(apiGet).mockResolvedValue({statusCode:404,error:'Automatic payments are not enabled'});
  fireEvent.click(screen.getByTestId('autopay-stop-submit'));
  expect(await screen.findByTestId('autopay-stop-feedback')).toHaveTextContent('Automatic payments stopped');
  expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
  expect(screen.queryByTestId('autopay-payment-methods-error')).toBeNull();
  expect(apiPost).toHaveBeenCalledExactlyOnceWith('/portal/autopay/stop',{}, {redirectOnUnauthorized:true});
});
it('offers no actions when disabled with no live enrollment',async()=>{
  vi.mocked(apiGet).mockResolvedValue({statusCode:404,error:'Automatic payments are not enabled'});
  render(<PaymentMethodsPage/>);
  await screen.findByTestId('autopay-payment-methods-error');
  expect(screen.queryByTestId('autopay-update-method')).toBeNull();expect(screen.queryByTestId('autopay-portal-stop')).toBeNull();
});

function page(enrollment: Record<string, unknown> | null, method: Record<string, unknown> | null = null, extra: Record<string, unknown> = {}) {
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', achMode: 'ach_preferred', scheduleText: 'Due date',
    enrollment, method, disclosures: {}, ...extra } });
  render(<PaymentMethodsPage />);
}
it.each([
  ['active', 'Active'], ['paused', 'Paused by your provider'], ['cancelled', 'Stopped'], ['requested', 'Requested'],
])('labels a %s enrollment for people, never with the internal code', async (status, label) => {
  page({ status, needsAttentionReason: null }, { type: 'card', cardBrand: 'visa', cardLast4: '4242', status: 'active' });
  expect(await screen.findByTestId('autopay-status')).toHaveTextContent(`Automatic payments: ${label}`);
  if (status !== label.toLowerCase()) expect(screen.getByTestId('autopay-status').textContent).not.toContain(status);
});
it('explains an unusable saved method instead of contradicting "Active" with "No payment method on file"', async () => {
  page({ status: 'active', needsAttentionReason: 'method_unusable' });
  expect(await screen.findByTestId('autopay-needs-attention')).toHaveTextContent(
    "Your saved payment method can't be used for automatic payments. Update it to keep them working.");
  expect(screen.getByTestId('autopay-payment-methods')).not.toHaveTextContent('No payment method on file');
  expect(screen.getByTestId('autopay-payment-methods')).not.toHaveTextContent('method_unusable');
  expect(screen.getByTestId('autopay-update-method')).toHaveTextContent('Update payment method');
});
it('explains failed bank verification with the update action', async () => {
  page({ status: 'active', needsAttentionReason: 'verification_failed' });
  expect(await screen.findByTestId('autopay-needs-attention')).toHaveTextContent("We couldn't verify your bank account");
  expect(screen.getByTestId('autopay-needs-attention')).toHaveTextContent('Update your payment method to keep them working.');
  expect(screen.getByTestId('autopay-update-method')).toBeTruthy();
  expect(screen.getByTestId('autopay-payment-methods')).not.toHaveTextContent('verification_failed');
});
it.each(['stripe_account_changed', 'key_missing_permissions'])('explains a provider-side %s hold without an update action that would fail', async reason => {
  page({ status: 'active', needsAttentionReason: reason }, { type: 'card', cardBrand: 'visa', cardLast4: '4242', status: 'active' });
  expect(await screen.findByTestId('autopay-needs-attention')).toHaveTextContent(
    'Automatic payments are on hold while your service provider fixes its payment setup. No action is needed from you.');
  expect(screen.queryByTestId('autopay-update-method')).toBeNull();
  expect(screen.getByTestId('autopay-payment-methods')).not.toHaveTextContent(reason);
  expect(screen.getByTestId('autopay-saved-method')).toHaveTextContent('4242');
});
it('points a paused client with an unusable method to the provider (portal updates are refused while paused)', async () => {
  page({ status: 'paused', needsAttentionReason: 'method_unusable' });
  expect(await screen.findByTestId('autopay-needs-attention')).toHaveTextContent(
    "Your saved payment method can't be used for automatic payments. Contact your service provider to update it.");
  expect(screen.queryByTestId('autopay-update-method')).toBeNull();
  expect(screen.getByTestId('autopay-payment-methods')).toHaveTextContent('Your service provider has paused automatic payments.');
  expect(screen.getByTestId('autopay-payment-methods')).not.toHaveTextContent('send an automatic payment request');
});
it('shows no needs-attention notice once automatic payments are stopped', async () => {
  page({ status: 'cancelled', needsAttentionReason: 'method_unusable' });
  expect(await screen.findByTestId('autopay-status')).toHaveTextContent('Automatic payments: Stopped');
  expect(screen.queryByTestId('autopay-needs-attention')).toBeNull();
});
