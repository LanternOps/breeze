// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiGet, apiPost } from '@/lib/api';
import AutopayStopPage from './AutopayStopPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(() => cleanup());
const card = { type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242', status: 'active' };
const bank = { type: 'us_bank_account', bankName: 'STRIPE TEST BANK', bankLast4: '6789', status: 'active' };
function view(over: Record<string, unknown> = {}) {
  return { data: { partnerName: 'Example MSP', logoUrl: null, supportEmail: 'billing@msp.example', orgName: 'Client',
    processingWarning: 'x', enrollment: { status: 'active' }, method: card, openInvoiceCount: 2, ...over } } as never;
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(apiGet).mockResolvedValue(view()); });

it('asks plainly, says what stopping does, and only stops on click', async () => {
  render(<AutopayStopPage token="stop-token" />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Stop automatic payments to Example MSP?' })).toBeInTheDocument();
  expect(screen.getByText('Visa credit card ending in 4242')).toBeInTheDocument();
  expect(screen.getByText("Future invoices won't be charged automatically.")).toBeInTheDocument();
  expect(screen.getByText('Your saved card will be removed.')).toBeInTheDocument();
  expect(screen.getByText("A payment that has already started can't be stopped.")).toBeInTheDocument();
  expect(apiGet).toHaveBeenCalledExactlyOnceWith('/autopay/public/stop-token/stop', { redirectOnUnauthorized: false });
  expect(apiPost).not.toHaveBeenCalled();
  expect(document.querySelector('main')).toBeNull();
});

it('stops once and replaces the question with the outcome (no lingering button, D-15)', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(apiPost).mockReturnValue(new Promise(r => { resolve = r; }) as never);
  render(<AutopayStopPage token="stop-token" />);
  const stop = await screen.findByTestId('autopay-stop-submit');
  fireEvent.click(stop); fireEvent.click(stop);
  expect(stop).toHaveTextContent('Stopping…');
  resolve({ data: { success: true } });
  expect(await screen.findByRole('heading', { name: 'Automatic payments are off' })).toBeInTheDocument();
  expect(apiPost).toHaveBeenCalledExactlyOnceWith('/autopay/public/stop-token/stop', {}, { redirectOnUnauthorized: false });
  expect(screen.queryByTestId('autopay-stop-submit')).toBeNull();
  expect(screen.getByText(/We're emailing you a confirmation, with links to your open invoices/)).toBeInTheDocument();
});

it('"Keep them on" changes nothing and says so', async () => {
  render(<AutopayStopPage token="stop-token" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Keep them on' }));
  expect(await screen.findByRole('heading', { name: 'Nothing changed' })).toBeInTheDocument();
  expect(apiPost).not.toHaveBeenCalled();
});

it('a bank account: names it and warns that a started debit takes days', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ method: bank }));
  render(<AutopayStopPage token="stop-token" />);
  expect(await screen.findByText('Your saved bank account will be removed.')).toBeInTheDocument();
  expect(screen.getByText(/Bank payments that have started can take a few business days to finish/)).toBeInTheDocument();
});

it('never enrolled: nothing to stop, no stop button (D-15)', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ enrollment: { status: 'requested' }, method: null }));
  render(<AutopayStopPage token="stop-token" />);
  expect(await screen.findByRole('heading', { name: "You haven't set up automatic payments" })).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-stop-submit')).toBeNull();
});

it('paused by the MSP can still be stopped', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ enrollment: { status: 'paused' } }));
  render(<AutopayStopPage token="stop-token" />);
  expect(await screen.findByText(/Example MSP has already paused your automatic payments/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Keep them paused' })).toBeInTheDocument();
});

it('already off: says so, no button', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ enrollment: { status: 'cancelled' }, method: null }));
  render(<AutopayStopPage token="stop-token" />);
  expect(await screen.findByRole('heading', { name: 'Automatic payments are off' })).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-stop-submit')).toBeNull();
});

it('a stop link reloaded after stopping explains itself instead of "not found"', async () => {
  vi.mocked(apiGet).mockResolvedValue({ error: 'x', code: 'link_used', statusCode: 404, errorData: { partnerName: 'Example MSP', enrollmentStatus: 'cancelled' } } as never);
  render(<AutopayStopPage token="stop-token" />);
  expect(await screen.findByRole('heading', { name: 'Automatic payments are off' })).toBeInTheDocument();
});

it('a failed stop keeps the question and offers a retry', async () => {
  vi.mocked(apiPost).mockResolvedValue({ error: 'boom', statusCode: 500 } as never);
  render(<AutopayStopPage token="stop-token" />);
  fireEvent.click(await screen.findByTestId('autopay-stop-submit'));
  expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't stop automatic payments");
  await waitFor(() => expect(screen.getByTestId('autopay-stop-submit')).toBeEnabled());
});
