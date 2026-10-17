import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getPolicy, putPolicy, type PolicyResponse } from '@/lib/api/callerVerification';
import { CallerVerificationPolicyForm, PartnerCallerVerificationPolicy, inheritedDraft } from './CallerVerificationPolicyForm';
import { useAuthStore } from '@/stores/auth';
import { ORG, policy, policyValues } from './testFixtures';

const enabled = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/api/callerVerification', () => ({ getPolicy: vi.fn(), putPolicy: vi.fn() }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => enabled.value }));
afterEach(() => { vi.clearAllMocks(); enabled.value = true; });

const orgOwner = { ownerScope: 'organization' as const, orgId: ORG };
const response = (over: Partial<PolicyResponse> = {}): PolicyResponse => ({ row: null, defaults: policyValues, baseline: policyValues, effective: policy, ...over });

it('makes no request while the feature is off', () => {
  enabled.value = false;
  render(<CallerVerificationPolicyForm owner={orgOwner} />);
  expect(getPolicy).not.toHaveBeenCalled();
});

it('bounds org numeric overrides by the partner baseline and shows provenance and ignored fields', async () => {
  vi.mocked(getPolicy).mockResolvedValue(response({
    baseline: { ...policyValues, requiredTierResetPassword: 2, verificationTtlMinutes: 20 },
    effective: { ...policy, requiredTierResetPassword: 2, verificationTtlMinutes: 20, provenance: { requiredTierResetPassword: 'partner' }, ignored: ['maxAttemptsPerHour'] },
  }));
  render(<CallerVerificationPolicyForm owner={orgOwner} />);
  const tier = await screen.findByTestId('cv-policy-requiredTierResetPassword');
  expect(tier).toHaveAttribute('min', '2');
  expect(tier).toHaveAttribute('max', '3');
  expect(screen.getByTestId('cv-policy-verificationTtlMinutes')).toHaveAttribute('max', '20');
  expect(screen.getByTestId('cv-policy-requiredTierResetPassword-source')).toHaveTextContent('Partner');
  expect(screen.getByText(/looser than the partner baseline/)).toHaveTextContent('Attempts per contact per hour');
  expect(getPolicy).toHaveBeenCalledWith(orgOwner, expect.any(AbortSignal));
});

it('blocks loosening set members and booleans for an org override', async () => {
  vi.mocked(getPolicy).mockResolvedValue(response({
    baseline: { ...policyValues, allowedMethods: ['sms', 'email'], requireTicket: true },
  }));
  render(<CallerVerificationPolicyForm owner={orgOwner} />);
  expect(await screen.findByTestId('cv-policy-allowedMethods-workstation')).toBeDisabled();
  expect(screen.getByTestId('cv-policy-allowedMethods-sms')).toBeEnabled();
  const requireTicket = screen.getByTestId('cv-policy-requireTicket') as HTMLSelectElement;
  expect(requireTicket.querySelector('option[value="false"]')).toBeDisabled();
});

it('saves only the policy fields, with untouched fields left as inherit', async () => {
  const row = { ...inheritedDraft(), maxAttemptsPerHour: 2, id: 'x', orgId: ORG, partnerId: null } as unknown as PolicyResponse['row'];
  vi.mocked(getPolicy).mockResolvedValue(response({ row }));
  vi.mocked(putPolicy).mockResolvedValue(response({ row }));
  render(<CallerVerificationPolicyForm owner={orgOwner} />);
  const cooling = await screen.findByTestId('cv-policy-coolingOffHours');
  fireEvent.change(cooling, { target: { value: '48' } });
  fireEvent.blur(cooling);
  await act(async () => { fireEvent.click(screen.getByTestId('cv-policy-save')); });
  expect(putPolicy).toHaveBeenCalledWith(orgOwner, { ...inheritedDraft(), maxAttemptsPerHour: 2, coolingOffHours: 48 });
});

