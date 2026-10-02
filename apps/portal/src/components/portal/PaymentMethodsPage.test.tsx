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
  expect(await screen.findByTestId('autopay-payment-methods')).toHaveTextContent('Automatic payments: active');
  fireEvent.click(screen.getByTestId('autopay-portal-stop'));
  await screen.findByTestId('autopay-stop-confirm');
  expect(apiPost).not.toHaveBeenCalled();
  vi.mocked(apiGet).mockResolvedValue({ data: { ...data, enrollment: { status: 'cancelled' } } });
  vi.mocked(apiPost).mockResolvedValue({ data: { success: true } });
  fireEvent.click(screen.getByTestId('autopay-stop-submit'));
  await waitFor(() => expect(screen.getByTestId('autopay-payment-methods')).toHaveTextContent('Automatic payments: cancelled'));
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
