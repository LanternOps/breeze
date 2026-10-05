// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiPost } from '@/lib/api';
import { withBase } from '@/lib/basePath';
import AutopayReturnPage, { resetReturnGuardForTests } from './AutopayReturnPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });
beforeEach(() => { vi.clearAllMocks(); resetReturnGuardForTests(); });
const branding = { partnerName: 'Example MSP', logoUrl: null, supportEmail: 'billing@msp.example' };
const at = (query: string) => window.history.replaceState({}, '', `/autopay/return?${query}`);
const outcome = (over: Record<string, unknown>) => ({ data: { orgId: 'org', methodLabel: 'Visa debit card ending in 1234',
  feeText: 'No processing fee applies to this card.', branding, current: null, ...over } }) as never;

it('confirms by itself once (no "Confirm setup" click, even under StrictMode) and says automatic payments are on', async () => {
  at('target=public&session_id=cs_test_1'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'activated' }));
  render(<StrictMode><AutopayReturnPage /></StrictMode>);
  expect(await screen.findByRole('heading', { name: 'Automatic payments are on' })).toBeInTheDocument();
  expect(screen.getByTestId('autopay-return-outcome')).toHaveTextContent('Visa debit card ending in 1234');
  expect(screen.getByTestId('autopay-return-fee')).toHaveTextContent('No processing fee applies to this card.');
  expect(screen.queryByTestId('autopay-return-submit')).toBeNull();
  expect(apiPost).toHaveBeenCalledExactlyOnceWith('/autopay/public/setup-return', { checkoutSessionId: 'cs_test_1', token: 'test-token' }, { redirectOnUnauthorized: false });
  expect(screen.getAllByText('Example MSP').length).toBeGreaterThan(0);
});

it('a reload shows the confirmed outcome again instead of "incomplete" (D-2)', async () => {
  at('target=public&session_id=cs_test_1'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'activated' }));
  render(<AutopayReturnPage />);
  await screen.findByRole('heading', { name: 'Automatic payments are on' });
  cleanup(); resetReturnGuardForTests(); vi.mocked(apiPost).mockClear();
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: 'Automatic payments are on' })).toBeInTheDocument();
  expect(apiPost).not.toHaveBeenCalled();
});

it('portal returns post to the portal route, never touch storage, and lead back to Payment methods', async () => {
  at('target=portal&session_id=cs_portal');
  const storage = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('blocked'); });
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'pending_verification', methodLabel: 'Bank account ending in 6789' }));
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: 'Verify your bank account' })).toBeInTheDocument();
  expect(screen.getByText(/Your bank account ending in 6789 is saved/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to payment methods' })).toHaveAttribute('href', withBase('/payment-methods'));
  expect(storage).not.toHaveBeenCalled();
  expect(apiPost).toHaveBeenCalledWith('/portal/payment-methods/setup-return', { checkoutSessionId: 'cs_portal' }, { redirectOnUnauthorized: true });
});

it.each([
  ['failed', "Your setup didn't finish", 'Try again'],
  ['abandoned', 'Your setup session expired', 'Start again'],
  ['unsupported_method', "That payment method can't be used for automatic payments", 'Start again'],
] as const)('%s offers a way to start again from the stored link', async (result, title, action) => {
  at('target=public&session_id=cs_test'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: result, methodLabel: null }));
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.getByTestId('autopay-restart')).toHaveAttribute('href', withBase('/autopay/test-token'));
  expect(screen.getByTestId('autopay-restart')).toHaveTextContent(action);
  expect(screen.queryByTestId('autopay-return-fee')).toBeNull();
  // V-17: name the control on Stripe's page instead of "enter your card details directly".
  if (result === 'unsupported_method') expect(screen.getByTestId('autopay-unsupported-method')).toHaveTextContent('choose "Pay without Link"');
});

it('portal unsupported method starts again from Payment methods', async () => {
  at('target=portal&session_id=cs_test');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'unsupported_method', methodLabel: null }));
  render(<AutopayReturnPage />);
  expect(await screen.findByTestId('autopay-restart')).toHaveAttribute('href', withBase('/payment-methods'));
});

it('a superseded return says the client is already set up when another tab finished (D-6)', async () => {
  at('target=public&session_id=cs_old'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'stale_generation', methodLabel: null,
    current: { status: 'active', methodLabel: 'Visa credit card ending in 4242' } }));
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: "You're already set up" })).toBeInTheDocument();
  expect(screen.getByText(/Automatic payments are on with your Visa credit card ending in 4242/)).toBeInTheDocument();
});

it('a superseded return without an active enrollment says the link was replaced', async () => {
  at('target=public&session_id=cs_old'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'stale_generation', methodLabel: null, current: { status: 'requested', methodLabel: null } }));
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: 'This setup link was replaced' })).toBeInTheDocument();
});

it('keeps checking while Stripe is still confirming, then lets the client check again', async () => {
  at('target=public&session_id=cs_slow'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'in_progress', methodLabel: null }));
  render(<AutopayReturnPage retryDelaysMs={[0, 0]} />);
  expect(await screen.findByRole('heading', { name: 'This is taking longer than usual' })).toBeInTheDocument();
  expect(apiPost).toHaveBeenCalledTimes(3);
  expect(sessionStorage.getItem('autopay-return-token')).toBe('test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'activated' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  expect(await screen.findByRole('heading', { name: 'Automatic payments are on' })).toBeInTheDocument();
});

