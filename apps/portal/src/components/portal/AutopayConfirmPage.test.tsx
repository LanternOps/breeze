// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from '@/lib/api';
import { navigateTo } from '@/lib/navigation';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import AutopayConfirmPage from './AutopayConfirmPage';
afterEach(() => { cleanup(); });
function view(over: Record<string, unknown> = {}) {
  return { data: { state: 'requires_action', amount: '100.00', currency: 'USD', invoiceNumber: 'INV-7', methodLabel: 'Visa credit card ending in 3184',
    invoiceUrl: 'https://portal.example.test/portal/invoice/tok', partnerName: 'Example MSP', logoUrl: null, supportEmail: 'billing@msp.example', ...over } } as never;
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(apiGet).mockResolvedValue(view()); });

it('explains what confirming means, then continues to pay on the invoice page only on click', async () => {
  render(<AutopayConfirmPage token="token" />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Confirm your payment for invoice INV-7' })).toBeInTheDocument();
  expect(screen.getByText(/Your bank asked you to confirm the \$100\.00 payment with your Visa credit card ending in 3184/)).toBeInTheDocument();
  expect(screen.getByText('Nothing has been charged yet.', { exact: false })).toBeInTheDocument();
  expect(apiPost).not.toHaveBeenCalled();
  vi.mocked(apiPost).mockResolvedValue({ data: { url: 'https://portal.example.test/portal/invoice/tok' } } as never);
  fireEvent.click(screen.getByTestId('autopay-confirm-submit'));
  await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('https://portal.example.test/portal/invoice/tok'));
  expect(apiPost).toHaveBeenCalledExactlyOnceWith('/autopay/public/token/confirm', {}, { redirectOnUnauthorized: false });
});

it.each([
  [{ data: { processing: true } }, 'Your payment is processing'],
  [{ data: { paid: true } }, 'Payment received'],
  [{ data: { notNeeded: true } }, 'No action needed'],
  [{ error: 'Payment received but needs billing review', statusCode: 409, code: 'INVALID_STATE' }, 'We received your payment'],
  [{ error: 'Payment is still processing', statusCode: 409, code: 'INVALID_STATE' }, 'Your payment is processing'],
])('lands %j', async (response, title) => {
  vi.mocked(apiPost).mockResolvedValue(response as never);
  render(<AutopayConfirmPage token="token" />);
  fireEvent.click(await screen.findByTestId('autopay-confirm-submit'));
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-confirm-submit')).toBeNull();
});

it.each([['processing', 'Your payment is processing'], ['succeeded', 'Payment received'], ['not_needed', 'No action needed']])(
  'a %s attempt needs no click', async (state, title) => {
    vi.mocked(apiGet).mockResolvedValue(view({ state }));
    render(<AutopayConfirmPage token="token" />);
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.queryByTestId('autopay-confirm-submit')).toBeNull();
  });

it('a server failure keeps the action and points at the invoice', async () => {
  vi.mocked(apiPost).mockResolvedValue({ error: 'Payment could not be confirmed.', statusCode: 500 } as never);
  render(<AutopayConfirmPage token="token" />);
  fireEvent.click(await screen.findByTestId('autopay-confirm-submit'));
  expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't confirm the payment right now");
  expect(screen.getByTestId('autopay-confirm-submit')).toBeEnabled();
});

it('an unusable link explains itself', async () => {
  vi.mocked(apiGet).mockResolvedValue({ error: 'x', code: 'link_used', statusCode: 404, errorData: { partnerName: 'Example MSP', enrollmentStatus: 'active' } } as never);
  render(<AutopayConfirmPage token="token" />);
  expect(await screen.findByRole('heading', { name: 'This link was already used' })).toBeInTheDocument();
});
