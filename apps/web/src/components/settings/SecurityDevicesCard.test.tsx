import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApproverDevice } from '../../stores/authenticator';

const { fetchWithAuthMock, createPasskeyCredentialMock, mintAddFactorStepUpGrantMock, MockStepUpError } = vi.hoisted(() => {
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
    mintAddFactorStepUpGrantMock: vi.fn(),
    MockStepUpError,
  };
});

const {
  listApproverDevicesMock,
  revokeApproverDeviceMock,
  renameApproverDeviceMock,
  showToastMock,
} = vi.hoisted(() => ({
  listApproverDevicesMock: vi.fn(),
  revokeApproverDeviceMock: vi.fn(),
  renameApproverDeviceMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  createPasskeyCredential: createPasskeyCredentialMock,
  mintAddFactorStepUpGrant: mintAddFactorStepUpGrantMock,
  StepUpError: MockStepUpError,
}));

vi.mock('../../stores/authenticator', () => ({
  listApproverDevices: listApproverDevicesMock,
  revokeApproverDevice: revokeApproverDeviceMock,
  renameApproverDevice: renameApproverDeviceMock,
}));

vi.mock('../shared/Toast', () => ({
  showToast: showToastMock,
}));

// Passthrough mock, per the brief: keep runAction's real request→success/error
// shape but skip its dependency on the real Toast module's DOM listener setup.
vi.mock('../../lib/runAction', () => ({
  runAction: vi.fn(async (opts: { request: () => Promise<Response>; errorFallback: string; successMessage?: string }) => {
    const response = await opts.request();
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (data && typeof data === 'object' && 'error' in data ? (data as any).error : undefined) ?? opts.errorFallback;
      showToastMock({ type: 'error', message });
      const err = new Error(message) as Error & { status: number };
      err.name = 'ActionError';
      err.status = response.status;
      throw err;
    }
    if (opts.successMessage) showToastMock({ type: 'success', message: opts.successMessage });
    return data;
  }),
  ActionError: class ActionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ActionError';
      this.status = status;
    }
  },
}));

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
    revokeApproverDeviceMock.mockResolvedValue(okApproverResponse());
    renameApproverDeviceMock.mockResolvedValue(okApproverResponse());
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

    await screen.findByText(/No passkeys are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'MacBook Touch ID' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintAddFactorStepUpGrantMock).not.toHaveBeenCalled();
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
    mintAddFactorStepUpGrantMock.mockResolvedValueOnce('grant-123');

    render(<SecurityDevicesCard mfaEnabled mfaMethod="totp" onFactorAdded={vi.fn()} />);

    await screen.findByText(/No passkeys are registered/i);
    fireEvent.change(screen.getByLabelText(/Passkey name/i), { target: { value: 'Work laptop' } });
    fireEvent.change(screen.getByLabelText(/Current password/i, { selector: '#passkey-password' }), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByTestId('passkey-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    await screen.findByText('Passkey added');

    expect(mintAddFactorStepUpGrantMock).toHaveBeenCalledWith({ method: 'totp', code: '123456' });
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
    expect(mintAddFactorStepUpGrantMock).not.toHaveBeenCalled();
  });
});