it('Stripe "Back" (cancelled) is not a dead end', async () => {
  at('cancelled=1'); sessionStorage.setItem('autopay-return-token', 'test-token');
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: "Setup wasn't finished" })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Return to setup' })).toHaveAttribute('href', withBase('/autopay/test-token'));
  expect(apiPost).not.toHaveBeenCalled();
});

it('no stored link (another device, cleared storage) says to check email, never "incomplete"', async () => {
  at('target=public&session_id=cs_test');
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/incomplete/i);
  expect(apiPost).not.toHaveBeenCalled();
});

it('blocked storage explains site data and can retry', async () => {
  at('target=public&session_id=cs_public'); sessionStorage.setItem('autopay-return-token', 'test-token');
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  render(<AutopayReturnPage />);
  expect(await screen.findByText(/allow site data/)).toBeInTheDocument();
  expect(apiPost).not.toHaveBeenCalled();
  read.mockRestore();
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'activated' }));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByRole('heading', { name: 'Automatic payments are on' })).toBeInTheDocument();
});

it('a confirmation failure promises only what happens: a later email', async () => {
  at('target=public&session_id=cs_test'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue({ error: 'boom', statusCode: 500 } as never);
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: "We couldn't confirm your setup yet" })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled());
});

// V-18: "Check again" shows it is working and when it last checked.
it('check again says it is checking, then when it last checked', async () => {
  at('target=public&session_id=cs_slow'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'in_progress', methodLabel: null }));
  render(<AutopayReturnPage retryDelaysMs={[]} />);
  const check = await screen.findByRole('button', { name: 'Check again' });
  let finish: (value: unknown) => void = () => {};
  vi.mocked(apiPost).mockImplementation(() => new Promise(resolve => { finish = resolve; }) as never);
  fireEvent.click(check);
  expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled();
  finish(outcome({ outcome: 'in_progress', methodLabel: null }));
  expect(await screen.findByRole('button', { name: 'Check again' })).toBeEnabled();
  expect(screen.getByTestId('autopay-return-last-checked')).toHaveTextContent(/^Last checked at /);
});

// V-19: the MSP is named while confirming (stored at setup), so the card never jumps.
it('names the MSP from the stored setup while confirming', async () => {
  at('target=public&session_id=cs_test_1'); sessionStorage.setItem('autopay-return-token', 'test-token');
  sessionStorage.setItem('autopay-return-branding', JSON.stringify(branding));
  vi.mocked(apiPost).mockImplementation(() => new Promise(() => {}) as never);
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: 'Finishing your setup…' })).toBeInTheDocument();
  expect(screen.getByTestId('autopay-identity')).toHaveTextContent('Example MSP');
});
it('without stored branding, the identity row is reserved while confirming', async () => {
  at('target=public&session_id=cs_test_1'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockImplementation(() => new Promise(() => {}) as never);
  render(<AutopayReturnPage />);
  await screen.findByRole('heading', { name: 'Finishing your setup…' });
  expect(screen.getByTestId('autopay-return').firstElementChild).toHaveClass('min-h-10');
});

// V-20: the MSP's address appears once: in the card when emailing them is the next step,
// otherwise in the footer.
it('a replaced setup link offers to email the MSP once', async () => {
  at('target=public&session_id=cs_old'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'stale_generation', methodLabel: null, current: { status: 'requested', methodLabel: null } }));
  render(<AutopayReturnPage />);
  await screen.findByRole('heading', { name: 'This setup link was replaced' });
  expect(screen.getAllByRole('link', { name: /Email Example MSP|billing@msp\.example/ })).toHaveLength(1);
});
it('a failed setup keeps the footer address and no second contact in the card', async () => {
  at('target=public&session_id=cs_test'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'failed', methodLabel: null }));
  render(<AutopayReturnPage />);
  await screen.findByRole('heading', { name: "Your setup didn't finish" });
  expect(screen.getAllByRole('link', { name: /Email Example MSP|billing@msp\.example/ })).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'billing@msp.example' })).toBeInTheDocument();
});

// R1: the enrollment can stay paused when the method is saved; never say "on" then.
it('a method saved while automatic payments are paused says saved and paused, not on', async () => {
  at('target=public&session_id=cs_paused'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'activated', current: { status: 'paused', methodLabel: 'Visa debit card ending in 1234' } }));
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: 'Your payment method is saved' })).toBeInTheDocument();
  expect(screen.getByText(/Example MSP has paused automatic payments, so nothing is charged automatically for now/)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/Automatic payments are on/);
});
it.each([
  ['paused', 'Automatic payments are paused', /Example MSP paused automatic payments while you were setting up, so nothing was saved or charged/],
  ['cancelled', 'Automatic payments are off', /Automatic payments were turned off while you were setting up, so nothing was saved or charged/],
] as const)('a setup that went stale because automatic payments were %s says so, not "a newer link"', async (status, title, text) => {
  at('target=public&session_id=cs_old'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue(outcome({ outcome: 'stale_generation', methodLabel: null, current: { status, methodLabel: null } }));
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/newer setup link/);
});
// R8: switched off between setup and return: say so with the MSP's name, never a retry loop.
it('a return refused because automatic payments are switched off explains itself', async () => {
  at('target=public&session_id=cs_test'); sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue({ error: 'Automatic payments are not enabled', code: 'autopay_not_enabled', statusCode: 404,
    errorData: { partnerName: 'Example MSP', logoUrl: null, supportEmail: 'billing@msp.example' } } as never);
  render(<AutopayReturnPage />);
  expect(await screen.findByRole('heading', { name: "Automatic payment setup isn't available right now" })).toBeInTheDocument();
  expect(screen.getByTestId('autopay-identity')).toHaveTextContent('Example MSP');
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});