it('resets a field to inherit', async () => {
  const row = { ...inheritedDraft(), maxAttemptsPerHour: 2 };
  vi.mocked(getPolicy).mockResolvedValue(response({ row }));
  vi.mocked(putPolicy).mockResolvedValue(response());
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} />);
  const attempts = await screen.findByTestId('cv-policy-maxAttemptsPerHour');
  expect(attempts).toHaveValue(2);
  fireEvent.click(screen.getByTestId('cv-policy-maxAttemptsPerHour-inherit'));
  expect(attempts).toHaveValue(policyValues.maxAttemptsPerHour);
  await act(async () => { fireEvent.click(screen.getByTestId('cv-policy-save')); });
  expect(putPolicy).toHaveBeenCalledWith({ ownerScope: 'partner' }, inheritedDraft());
});

it('shows the value the server saved, not the one that was typed', async () => {
  vi.mocked(getPolicy).mockResolvedValue(response());
  vi.mocked(putPolicy).mockResolvedValue(response({ row: { ...inheritedDraft(), verificationTtlMinutes: 60 } as unknown as PolicyResponse['row'] }));
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} />);
  const ttl = await screen.findByTestId('cv-policy-verificationTtlMinutes');
  fireEvent.change(ttl, { target: { value: '45' } });
  fireEvent.blur(ttl);
  await act(async () => { fireEvent.click(screen.getByTestId('cv-policy-save')); });
  expect(ttl).toHaveValue(60);
});

it('labels the partner baseline as applying to all organizations', async () => {
  vi.mocked(getPolicy).mockResolvedValue(response());
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} />);
  expect(await screen.findByText('All organizations')).toBeVisible();
});

it('is read-only when the viewer cannot manage it', async () => {
  vi.mocked(getPolicy).mockResolvedValue(response());
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} readOnly />);
  expect(await screen.findByText('You can view this policy but not change it.')).toBeVisible();
  expect(screen.queryByTestId('cv-policy-save')).toBeNull();
  expect(screen.getByTestId('cv-policy-coolingOffHours')).toBeDisabled();
});

it('offers a retry when loading fails', async () => {
  vi.mocked(getPolicy).mockRejectedValueOnce(new Error('boom')).mockResolvedValue(response());
  render(<CallerVerificationPolicyForm owner={orgOwner} />);
  fireEvent.click(await screen.findByText('Try again'));
  await waitFor(() => expect(getPolicy).toHaveBeenCalledTimes(2));
  expect(await screen.findByTestId('cv-policy-save')).toBeVisible();
});

it.each([[false, true], [true, false], [undefined, false]])('partner mount with canManagePartnerWide=%s is read-only=%s', async (canManagePartnerWide, readOnly) => {
  useAuthStore.setState({ user: { id: 'u', email: 'e', name: 'n', canManagePartnerWide } as never });
  vi.mocked(getPolicy).mockResolvedValue(response());
  render(<PartnerCallerVerificationPolicy />);
  await screen.findByTestId('cv-policy-form');
  expect(screen.queryByTestId('cv-policy-save') === null).toBe(readOnly);
  expect(getPolicy).toHaveBeenCalledWith({ ownerScope: 'partner' }, expect.any(AbortSignal));
});

it('accepts a typed multi-digit value and commits it on blur', async () => {
  vi.mocked(getPolicy).mockResolvedValue(response());
  vi.mocked(putPolicy).mockResolvedValue(response());
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} />);
  const ttl = await screen.findByTestId('cv-policy-verificationTtlMinutes');
  fireEvent.change(ttl, { target: { value: '3' } });
  expect(ttl).toHaveValue(3);
  fireEvent.change(ttl, { target: { value: '45' } });
  fireEvent.blur(ttl);
  await act(async () => { fireEvent.click(screen.getByTestId('cv-policy-save')); });
  expect(vi.mocked(putPolicy).mock.calls[0][1].verificationTtlMinutes).toBe(45);
});

it('clamps an out-of-range typed value to its bound on blur', async () => {
  vi.mocked(getPolicy).mockResolvedValue(response());
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} />);
  const ttl = await screen.findByTestId('cv-policy-verificationTtlMinutes');
  fireEvent.change(ttl, { target: { value: '2' } });
  fireEvent.blur(ttl);
  expect(ttl).toHaveValue(5);
  fireEvent.change(ttl, { target: { value: '' } });
  fireEvent.blur(ttl);
  expect(ttl).toHaveValue(5);
});

it('partner mount makes no request while the feature is off', () => {
  enabled.value = false;
  render(<PartnerCallerVerificationPolicy />);
  expect(getPolicy).not.toHaveBeenCalled();
});
