import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ActionError } from '../../lib/runAction';
import { useBillingStepUp, suppressBillingStepUpToast, type BillingStepUpOutcome, type BillingStepUpSubmit } from './useBillingStepUp';

const h = vi.hoisted(() => ({ fetch: vi.fn(), mint: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: h.fetch }));
vi.mock('../../lib/mfaStepUp', () => ({ mintStepUpGrant: h.mint }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const resource = { invoiceId: '10000000-0000-4000-8000-000000000001' };
const stepUpError = (operation = 'autopay_charge_now') => new ActionError('Step-up required', 403, 'STEP_UP_REQUIRED',
  { error: 'Step-up required', code: 'STEP_UP_REQUIRED', stepUp: { operation, resource } });

let outcome: Promise<BillingStepUpOutcome<string>> | undefined;
function Harness({ submit }: { submit: BillingStepUpSubmit<string> }) {
  const stepUp = useBillingStepUp();
  const [, force] = useState(0);
  return <div>
    <button data-testid="go" onClick={() => { outcome = stepUp.run(submit); force(n => n + 1); }}>go</button>
    {stepUp.prompt}
  </div>;
}
function factors(mfaMethod: string | null, passkeys: unknown[] = []) {
  h.fetch.mockImplementation(async (url: string) => url === '/users/me'
    ? Response.json({ mfaEnabled: !!mfaMethod, mfaMethod }) : Response.json(passkeys));
}

beforeEach(() => { outcome = undefined; factors('totp'); h.mint.mockResolvedValue('grant-1'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('succeeds on the first submit when no step-up is asked for', async () => {
  const submit = vi.fn(async () => 'done');
  render(<Harness submit={submit} />);
  fireEvent.click(screen.getByTestId('go'));
  await expect(outcome).resolves.toEqual({ confirmed: true, value: 'done' });
  expect(submit).toHaveBeenCalledWith();
  expect(screen.queryByTestId('billing-stepup')).toBeNull();
});

it('mints a grant for exactly the resource the server named and resubmits with it', async () => {
  const submit = vi.fn(async (grant?: string) => { if (!grant) throw stepUpError(); return 'charged'; });
  render(<Harness submit={submit} />);
  fireEvent.click(screen.getByTestId('go'));
  expect(await screen.findByTestId('billing-stepup')).toHaveTextContent('Charging this invoice now needs a fresh second-factor check.');
  expect(screen.getByTestId('billing-stepup-confirm')).toBeDisabled();
  fireEvent.change(screen.getByTestId('billing-stepup-code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('billing-stepup-confirm'));
  await expect(outcome).resolves.toEqual({ confirmed: true, value: 'charged' });
  expect(h.mint).toHaveBeenCalledWith({ operation: 'autopay_charge_now', resource, reauth: { method: 'totp', code: '123456' } });
  expect(submit).toHaveBeenLastCalledWith('grant-1');
  await waitFor(() => expect(screen.queryByTestId('billing-stepup')).toBeNull());
});

it('confirms with a passkey when the account has one', async () => {
  factors('totp', [{ id: 'pk' }]);
  const submit = vi.fn(async (grant?: string) => { if (!grant) throw stepUpError('partner_payment_settings_update'); return 'saved'; });
  render(<Harness submit={submit} />);
  fireEvent.click(screen.getByTestId('go'));
  expect(await screen.findByTestId('billing-stepup')).toHaveTextContent('these exact values');
  fireEvent.click(screen.getByTestId('billing-stepup-confirm'));
  await expect(outcome).resolves.toEqual({ confirmed: true, value: 'saved' });
  expect(h.mint).toHaveBeenCalledWith(expect.objectContaining({ operation: 'partner_payment_settings_update', reauth: { method: 'passkey' } }));
});

it('keeps the prompt open with an error when the grant is refused', async () => {
  const submit = vi.fn(async () => { throw stepUpError(); });
  render(<Harness submit={submit} />);
  fireEvent.click(screen.getByTestId('go'));
  fireEvent.change(await screen.findByTestId('billing-stepup-code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('billing-stepup-confirm'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Verification failed. Try again.');
  expect(screen.getByTestId('billing-stepup')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('billing-stepup-cancel'));
  await expect(outcome).resolves.toEqual({ confirmed: false });
});

it('shows a mint failure without resubmitting', async () => {
  h.mint.mockRejectedValueOnce(new Error('Invalid credentials'));
  const submit = vi.fn(async (grant?: string) => { if (!grant) throw stepUpError(); return 'x'; });
  render(<Harness submit={submit} />);
  fireEvent.click(screen.getByTestId('go'));
  fireEvent.change(await screen.findByTestId('billing-stepup-code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('billing-stepup-confirm'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
  expect(submit).toHaveBeenCalledTimes(1);
});

it('rejects with a non-step-up failure of the resubmit', async () => {
  const conflict = new ActionError('notice_lead', 409, 'notice_lead');
  const submit = vi.fn(async (grant?: string) => { if (!grant) throw stepUpError(); throw conflict; });
  render(<Harness submit={submit} />);
  fireEvent.click(screen.getByTestId('go'));
  fireEvent.change(await screen.findByTestId('billing-stepup-code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('billing-stepup-confirm'));
  await expect(outcome).rejects.toBe(conflict);
  await waitFor(() => expect(screen.queryByTestId('billing-stepup')).toBeNull());
});

it('passes through failures that are not a billing step-up', async () => {
  const other = new ActionError('Step-up required', 403, 'STEP_UP_REQUIRED', { stepUp: { operation: 'device_move_org', resource: {} } });
  render(<Harness submit={async () => { throw other; }} />);
  fireEvent.click(screen.getByTestId('go'));
  await expect(outcome).rejects.toBe(other);
});

it('asks an account without an authenticator app or passkey to set one up', async () => {
  factors('sms');
  render(<Harness submit={async () => { throw stepUpError('autopay_request_recipient'); }} />);
  fireEvent.click(screen.getByTestId('go'));
  expect(await screen.findByTestId('billing-stepup-enroll')).toHaveAttribute('href', '/settings/profile');
  expect(screen.getByTestId('billing-stepup-confirm')).toBeDisabled();
});

it('settles the caller as not confirmed when the prompt unmounts', async () => {
  const view = render(<Harness submit={async () => { throw stepUpError(); }} />);
  fireEvent.click(screen.getByTestId('go'));
  await screen.findByTestId('billing-stepup');
  act(() => view.unmount());
  await expect(outcome).resolves.toEqual({ confirmed: false });
});

it('suppresses the toast only for the step-up answer', () => {
  expect(suppressBillingStepUpToast(403, 'STEP_UP_REQUIRED')).toBe(true);
  expect(suppressBillingStepUpToast(403, 'MFA_REQUIRED')).toBe(false);
  expect(suppressBillingStepUpToast(409, 'STEP_UP_REQUIRED')).toBe(false);
});
