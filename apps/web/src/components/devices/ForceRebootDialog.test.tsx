import '@/lib/i18n';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { forceRebootMock, mintMock, fetchMock } = vi.hoisted(() => ({
  forceRebootMock: vi.fn(),
  mintMock: vi.fn(),
  fetchMock: vi.fn(),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../../services/deviceActions', () => ({ forceRebootDevice: forceRebootMock }));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintMock,
  StepUpMintError: class StepUpMintError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));

import ForceRebootDialog from './ForceRebootDialog';

const WINDOWS = { id: 'd1', hostname: 'LAPTOP-07', os: 'windows' as const };
const MAC = { id: 'd2', hostname: 'mac-studio', os: 'macos' as const };
const denial = (code: string, status = 403) => Object.assign(new Error(code), { status, code });

function renderDialog(props: Partial<React.ComponentProps<typeof ForceRebootDialog>> = {}) {
  const onClose = vi.fn();
  const onCompleted = vi.fn();
  render(<ForceRebootDialog open device={WINDOWS} onClose={onClose} onCompleted={onCompleted} {...props} />);
  return { onClose, onCompleted };
}

const confirmButton = () => screen.getByTestId('force-reboot-confirm');
const typeHostname = (value: string) => userEvent.type(screen.getByTestId('force-reboot-hostname'), value);

describe('ForceRebootDialog (#8729)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () => (path === '/users/me' ? { mfaMethod: 'totp' } : { passkeys: [] }),
    }));
    forceRebootMock.mockResolvedValue({ id: 'cmd-1', type: 'force_reboot', delivery: 'delivered' });
    mintMock.mockResolvedValue('grant-1');
  });

  it('shows the hostname, the OS and the exact command that will run on Windows', () => {
    renderDialog();
    expect(screen.getByTestId('force-reboot-command')).toHaveTextContent('shutdown /r /f /t 0');
    expect(screen.getByTestId('force-reboot-dialog')).toHaveTextContent('LAPTOP-07');
    expect(screen.getByTestId('force-reboot-dialog')).toHaveTextContent('Windows');
    expect(screen.queryByTestId('force-reboot-no-effect')).not.toBeInTheDocument();
  });

  it('says force changes nothing on macOS and Linux', () => {
    renderDialog({ device: MAC });
    expect(screen.getByTestId('force-reboot-command')).toHaveTextContent('shutdown -r +0');
    expect(screen.getByTestId('force-reboot-no-effect')).toBeInTheDocument();
  });

  it('keeps Confirm disabled until the hostname is typed exactly', async () => {
    renderDialog();
    expect(confirmButton()).toBeDisabled();
    await typeHostname('laptop-07');
    expect(confirmButton()).toBeDisabled();
    await userEvent.clear(screen.getByTestId('force-reboot-hostname'));
    await typeHostname('LAPTOP-0');
    expect(confirmButton()).toBeDisabled();
    await typeHostname('7');
    expect(confirmButton()).toBeEnabled();
  });

  it('submits without a grant first and closes on success', async () => {
    const { onClose, onCompleted } = renderDialog();
    await typeHostname('LAPTOP-07');
    await userEvent.click(confirmButton());
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(forceRebootMock).toHaveBeenCalledWith('d1', {});
    expect(mintMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('asks for a factor only after the server requires step-up, then mints a grant bound to this device', async () => {
    forceRebootMock.mockRejectedValueOnce(denial('STEP_UP_REQUIRED'));
    const { onCompleted } = renderDialog();
    await typeHostname('LAPTOP-07');
    await userEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByTestId('force-reboot-stepup-code')).toBeInTheDocument());
    // The typed hostname cannot be changed once the factor step is open.
    expect(screen.getByTestId('force-reboot-hostname')).toBeDisabled();
    expect(confirmButton()).toBeDisabled();
    await userEvent.type(screen.getByTestId('force-reboot-stepup-code'), '123456');
    await userEvent.click(confirmButton());

    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(mintMock).toHaveBeenCalledWith({
      operation: 'device_force_reboot',
      resource: { deviceId: 'd1' },
      reauth: { method: 'totp', code: '123456' },
    });
    expect(forceRebootMock).toHaveBeenLastCalledWith('d1', { stepUpGrant: 'grant-1' });
  });

  // Review fix: a second STEP_UP_REQUIRED (grant spent by a double submit, or
  // MFA reset in another tab) must say so, not silently clear the code.
  it('explains a step-up that fails again instead of silently clearing the code', async () => {
    forceRebootMock
      .mockRejectedValueOnce(denial('STEP_UP_REQUIRED'))
      .mockRejectedValueOnce(denial('STEP_UP_REQUIRED'));
    const { onCompleted } = renderDialog();
    await typeHostname('LAPTOP-07');
    await userEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByTestId('force-reboot-stepup-code')).toBeInTheDocument());
    await userEvent.type(screen.getByTestId('force-reboot-stepup-code'), '123456');
    await userEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByTestId('force-reboot-error')).toHaveTextContent(/verification/i));
    expect(screen.getByTestId('force-reboot-stepup-code')).toHaveValue('');
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it.each([
    ['DEVICE_OFFLINE', 409, /not online/i],
    ['AGENT_UPGRADE_REQUIRED', 409, /agent/i],
    ['MFA_REQUIRED', 403, /multi-factor|MFA/i],
  ])('shows a clear error for %s and stays open', async (code, status, text) => {
    forceRebootMock.mockRejectedValueOnce(denial(code, status));
    const { onClose } = renderDialog();
    await typeHostname('LAPTOP-07');
    await userEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByTestId('force-reboot-error')).toHaveTextContent(text));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('force-reboot-stepup-code')).not.toBeInTheDocument();
  });

  it('clears the typed hostname when reopened', async () => {
    const { rerender } = render(
      <ForceRebootDialog open device={WINDOWS} onClose={vi.fn()} onCompleted={vi.fn()} />,
    );
    await typeHostname('LAPTOP-07');
    rerender(<ForceRebootDialog open={false} device={WINDOWS} onClose={vi.fn()} onCompleted={vi.fn()} />);
    rerender(<ForceRebootDialog open device={WINDOWS} onClose={vi.fn()} onCompleted={vi.fn()} />);
    expect(screen.getByTestId('force-reboot-hostname')).toHaveValue('');
    expect(confirmButton()).toBeDisabled();
  });
});
