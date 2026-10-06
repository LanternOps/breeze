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
  return { data: { state: 'requires_action', amount: '100.00', fee: '0.00', currency: 'USD', invoiceNumber: 'INV-7', invoiceStatus: 'sent', balance: '100.00', methodLabel: 'Visa credit card ending in 3184',
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
  // FP-4: the invoice page then says the automatic payment was canceled.
  await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('https://portal.example.test/portal/invoice/tok#autopay-released'));
  expect(apiPost).toHaveBeenCalledExactlyOnceWith('/autopay/public/token/confirm', {}, { redirectOnUnauthorized: false });
});

it.each([
  [{ data: { processing: true } }, 'Your payment is processing'],
  [{ data: { paid: true } }, 'Payment received'],
  // R5: classified by reason, never by matching English text.
  [{ error: 'Something else entirely', statusCode: 409, code: 'INVALID_STATE', errorDetails: { reason: 'needs_review' } }, 'We received your payment'],
  [{ error: 'Payment received but needs billing review', statusCode: 409, code: 'INVALID_STATE', errorDetails: { reason: 'processing' } }, 'Your payment is processing'],
  // {paid:false}: Stripe took the money but it isn't applied to the invoice yet. Never "try again".
  [{ data: { paid: false } }, 'We received your payment'],
])('lands %j', async (response, title) => {
  vi.mocked(apiPost).mockResolvedValue(response as never);
  render(<AutopayConfirmPage token="token" />);
  fireEvent.click(await screen.findByTestId('autopay-confirm-submit'));
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-confirm-submit')).toBeNull();
});

it.each([['processing', 'Your payment is processing'], ['succeeded', 'Payment received'], ['not_needed', 'The automatic payment was canceled']])(
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
  await waitFor(() => expect(screen.getByTestId('autopay-confirm-submit')).toBeEnabled());
});

it('an unusable link explains itself', async () => {
  vi.mocked(apiGet).mockResolvedValue({ error: 'x', code: 'link_used', statusCode: 404, errorData: { partnerName: 'Example MSP', enrollmentStatus: 'active' } } as never);
  render(<AutopayConfirmPage token="token" />);
  expect(await screen.findByRole('heading', { name: 'This link was already used' })).toBeInTheDocument();
});

// V-3: a confirmation canceled on the invoice page leaves money due; the link says so and
// leads with paying, instead of implying the invoice was settled.
it('a canceled confirmation on an open invoice says what is still due and offers to pay', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ state: 'not_needed', balance: '90.00', invoiceStatus: 'sent' }));
  render(<AutopayConfirmPage token="token" />);
  expect(await screen.findByRole('heading', { name: 'The automatic payment was canceled' })).toBeInTheDocument();
  expect(screen.getByText(/\$90\.00 is still due on invoice INV-7/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Pay invoice' })).toHaveAttribute('href', 'https://portal.example.test/portal/invoice/tok');
  expect(document.body.textContent).not.toMatch(/settled another way|No action needed/);
});
it('a canceled confirmation on a paid invoice says it is paid', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ state: 'not_needed', balance: '0.00', invoiceStatus: 'paid' }));
  render(<AutopayConfirmPage token="token" />);
  expect(await screen.findByRole('heading', { name: 'No action needed' })).toBeInTheDocument();
  expect(screen.getByText(/Invoice INV-7 is paid/)).toBeInTheDocument();
});
it('a POST that finds nothing to confirm on an open invoice also says what is due', async () => {
  vi.mocked(apiPost).mockResolvedValue({ data: { notNeeded: true } } as never);
  render(<AutopayConfirmPage token="token" />);
  fireEvent.click(await screen.findByTestId('autopay-confirm-submit'));
  expect(await screen.findByRole('heading', { name: 'The automatic payment was canceled' })).toBeInTheDocument();
  expect(screen.getByText(/\$100\.00 is still due on invoice INV-7/)).toBeInTheDocument();
});
// V-22: the invoice number in the title never splits at its hyphen.
it('keeps the invoice number in the title on one line', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ invoiceNumber: 'INV-2026-0033' }));
  render(<AutopayConfirmPage token="token" />);
  const heading = await screen.findByRole('heading', { level: 1, name: 'Confirm your payment for invoice INV-2026-0033' });
  expect(heading.querySelector('.whitespace-nowrap')).toHaveTextContent('INV-2026-0033');
});

// R5: after a failed POST the page re-reads the link and never repeats "Nothing has been charged yet".
it.each([[{ error: 'Link unavailable', statusCode: 404 }], [{ error: 'Payment could not be confirmed.', statusCode: 500 }]] as const)(
  'a %j refusal re-reads the confirm link and shows its state', async refusal => {
    vi.mocked(apiPost).mockResolvedValue(refusal as never);
    render(<AutopayConfirmPage token="token" />);
    const submit = await screen.findByTestId('autopay-confirm-submit');
    vi.mocked(apiGet).mockResolvedValue(view({ state: 'succeeded', invoiceStatus: 'paid', balance: '0.00' }));
    fireEvent.click(submit);
    expect(await screen.findByRole('heading', { name: 'Payment received' })).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
it('a failed POST whose re-read still waits on the bank drops "Nothing has been charged yet"', async () => {
  vi.mocked(apiPost).mockResolvedValue({ error: 'Payment could not be confirmed.', statusCode: 500 } as never);
  render(<AutopayConfirmPage token="token" />);
  fireEvent.click(await screen.findByTestId('autopay-confirm-submit'));
  expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't confirm the payment right now");
  expect(document.body.textContent).not.toContain('Nothing has been charged yet');
  expect(screen.getByRole('alert')).toHaveTextContent('Open the invoice to check its status before paying');
});
it('a network failure re-reads the link too', async () => {
  vi.mocked(apiPost).mockRejectedValue(new TypeError('Failed to fetch'));
  render(<AutopayConfirmPage token="token" />);
  const submit = await screen.findByTestId('autopay-confirm-submit');
  vi.mocked(apiGet).mockResolvedValue(view({ state: 'processing' }));
  fireEvent.click(submit);
  expect(await screen.findByRole('heading', { name: 'Your payment is processing' })).toBeInTheDocument();
});

// FP-4: the bank asked about the automatic payment with its fee; paying on the invoice has none.
it('names the automatic payment with its fee, and what paying on the invoice costs instead', async () => {
  vi.mocked(apiGet).mockResolvedValue(view({ amount: '90.00', fee: '2.70', balance: '90.00' }));
  render(<AutopayConfirmPage token="token" />);
  expect(await screen.findByText(/Your bank asked you to confirm an automatic payment of \$92\.70 \(\$90\.00 plus a \$2\.70 processing fee\)/)).toBeInTheDocument();
  expect(screen.getByText(/On the invoice page you'll pay \$90\.00, with no processing fee\./)).toBeInTheDocument();
});
it('a used confirm link offers its invoice', async () => {
  vi.mocked(apiGet).mockResolvedValue({ error: 'x', code: 'link_used', statusCode: 404,
    errorData: { partnerName: 'Example MSP', enrollmentStatus: 'active', invoiceUrl: 'https://portal.example.test/invoice/inv' } } as never);
  render(<AutopayConfirmPage token="token" />);
  expect(await screen.findByRole('heading', { name: 'This link was already used' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View invoice' })).toHaveAttribute('href', 'https://portal.example.test/invoice/inv');
});
