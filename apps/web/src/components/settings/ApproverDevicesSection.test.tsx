import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApproverDevice } from '../../stores/authenticator';

const {
  listApproverDevicesMock,
  registerApproverDeviceMock,
  revokeApproverDeviceMock,
  renameApproverDeviceMock,
  showToastMock,
} = vi.hoisted(() => ({
  listApproverDevicesMock: vi.fn(),
  registerApproverDeviceMock: vi.fn(),
  revokeApproverDeviceMock: vi.fn(),
  renameApproverDeviceMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('../../stores/authenticator', () => ({
  listApproverDevices: listApproverDevicesMock,
  registerApproverDevice: registerApproverDeviceMock,
  revokeApproverDevice: revokeApproverDeviceMock,
  renameApproverDevice: renameApproverDeviceMock,
}));

vi.mock('../shared/Toast', () => ({
  showToast: showToastMock,
}));

import ApproverDevicesSection from './ApproverDevicesSection';

const okResponse = (): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ success: true }) }) as unknown as Response;

const deviceFixture = (over: Partial<ApproverDevice> = {}): ApproverDevice => ({
  id: 'dev-1',
  label: 'Front-desk laptop',
  kind: 'platform',
  isPlatformBound: true,
  createdAt: '2026-06-01T12:00:00.000Z',
  lastUsedAt: '2026-06-10T09:00:00.000Z',
  disabledAt: null,
  ...over,
});

describe('ApproverDevicesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listApproverDevicesMock.mockResolvedValue([deviceFixture()]);
    registerApproverDeviceMock.mockResolvedValue(undefined);
    revokeApproverDeviceMock.mockResolvedValue(okResponse());
    renameApproverDeviceMock.mockResolvedValue(okResponse());
  });

  it('lists approver devices with label, platform-bound badge, and dates', async () => {
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    const row = await screen.findByTestId('approver-device-dev-1');
    expect(row).toBeTruthy();
    expect(screen.getByTestId('approver-device-label-dev-1').textContent).toContain('Front-desk laptop');
    expect(screen.getByTestId('approver-device-platform-badge-dev-1')).toBeTruthy();
    expect(listApproverDevicesMock).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when no devices are registered', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    expect(await screen.findByTestId('approver-devices-empty')).toBeTruthy();
  });

  it('registers this device via registerApproverDevice (passkey tier) and reloads the list', async () => {
    render(<ApproverDevicesSection passkeyCount={1} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-device-label-input'), {
      target: { value: 'My workstation' },
    });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(registerApproverDeviceMock).toHaveBeenCalledWith('My workstation', { method: 'passkey' }),
    );
    // List is reloaded after a successful registration.
    await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
  });

  it('registers via password re-auth when the user has no passkey/TOTP', async () => {
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    // Submit is disabled until a password is entered.
    expect(screen.getByTestId('approver-device-register')).toBeDisabled();

    fireEvent.change(screen.getByTestId('approver-stepup-password'), {
      target: { value: 'hunter2' },
    });
    expect(screen.getByTestId('approver-device-register')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(registerApproverDeviceMock).toHaveBeenCalledWith('This device', {
        method: 'password',
        password: 'hunter2',
      }),
    );
    await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
  });

  it('shows an incorrect-password error and preserves the label on a 401', async () => {
    const err = Object.assign(new Error('Verification failed.'), { status: 401 });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-device-label-input'), {
      target: { value: 'My workstation' },
    });
    fireEvent.change(screen.getByTestId('approver-stepup-password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Incorrect password.' }));
    expect((screen.getByTestId('approver-device-label-input') as HTMLInputElement).value).toBe('My workstation');
  });

  it('clears the re-auth value but keeps the label on a 403 (grant expired)', async () => {
    const err = Object.assign(new Error('Grant expired.'), { status: 403 });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-device-label-input'), {
      target: { value: 'My workstation' },
    });
    fireEvent.change(screen.getByTestId('approver-stepup-password'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Verification expired — please verify again.' }),
    );
    expect((screen.getByTestId('approver-device-label-input') as HTMLInputElement).value).toBe('My workstation');
    expect((screen.getByTestId('approver-stepup-password') as HTMLInputElement).value).toBe('');
  });

  it('shows a passkey-specific error (not "Incorrect password") on a 401 in the passkey tier', async () => {
    const err = Object.assign(new Error('Verification failed.'), { status: 401 });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={1} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({ type: 'error', message: 'Passkey verification failed — try again.' }),
    );
    expect(showToastMock).not.toHaveBeenCalledWith({ type: 'error', message: 'Incorrect password.' });
  });

  it('shows stronger-factor guidance on a 403 whose message is stronger_factor_required', async () => {
    const err = Object.assign(new Error('stronger_factor_required'), { status: 403 });
    registerApproverDeviceMock.mockRejectedValueOnce(err);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

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
        message: 'Use your passkey or authenticator code instead — reload the page to update your options.',
      }),
    );
  });

  it('lists a registered mobile_hw_key phone alongside the register-this-browser action', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([
      deviceFixture({
        id: 'd1',
        kind: 'mobile_hw_key',
        label: 'iPhone 16 Pro',
        isPlatformBound: true,
        lastUsedAt: null,
      }),
    ]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    await waitFor(() => screen.getByText('iPhone 16 Pro'));
    expect(screen.getByTestId('approver-device-d1')).toBeTruthy();
    // A device that has never been used yet (lastUsedAt === null) shows the
    // pending badge until it completes its first approval.
    expect(screen.getByTestId('approver-device-pending-d1')).toBeTruthy();
    // The browser-registration affordance is reframed as an additive, optional
    // path below the list (not the only way to get an approver device).
    expect(screen.getByRole('heading', { name: /register this browser/i })).toBeTruthy();
  });

  it('points unregistered users to the mobile app in the empty state', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([]);
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);

    const empty = await screen.findByTestId('approver-devices-empty');
    expect(empty.textContent).toMatch(/mobile app/i);
  });

  it('revokes a device after confirming in the dialog', async () => {
    render(<ApproverDevicesSection passkeyCount={0} mfaMethod={null} />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.click(screen.getByTestId('approver-device-revoke-dev-1'));
    // A confirm dialog appears before any network call.
    const confirmBtn = await screen.findByTestId('approver-device-revoke-confirm');
    expect(revokeApproverDeviceMock).not.toHaveBeenCalled();

    fireEvent.click(confirmBtn);

    await waitFor(() => expect(revokeApproverDeviceMock).toHaveBeenCalledWith('dev-1'));
    await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
  });
});
