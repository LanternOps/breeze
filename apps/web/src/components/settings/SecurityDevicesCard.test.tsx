import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApproverDevice } from '../../stores/authenticator';

const { fetchWithAuthMock, createPasskeyCredentialMock, mintStepUpGrantsMock, MockStepUpError } = vi.hoisted(() => {
  class MockStepUpError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'StepUpError';
      this.status = status;
    }
  }
  return {
    fetchWithAuthMock: vi.fn(),
    createPasskeyCredentialMock: vi.fn(),
    mintStepUpGrantsMock: vi.fn(),
    MockStepUpError,
  };
});

const {
  listApproverDevicesMock,
  registerApproverDeviceMock,
  revokeApproverDeviceMock,
  renameApproverDeviceMock,
  adoptPasskeyAsApproverMock,
  showToastMock,
} = vi.hoisted(() => ({
  listApproverDevicesMock: vi.fn(),
  registerApproverDeviceMock: vi.fn(),
  revokeApproverDeviceMock: vi.fn(),
  renameApproverDeviceMock: vi.fn(),
  adoptPasskeyAsApproverMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  mintStepUpGrants: mintStepUpGrantsMock,
  StepUpError: MockStepUpError,
}));

vi.mock('../../stores/authenticator', () => ({
  listApproverDevices: listApproverDevicesMock,
  registerApproverDevice: registerApproverDeviceMock,
  revokeApproverDevice: revokeApproverDeviceMock,
  renameApproverDevice: renameApproverDeviceMock,
  adoptPasskeyAsApprover: adoptPasskeyAsApproverMock,
}));

vi.mock('../shared/Toast', () => ({
  showToast: showToastMock,
}));

// Passthrough mock, per the brief: keep runAction's real request→success/error
// shape but skip its dependency on the real Toast module's DOM listener setup.
// The thrown rejection must be an actual instance of the exported ActionError
// class (not just a plain Error with `.name` set to the string 'ActionError')
// — the component's catch blocks branch on `err instanceof ActionError` (see
// handleRegisterApprover's `if (err.status === 403) setApproverReauthValue('')`),
// and real runAction.ts throws `new ActionError(...)`. A plain Error would
// silently fail that instanceof check and mask real 403 clearing behavior.
vi.mock('../../lib/runAction', () => {
  class ActionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ActionError';
      this.status = status;
    }
  }
  return {
    runAction: vi.fn(async (opts: { request: () => Promise<Response>; errorFallback: string; successMessage?: string }) => {
      const response = await opts.request();
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = (data && typeof data === 'object' && 'error' in data ? (data as any).error : undefined) ?? opts.errorFallback;
        showToastMock({ type: 'error', message });
        throw new ActionError(message, response.status);
      }
      if (opts.successMessage) showToastMock({ type: 'success', message: opts.successMessage });
      return data;
    }),
    ActionError,
  };
});

import SecurityDevicesCard from './SecurityDevicesCard';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const okApproverResponse = (): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ success: true }) }) as unknown as Response;

const approverFixture = (over: Partial<ApproverDevice> = {}): ApproverDevice => ({
  id: 'ad-1',
  label: 'Laptop',
  kind: 'webauthn_platform',
  isPlatformBound: true,
  createdAt: '2026-06-01T12:00:00.000Z',
  lastUsedAt: '2026-06-10T09:00:00.000Z',
  credentialId: 'cred-1',
  disabledAt: null,
  ...over,
});

