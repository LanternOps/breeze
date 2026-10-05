// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from '@/lib/api';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
import AutopaySkipPage from './AutopaySkipPage';
afterEach(() => { cleanup(); });
function view(over: Record<string, unknown> = {}) {
  return { data: { status: 'ready', state: 'scheduled', control: null, processing: false, invoiceNumber: 'INV-2026-0003', invoiceStatus: 'sent',
    dueDate: '2026-10-08', collectOn: '2026-11-04', amount: '50.00', fee: '1.50', currency: 'USD',
    methodLabel: 'Visa credit card ending in 4242', methodType: 'card', invoiceUrl: 'https://portal.example.test/portal/invoice/inv-token',
    partnerName: 'Example MSP', logoUrl: null, supportEmail: 'billing@msp.example', ...over } } as never;
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(apiGet).mockResolvedValue(view()); });

it('names the invoice, amount, fee, date and method before asking, and skips only on click', async () => {
  render(<AutopaySkipPage token="opaque-token" />);
  expect(await screen.findByRole('heading', { level: 1, name: 'Skip the automatic payment for invoice INV-2026-0003?' })).toBeInTheDocument();
  expect(screen.getByText('$50.00')).toBeInTheDocument();
  expect(screen.getByText('up to $1.50')).toBeInTheDocument();
  expect(screen.getByText('November 4, 2026')).toBeInTheDocument();
  expect(screen.getByText('Visa credit card ending in 4242')).toBeInTheDocument();
  expect(screen.getByText(/Please pay it yourself by its due date, October 8, 2026/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View invoice' })).toHaveAttribute('href', 'https://portal.example.test/portal/invoice/inv-token');
  expect(apiGet).toHaveBeenCalledWith('/autopay/public/opaque-token/skip', { redirectOnUnauthorized: false });
  expect(apiPost).not.toHaveBeenCalled();
  vi.mocked(apiPost).mockResolvedValue({ data: { status: 'skipped' } } as never);
  fireEvent.click(screen.getByTestId('autopay-skip-submit'));
  expect(await screen.findByRole('heading', { name: 'This payment is skipped' })).toBeInTheDocument();
  expect(apiPost).toHaveBeenCalledExactlyOnceWith('/autopay/public/opaque-token/skip', {}, { redirectOnUnauthorized: false });
  expect(screen.getByRole('link', { name: 'Pay invoice now' })).toHaveAttribute('href', 'https://portal.example.test/portal/invoice/inv-token');
  expect(screen.queryByTestId('autopay-skip-submit')).toBeNull();
});

it('omits a zero fee', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ fee: '0.00' }));
  render(<AutopaySkipPage token="t" />);
  await screen.findByText('$50.00');
  expect(screen.queryByText('Fee')).toBeNull();
});

it('a payment already with Stripe: says it has started, and offers no skip', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ status: 'processing', state: 'collecting', processing: true, methodType: 'us_bank_account', methodLabel: 'Bank account ending in 6789' }));
  render(<AutopaySkipPage token="t" />);
  expect(await screen.findByRole('heading', { name: 'This payment has already started' })).toBeInTheDocument();
  expect(screen.getByText(/Bank payments usually take a few business days to finish/)).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-skip-submit')).toBeNull();
});

// #7983: the 409 code is shared; only details.reason 'payment_processing' promises a receipt.
it.each([
  [{ reason: 'payment_processing' }, 'This payment has already started', /You'll get a receipt when it completes/],
  [{ reason: 'control_pending' }, 'This payment is already being changed', /Check your email for an update, or contact Example MSP/],
  [undefined, 'This payment is already being changed', /Check your email for an update, or contact Example MSP/],
] as const)('a skip refused after the page loaded says why from details.reason: %j', async (details, title, text) => {
  vi.mocked(apiPost).mockResolvedValue({ error: 'refused', statusCode: 409, code: 'COLLECTION_IN_PROGRESS', errorDetails: details } as never);
  render(<AutopaySkipPage token="t" />);
  fireEvent.click(await screen.findByTestId('autopay-skip-submit'));
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.getByText(text)).toBeInTheDocument();
  if (title.includes('being changed')) expect(document.body.textContent).not.toMatch(/receipt/);
  expect(screen.queryByTestId('autopay-skip-submit')).toBeNull();
});

it('a skip accepted while a payment is being stopped says so without claiming it is skipped', async () => {
  vi.mocked(apiPost).mockResolvedValue({ data: { status: 'pending', control: 'skip' }, statusCode: 202 } as never);
  render(<AutopaySkipPage token="t" />);
  fireEvent.click(await screen.findByTestId('autopay-skip-submit'));
  expect(await screen.findByRole('heading', { name: "We're trying to stop this payment" })).toBeInTheDocument();
});

it.each([
  [{ status: 'skipped', state: 'skipped_by_client' }, 'This payment is skipped'],
  [{ status: 'paid', state: 'succeeded', invoiceStatus: 'paid' }, 'This invoice is already paid'],
  [{ status: 'not_needed', state: 'cancelled' }, "This invoice won't be charged automatically"],
  [{ status: 'not_needed', state: 'scheduled', control: 'exclude' }, "This invoice won't be charged automatically"],
  [{ status: 'action_required', state: 'action_required' }, 'This payment needs your confirmation'],
  [{ status: 'pending', state: 'scheduled', control: 'skip' }, "We're trying to stop this payment"],
])('%j', async (over, title) => {
  vi.mocked(apiGet).mockResolvedValue(view(over));
  render(<AutopaySkipPage token="t" />);
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-skip-submit')).toBeNull();
});

it('another refusal keeps the question and says what happened', async () => {
  vi.mocked(apiPost).mockResolvedValue({ error: 'Invoice cannot be skipped', statusCode: 409, code: 'INVALID_STATE' } as never);
  render(<AutopaySkipPage token="t" />);
  fireEvent.click(await screen.findByTestId('autopay-skip-submit'));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("We couldn't skip this payment"));
  expect(screen.getByTestId('autopay-skip-submit')).toBeEnabled();
});

it('an unusable link explains itself', async () => {
  vi.mocked(apiGet).mockResolvedValue({ error: 'x', code: 'link_expired', statusCode: 404, errorData: { partnerName: 'Example MSP' } } as never);
  render(<AutopaySkipPage token="t" />);
  expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeInTheDocument();
});
