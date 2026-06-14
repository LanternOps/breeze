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
    render(<ApproverDevicesSection />);

    const row = await screen.findByTestId('approver-device-dev-1');
    expect(row).toBeTruthy();
    expect(screen.getByTestId('approver-device-label-dev-1').textContent).toContain('Front-desk laptop');
    expect(screen.getByTestId('approver-device-platform-badge-dev-1')).toBeTruthy();
    expect(listApproverDevicesMock).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when no devices are registered', async () => {
    listApproverDevicesMock.mockResolvedValueOnce([]);
    render(<ApproverDevicesSection />);

    expect(await screen.findByTestId('approver-devices-empty')).toBeTruthy();
  });

  it('registers this device via registerApproverDevice and reloads the list', async () => {
    render(<ApproverDevicesSection />);
    await screen.findByTestId('approver-device-dev-1');

    fireEvent.change(screen.getByTestId('approver-device-label-input'), {
      target: { value: 'My workstation' },
    });
    fireEvent.click(screen.getByTestId('approver-device-register'));

    await waitFor(() => expect(registerApproverDeviceMock).toHaveBeenCalledWith('My workstation'));
    // List is reloaded after a successful registration.
    await waitFor(() => expect(listApproverDevicesMock).toHaveBeenCalledTimes(2));
  });

  it('revokes a device after confirming in the dialog', async () => {
    render(<ApproverDevicesSection />);
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