describe('SecurityDevicesCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listApproverDevicesMock.mockResolvedValue([]);
    registerApproverDeviceMock.mockResolvedValue(undefined);
    revokeApproverDeviceMock.mockResolvedValue(okApproverResponse());
    renameApproverDeviceMock.mockResolvedValue(okApproverResponse());
    adoptPasskeyAsApproverMock.mockResolvedValue(undefined);
  });

  it('renders Sign-in + Approvals + Platform-bound badges for a merged row', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'Laptop', lastUsedAt: '2026-06-10T09:00:00.000Z', credentialId: 'cred-1' }] }),
    );
    listApproverDevicesMock.mockResolvedValueOnce([approverFixture()]);

    render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

    const row = await screen.findByTestId('secdev-row-pk-pk1');
    expect(within(row).getByTestId('secdev-badge-signin')).toBeTruthy();
    expect(within(row).getByTestId('secdev-badge-approvals')).toBeTruthy();
    expect(within(row).getByTestId('secdev-badge-platform')).toBeTruthy();
    expect(within(row).queryByTestId('secdev-badge-pending')).toBeNull();
  });

  it('still renders successfully-loaded passkeys when the approver-device fetch fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'Laptop', lastUsedAt: '2026-06-10T09:00:00.000Z', credentialId: 'cred-1' }] }),
    );
    listApproverDevicesMock.mockRejectedValueOnce(new Error('network down'));

    render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

    const row = await screen.findByTestId('secdev-row-pk-pk1');
    expect(within(row).getByTestId('secdev-badge-signin')).toBeTruthy();
    expect(await screen.findByText('network down')).toBeTruthy();
  });

  it('shows the synced badge on a merged row whose approver capability is not platform-bound', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'iCloud Keychain', lastUsedAt: null, credentialId: 'cred-1' }] }),
    );
    listApproverDevicesMock.mockResolvedValueOnce([approverFixture({ isPlatformBound: false })]);

    render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

    const row = await screen.findByTestId('secdev-row-pk-pk1');
    expect(within(row).getByTestId('secdev-badge-synced')).toBeTruthy();
    expect(within(row).queryByTestId('secdev-badge-platform')).toBeNull();
  });

  it('shows the pending badge on an approver-only row that has never been used', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));
    listApproverDevicesMock.mockResolvedValueOnce([
      approverFixture({ id: 'ad-2', label: 'iPhone', credentialId: null, kind: 'mobile_hw_key', lastUsedAt: null }),
    ]);

    render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

    const row = await screen.findByTestId('secdev-row-ad-ad-2');
    expect(within(row).getByTestId('secdev-badge-pending')).toBeTruthy();
    expect(within(row).queryByTestId('secdev-badge-signin')).toBeNull();
  });

  it('"Revoke approvals" calls revokeApproverDevice(id) and never touches /auth/passkeys DELETE', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));
    listApproverDevicesMock.mockResolvedValueOnce([
      approverFixture({ id: 'ad-3', label: 'Front-desk laptop', credentialId: null }),
    ]);

    render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

    const row = await screen.findByTestId('secdev-row-ad-ad-3');
    fireEvent.click(within(row).getByTestId('secdev-revoke-ad-ad-3'));
    const confirmBtn = await screen.findByTestId('secdev-revoke-confirm');
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(revokeApproverDeviceMock).toHaveBeenCalledWith('ad-3'));
    // Only the initial passkeys GET went through fetchWithAuth — no DELETE call.
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock.mock.calls.every(call => call[1]?.method !== 'DELETE')).toBe(true);
  });

  it('sends currentPassword when deleting a passkey', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }] }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true }));

    render(<SecurityDevicesCard mfaEnabled mfaMethod={null} onFactorAdded={vi.fn()} />);

    await screen.findByText('MacBook Touch ID');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByTestId('secdev-delete-pk-credential-1'));

    await screen.findByText('Passkey deleted');

    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/credential-1',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ currentPassword: 'current-password' }),
      }),
    ]);
  });

  it('rename on a merged row PATCHes the passkey and calls renameApproverDevice with the same value', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'Old name', lastUsedAt: null, credentialId: 'cred-1' }] }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, passkey: { id: 'pk1', name: 'New name' } }));
    listApproverDevicesMock.mockResolvedValueOnce([approverFixture({ label: 'Old name' })]);

    render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

    const row = await screen.findByTestId('secdev-row-pk-pk1');
    fireEvent.click(within(row).getByTestId('secdev-rename-pk-pk1'));
    fireEvent.change(within(row).getByTestId('secdev-rename-input-pk-pk1'), { target: { value: 'New name' } });
    fireEvent.click(within(row).getByTestId('secdev-rename-save-pk-pk1'));

    await waitFor(() => expect(renameApproverDeviceMock).toHaveBeenCalledWith('ad-1', 'New name'));
    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/pk1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'New name' }) }),
    ]);
  });

  it('starts passkey registration with password only when the account has no existing factor', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-1', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ passkey: { id: 'credential-1', name: 'MacBook Touch ID' } }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-1', name: 'MacBook Touch ID', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);
    const onFactorAdded = vi.fn();

    render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={onFactorAdded} />);

    await screen.findByText(/No security devices are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'MacBook Touch ID' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    // Unchecked: single-purpose add, byte-identical to pre-Task-6 behavior —
    // no /authenticator/register-grant call, no approverRegisterGrantId.
    fireEvent.click(screen.getByTestId('secdev-also-approver'));
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintStepUpGrantsMock).not.toHaveBeenCalled();
    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/register/options',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'current-password', name: 'MacBook Touch ID' }),
      }),
    ]);
    expect(createPasskeyCredentialMock).toHaveBeenCalledWith(registrationOptions);
    expect(fetchWithAuthMock.mock.calls[2]).toEqual([
      '/auth/passkeys/register/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'MacBook Touch ID', credential }),
      }),
    ]);
    expect(onFactorAdded).toHaveBeenCalledWith({ recoveryCodes: undefined });
  });

  it('mints a TOTP add_factor grant and sends stepUpGrantId to both register calls when the account has TOTP MFA', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-2', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ passkey: { id: 'credential-2', name: 'Work laptop' } }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-2', name: 'Work laptop', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);
    mintStepUpGrantsMock.mockResolvedValueOnce({ add_factor: 'grant-123' });

    render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

    await screen.findByText(/No security devices are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'Work laptop' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByTestId('passkey-stepup-code'), { target: { value: '123456' } });
    // Unchecked: single-purpose add_factor only — the dual-enroll (both grants)
    // path is covered separately below.
    fireEvent.click(screen.getByTestId('secdev-also-approver'));
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintStepUpGrantsMock).toHaveBeenCalledWith({ method: 'totp', code: '123456' }, ['add_factor']);
    expect(fetchWithAuthMock.mock.calls[1]).toEqual([
      '/auth/passkeys/register/options',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'current-password', name: 'Work laptop', stepUpGrantId: 'grant-123' }),
      }),
    ]);
    expect(fetchWithAuthMock.mock.calls[2]).toEqual([
      '/auth/passkeys/register/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Work laptop', credential, stepUpGrantId: 'grant-123' }),
      }),
    ]);
  });

  it('disables adding a passkey for SMS-method accounts and explains why', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));

    render(<SecurityDevicesCard mfaEnabled mfaMethod="sms" onFactorAdded={vi.fn()} />);

    await screen.findByTestId('passkey-stepup-sms-note');
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });

    const addButton = screen.getByRole('button', { name: 'Add passkey' }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(mintStepUpGrantsMock).not.toHaveBeenCalled();
    // Tier 'sms': add is already fully disabled, so the dual-enroll checkbox
    // is hidden rather than offered-and-disabled.
    expect(screen.queryByTestId('secdev-also-approver')).toBeNull();
  });

  it('mints both grants in one step-up and sends approverRegisterGrantId to verify (protected account)', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-3', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({
        success: true,
        passkey: { id: 'credential-3', name: 'Work laptop' },
        approver: { registered: true, isPlatformBound: true, deviceId: 'ad-9' },
      }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-3', name: 'Work laptop', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);
    mintStepUpGrantsMock.mockResolvedValueOnce({ add_factor: 'g-add', register_approver_device: 'g-reg' });

    render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

    await screen.findByText(/No security devices are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'Work laptop' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByTestId('passkey-stepup-code'), { target: { value: '123456' } });
    // Checkbox is checked by default — leave it as-is.
    expect((screen.getByTestId('secdev-also-approver') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintStepUpGrantsMock).toHaveBeenCalledWith(
      { method: 'totp', code: '123456' },
      ['add_factor', 'register_approver_device'],
    );
    const optionsCall = fetchWithAuthMock.mock.calls[1];
    expect(optionsCall[0]).toBe('/auth/passkeys/register/options');
    expect(JSON.parse(optionsCall[1].body).stepUpGrantId).toBe('g-add');
    expect(JSON.parse(optionsCall[1].body).approverRegisterGrantId).toBeUndefined();

    const verifyCall = fetchWithAuthMock.mock.calls[2];
    expect(verifyCall[0]).toBe('/auth/passkeys/register/verify');
    const verifyBody = JSON.parse(verifyCall[1].body);
    expect(verifyBody.stepUpGrantId).toBe('g-add');
    expect(verifyBody.approverRegisterGrantId).toBe('g-reg');

    // Approver list gets refreshed alongside the passkey list on success.
    await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
  });

  it('unchecking the box keeps the flow single-purpose', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-4', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, passkey: { id: 'credential-4', name: 'Work laptop' } }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-4', name: 'Work laptop', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);
    mintStepUpGrantsMock.mockResolvedValueOnce({ add_factor: 'g-add' });

    render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

    await screen.findByText(/No security devices are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'Work laptop' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByTestId('passkey-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('secdev-also-approver'));
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintStepUpGrantsMock).toHaveBeenCalledWith({ method: 'totp', code: '123456' }, ['add_factor']);
    const verifyCall = fetchWithAuthMock.mock.calls[2];
    expect(JSON.parse(verifyCall[1].body).approverRegisterGrantId).toBeUndefined();
  });

  it('uses the password register-grant fallback for unprotected accounts', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-5', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ registerGrantId: 'g-reg-password' }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({
        success: true,
        passkey: { id: 'credential-5', name: 'MacBook Touch ID' },
        approver: { registered: true, isPlatformBound: true, deviceId: 'ad-10' },
      }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-5', name: 'MacBook Touch ID', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);

    render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

    await screen.findByText(/No security devices are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'MacBook Touch ID' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    expect((screen.getByTestId('secdev-also-approver') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintStepUpGrantsMock).not.toHaveBeenCalled();
    const grantCall = fetchWithAuthMock.mock.calls[1];
    expect(grantCall[0]).toBe('/authenticator/register-grant');
    expect(JSON.parse(grantCall[1].body)).toEqual({ currentPassword: 'current-password' });

    const optionsCall = fetchWithAuthMock.mock.calls[2];
    expect(optionsCall[0]).toBe('/auth/passkeys/register/options');

    const verifyCall = fetchWithAuthMock.mock.calls[3];
    expect(verifyCall[0]).toBe('/auth/passkeys/register/verify');
    expect(JSON.parse(verifyCall[1].body).approverRegisterGrantId).toBe('g-reg-password');
  });

  it('degrades to passkey-only when the password register-grant fallback 403s stronger_factor_required', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-6', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ error: 'stronger_factor_required' }, false, 403))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, passkey: { id: 'credential-6', name: 'MacBook Touch ID' } }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-6', name: 'MacBook Touch ID', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);

    render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

    await screen.findByText(/No security devices are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'MacBook Touch ID' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    // Partial outcome, not a failure — the passkey add still proceeds.
    await screen.findByText(/Passkey added/);

    const verifyCall = fetchWithAuthMock.mock.calls[3];
    expect(verifyCall[0]).toBe('/auth/passkeys/register/verify');
    expect(JSON.parse(verifyCall[1].body).approverRegisterGrantId).toBeUndefined();
  });

  it('surfaces the degraded outcome when the server reports the approver grant was invalid', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-7', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({
        success: true,
        passkey: { id: 'credential-7', name: 'Work laptop' },
        approver: { registered: false, reason: 'grant_invalid' },
      }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-7', name: 'Work laptop', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);
    mintStepUpGrantsMock.mockResolvedValueOnce({ add_factor: 'g-add', register_approver_device: 'g-reg' });

    render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

    await screen.findByText(/No security devices are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'Work laptop' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByTestId('passkey-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    // Partial-success message: passkey added, approvals not enabled.
    await screen.findByText(/Approvals could not be enabled/);
  });

  it('appends a synced note when the newly-registered approver device is not platform-bound', async () => {
    const registrationOptions = { challenge: 'register-challenge' };
    const credential = { id: 'credential-8', type: 'public-key' };
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ options: registrationOptions }))
      .mockResolvedValueOnce(makeJsonResponse({
        success: true,
        passkey: { id: 'credential-8', name: 'iCloud Keychain' },
        approver: { registered: true, isPlatformBound: false, deviceId: 'ad-11' },
      }))
      .mockResolvedValueOnce(makeJsonResponse({ passkeys: [{ id: 'credential-8', name: 'iCloud Keychain', lastUsedAt: null }] }));
    createPasskeyCredentialMock.mockResolvedValueOnce(credential);
    mintStepUpGrantsMock.mockResolvedValueOnce({ add_factor: 'g-add', register_approver_device: 'g-reg' });

    render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

    await screen.findByText(/No security devices are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'iCloud Keychain' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByTestId('passkey-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText(/synced credential/);
  });

  describe('approvals-only register (spec §4.5)', () => {
    it('hides the approver-only form by default and reveals it on toggle click', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByText(/No security devices are registered/i);
      expect(screen.queryByTestId('secdev-approver-only-form')).toBeNull();

      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      expect(screen.getByTestId('secdev-approver-only-form')).toBeTruthy();
    });

    it('registers via TOTP re-auth when the account has TOTP MFA and no passkeys, then reloads the approver list', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));

      render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

      await screen.findByText(/No security devices are registered/i);
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-device-label-input'), {
        target: { value: 'My label' },
      });
      fireEvent.change(screen.getByTestId('approver-stepup-code'), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(registerApproverDeviceMock).toHaveBeenCalledWith('My label', { method: 'totp', code: '123456' }),
      );
      await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
    });

    it('registers via password re-auth when the account has no passkeys/TOTP', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByText(/No security devices are registered/i);
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-device-label-input'), {
        target: { value: 'My label' },
      });
      fireEvent.change(screen.getByTestId('approver-stepup-password'), {
        target: { value: 'hunter2' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(registerApproverDeviceMock).toHaveBeenCalledWith('My label', {
          method: 'password',
          password: 'hunter2',
        }),
      );
      await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
    });

    it('maps a 403 stronger_factor_required rejection to the "use your passkey or authenticator code" message', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));
      const err = Object.assign(new Error('stronger_factor_required'), { status: 403 });
      registerApproverDeviceMock.mockRejectedValueOnce(err);

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByText(/No security devices are registered/i);
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-device-label-input'), {
        target: { value: 'My label' },
      });
      fireEvent.change(screen.getByTestId('approver-stepup-password'), {
        target: { value: 'hunter2' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'error',
          message: 'Use your passkey or authenticator code instead — reload the page to update your options.',
        }),
      );
    });

    it('registers with the passkey tier when the user already has a passkey (StepUpPrompt shows the passkey note, no input)', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'Laptop', lastUsedAt: '2026-06-10T09:00:00.000Z', credentialId: 'cred-1' }] }),
      );

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByTestId('secdev-row-pk-pk1');
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      expect(screen.getByTestId('approver-stepup-passkey-note')).toBeTruthy();
      fireEvent.change(screen.getByTestId('approver-device-label-input'), {
        target: { value: 'My workstation' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(registerApproverDeviceMock).toHaveBeenCalledWith('My workstation', { method: 'passkey' }),
      );
    });

    it('maps a 401 with the credential-failure message on the TOTP tier to the incorrect-code message', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));
      const err = Object.assign(new Error('Invalid credentials'), { status: 401 });
      registerApproverDeviceMock.mockRejectedValueOnce(err);

      render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

      await screen.findByText(/No security devices are registered/i);
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-stepup-code'), {
        target: { value: '123456' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() => expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Incorrect code.' }));
    });

    it('maps a 401 whose message is NOT the credential-failure string to the session-expired message (not "Incorrect password")', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));
      const err = Object.assign(new Error('Invalid or expired token'), { status: 401 });
      registerApproverDeviceMock.mockRejectedValueOnce(err);

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByText(/No security devices are registered/i);
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-stepup-password'), {
        target: { value: 'hunter2' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'error',
          message: 'Session expired — reload the page and try again.',
        }),
      );
      expect(showToastMock).not.toHaveBeenCalledWith({ type: 'error', message: 'Incorrect password.' });
    });

    it('maps a 429 to the too-many-attempts message', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));
      const err = Object.assign(new Error('rate_limited'), { status: 429 });
      registerApproverDeviceMock.mockRejectedValueOnce(err);

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByText(/No security devices are registered/i);
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-stepup-password'), {
        target: { value: 'hunter2' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'error',
          message: 'Too many attempts — try again in a few minutes.',
        }),
      );
    });

    it('maps a WebAuthn NotAllowedError cancellation (no status) to the registration-cancelled message', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'Laptop', lastUsedAt: '2026-06-10T09:00:00.000Z', credentialId: 'cred-1' }] }),
      );
      const domException = Object.assign(new Error('The operation either timed out or was not allowed.'), {
        name: 'NotAllowedError',
      });
      registerApproverDeviceMock.mockRejectedValueOnce(domException);

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByTestId('secdev-row-pk-pk1');
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Registration was cancelled.' }),
      );
    });

    it('clears the re-auth value but keeps the label on a generic 403 (grant expired)', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));
      const err = Object.assign(new Error('some_other_error'), { status: 403 });
      registerApproverDeviceMock.mockRejectedValueOnce(err);

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByText(/No security devices are registered/i);
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-device-label-input'), {
        target: { value: 'My workstation' },
      });
      fireEvent.change(screen.getByTestId('approver-stepup-password'), {
        target: { value: 'hunter2' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'error',
          message: 'Verification expired — please verify again.',
        }),
      );
      expect((screen.getByTestId('approver-device-label-input') as HTMLInputElement).value).toBe('My workstation');
      expect((screen.getByTestId('approver-stepup-password') as HTMLInputElement).value).toBe('');
    });

    it('maps a 401 with the credential-failure message on the passkey tier to the passkey-verification-failed message', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'Laptop', lastUsedAt: '2026-06-10T09:00:00.000Z', credentialId: 'cred-1' }] }),
      );
      const err = Object.assign(new Error('Invalid credentials'), { status: 401 });
      registerApproverDeviceMock.mockRejectedValueOnce(err);

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByTestId('secdev-row-pk-pk1');
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-device-label-input'), {
        target: { value: 'My workstation' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'error',
          message: 'Passkey verification failed — try again.',
        }),
      );
    });

    it('maps a 401 with the credential-failure message on the password tier to the incorrect-password message and retains the device name', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ passkeys: [] }));
      const err = Object.assign(new Error('Invalid credentials'), { status: 401 });
      registerApproverDeviceMock.mockRejectedValueOnce(err);

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByText(/No security devices are registered/i);
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-device-label-input'), {
        target: { value: 'Home PC' },
      });
      fireEvent.change(screen.getByTestId('approver-stepup-password'), {
        target: { value: 'wrongpass' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'error',
          message: 'Incorrect password.',
        }),
      );
      expect((screen.getByTestId('approver-device-label-input') as HTMLInputElement).value).toBe('Home PC');
    });

    it('maps an AbortError (WebAuthn cancellation on passkey tier) to the registration-cancelled message', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'Laptop', lastUsedAt: '2026-06-10T09:00:00.000Z', credentialId: 'cred-1' }] }),
      );
      const abortErr = Object.assign(new Error('Operation aborted'), {
        name: 'AbortError',
      });
      registerApproverDeviceMock.mockRejectedValueOnce(abortErr);

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      await screen.findByTestId('secdev-row-pk-pk1');
      fireEvent.click(screen.getByTestId('secdev-approver-only-toggle'));

      fireEvent.change(screen.getByTestId('approver-device-label-input'), {
        target: { value: 'My device' },
      });
      fireEvent.click(screen.getByTestId('approver-device-register'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'error',
          message: 'Registration was cancelled.',
        }),
      );
    });
  });

  describe('"Enable approvals" row action (Task 9 — adopt an existing passkey)', () => {
    it('shows the action only on a sign-in-only row, never on a merged row', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({
          passkeys: [
            { id: 'pk1', name: 'Sign-in only', lastUsedAt: null, credentialId: 'cred-1' },
            { id: 'pk2', name: 'Merged', lastUsedAt: null, credentialId: 'cred-2' },
          ],
        }),
      );
      listApproverDevicesMock.mockResolvedValueOnce([approverFixture({ id: 'ad-2', credentialId: 'cred-2' })]);

      render(<SecurityDevicesCard mfaEnabled={false} mfaMethod={null} onFactorAdded={vi.fn()} />);

      const signInOnlyRow = await screen.findByTestId('secdev-row-pk-pk1');
      expect(within(signInOnlyRow).getByTestId('secdev-enable-approvals-pk-pk1')).toBeTruthy();

      const mergedRow = await screen.findByTestId('secdev-row-pk-pk2');
      expect(within(mergedRow).queryByTestId('secdev-enable-approvals-pk-pk2')).toBeNull();
    });

    it('TOTP tier: mints a register_approver_device grant via mintStepUpGrants then adopts, refreshing both lists', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'Laptop', lastUsedAt: null, credentialId: 'cred-1' }] }),
      );
      mintStepUpGrantsMock.mockResolvedValueOnce({ register_approver_device: 'g-adopt-1' });
      // Initial load: no approver devices yet — this row shows "Enable approvals".
      listApproverDevicesMock.mockResolvedValueOnce([]);
      // Post-adopt refresh: the "adopted" approver shares this row's
      // credentialId, so mergeSecurityDevices attaches it to the SAME row —
      // asserting on this (not just the call count) proves the actual
      // acceptance criterion: the badge appears after enabling approvals.
      listApproverDevicesMock.mockResolvedValueOnce([approverFixture({ credentialId: 'cred-1' })]);

      render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

      const row = await screen.findByTestId('secdev-row-pk-pk1');
      fireEvent.click(within(row).getByTestId('secdev-enable-approvals-pk-pk1'));
      fireEvent.change(screen.getByTestId('secdev-adopt-code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('secdev-enable-approvals-confirm-pk-pk1'));

      await waitFor(() =>
        expect(mintStepUpGrantsMock).toHaveBeenCalledWith(
          { method: 'totp', code: '123456' },
          ['register_approver_device'],
        ),
      );
      await waitFor(() =>
        expect(adoptPasskeyAsApproverMock).toHaveBeenCalledWith('g-adopt-1', 'cred-1', 'Laptop'),
      );
      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'success',
          message: 'This device can now approve requests.',
        }),
      );
      // Approver list refetched (initial load + post-adopt refresh).
      await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
      // The real merge outcome: the row now carries the Approvals badge.
      await waitFor(() => expect(within(row).getByTestId('secdev-badge-approvals')).toBeTruthy());
    });

    it('maps a 409 from adopt to the already-registered message', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ passkeys: [{ id: 'pk1', name: 'Laptop', lastUsedAt: null, credentialId: 'cred-1' }] }),
      );
      mintStepUpGrantsMock.mockResolvedValueOnce({ register_approver_device: 'g-adopt-2' });
      const err = Object.assign(new Error('already_registered'), { status: 409 });
      adoptPasskeyAsApproverMock.mockRejectedValueOnce(err);

      render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

      const row = await screen.findByTestId('secdev-row-pk-pk1');
      fireEvent.click(within(row).getByTestId('secdev-enable-approvals-pk-pk1'));
      fireEvent.change(screen.getByTestId('secdev-adopt-code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('secdev-enable-approvals-confirm-pk-pk1'));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith({
          type: 'error',
          message: 'This device is already registered for approvals.',
        }),
      );
    });
  });
});
