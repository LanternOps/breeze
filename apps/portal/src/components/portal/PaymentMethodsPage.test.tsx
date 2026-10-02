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
