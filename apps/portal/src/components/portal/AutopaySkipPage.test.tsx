// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from '@/lib/api';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
import AutopaySkipPage from './AutopaySkipPage';
afterEach(() => { cleanup(); });
function view(over: Record<string, unknown> = {}) {
  return { data: { status: 'ready', reason: null, onHold: false, state: 'scheduled', control: null, processing: false, invoiceNumber: 'INV-2026-0003', invoiceStatus: 'sent',
    dueDate: '2026-10-08', collectOn: '2026-11-04', amount: '50.00', balance: '50.00', fee: '1.50', currency: 'USD',
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
  // V-39: name who is changing what.
  [{ reason: 'control_pending' }, 'This payment is already being changed', /Example MSP is already changing how invoice INV-2026-0003 is paid\. Check your email for an update, or contact Example MSP/],
  [undefined, 'This payment is already being changed', /Example MSP is already changing how invoice INV-2026-0003 is paid/],
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
  [{ status: 'not_needed', reason: 'stopped', state: 'cancelled' }, 'Automatic payments are off'],
  [{ status: 'not_needed', reason: 'excluded', state: 'scheduled', control: 'exclude' }, "This invoice won't be charged automatically"],
  [{ status: 'not_needed', reason: null, state: 'not_needed' }, "This invoice won't be charged automatically"],
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

// V-1: an invoice skipped and then paid is paid; it never asks the client to pay it.
it('a skipped invoice that was then paid says paid, with no pay button', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ status: 'paid', state: 'skipped_by_client', invoiceStatus: 'paid', balance: '0.00' }));
  render(<AutopaySkipPage token="t" />);
  expect(await screen.findByRole('heading', { name: 'This invoice is already paid' })).toBeInTheDocument();
  expect(screen.queryByText(/Please pay/)).toBeNull();
  expect(screen.queryByRole('link', { name: /Pay invoice/ })).toBeNull();
});
it('a paid invoice wins even if a stale view still says skipped', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ status: 'skipped', state: 'skipped_by_client', invoiceStatus: 'paid', balance: '0.00' }));
  render(<AutopaySkipPage token="t" />);
  expect(await screen.findByRole('heading', { name: 'This invoice is already paid' })).toBeInTheDocument();
});

// V-2: refunded after an automatic payment: the invoice is open again and says what is due.
it('a reversed automatic payment says the invoice is due again and offers to pay it', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ status: 'reversed', state: 'succeeded', invoiceStatus: 'sent', balance: '100.00' }));
  render(<AutopaySkipPage token="t" />);
  expect(await screen.findByRole('heading', { name: 'This invoice is due again' })).toBeInTheDocument();
  expect(screen.getByText(/was refunded or reversed, so \$100\.00 is due again/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Pay invoice' })).toHaveAttribute('href', 'https://portal.example.test/portal/invoice/inv-token');
  expect(document.body.textContent).not.toMatch(/already paid|Thank you/);
});

// V-11: nothing to skip says why, and shows no schedule or method that won't be used.
it.each([
  ['excluded', "This invoice won't be charged automatically", /Example MSP took invoice INV-2026-0003 out of automatic payments/],
  ['failed', "The automatic payment didn't go through", /The automatic payment for invoice INV-2026-0003 didn't go through/],
  ['stopped', 'Automatic payments are off', /won't be charged automatically/],
  ['paused', 'Automatic payments are paused', /Example MSP paused automatic payments/],
  ['replaced', 'This link was replaced', /most recent email/],
  ['not_included', "This invoice isn't paid automatically", /isn't included in your automatic payments/],
  ['void', 'This invoice was cancelled', /nothing to pay/],
  ['nothing_due', 'Nothing is due on this invoice', /nothing left to pay/],
] as const)('not skippable (%s): names the reason without a schedule', async (reason, title, text) => {
  vi.mocked(apiGet).mockResolvedValue(view({ status: 'not_needed', reason, balance: ['void', 'nothing_due'].includes(reason) ? '0.00' : '75.00' }));
  render(<AutopaySkipPage token="t" />);
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.queryByText('Scheduled for')).toBeNull();
  expect(screen.queryByText('Payment method')).toBeNull();
  expect(screen.queryByText('November 4, 2026')).toBeNull();
  if (!['void', 'nothing_due', 'replaced'].includes(reason)) expect(screen.getByText('$75.00')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-skip-submit')).toBeNull();
});

// V-39: a refusal re-reads the link, so an exclusion or stop that landed meanwhile is named.
it('a refused skip re-reads the page and names an exclusion that landed meanwhile', async () => {
  vi.mocked(apiPost).mockResolvedValue({ error: 'refused', statusCode: 409, code: 'COLLECTION_IN_PROGRESS', errorDetails: { reason: 'control_pending' } } as never);
  render(<AutopaySkipPage token="t" />);
  const submit = await screen.findByTestId('autopay-skip-submit');
  vi.mocked(apiGet).mockResolvedValue(view({ status: 'not_needed', reason: 'excluded', control: 'exclude' }));
  fireEvent.click(submit);
  expect(await screen.findByRole('heading', { name: "This invoice won't be charged automatically" })).toBeInTheDocument();
  expect(screen.getByText(/Example MSP took invoice INV-2026-0003 out of automatic payments/)).toBeInTheDocument();
});

// V-37: skipping still works while the MSP has automatic payments on hold; the page says so.
it('while automatic payments are on hold, the skip question carries a note', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ onHold: true }));
  render(<AutopaySkipPage token="t" />);
  expect(await screen.findByTestId('autopay-skip-on-hold')).toHaveTextContent(/Example MSP has put automatic payments on hold/);
  expect(screen.getByTestId('autopay-skip-submit')).toBeEnabled();
});
