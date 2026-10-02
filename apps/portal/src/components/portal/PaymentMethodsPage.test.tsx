// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiGet, apiPost } from '@/lib/api';
import PaymentMethodsPage from './PaymentMethodsPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(cleanup);
it('shows pending verification and confirms stop before POST', async () => {
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', achMode: 'ach_only', scheduleText: 'Due date',
    enrollment: { status: 'active' }, method: { type: 'us_bank_account', bankName: 'Test bank', bankLast4: '6789', status: 'pending_verification' }, disclosures: {} } });
  render(<PaymentMethodsPage />);
  expect(await screen.findByTestId('autopay-payment-methods')).toHaveTextContent('Verification pending');
  fireEvent.click(screen.getByTestId('autopay-portal-stop'));
  expect(apiPost).not.toHaveBeenCalled();
  expect(await screen.findByTestId('autopay-stop-confirm')).toHaveTextContent('cannot be recalled');
});
