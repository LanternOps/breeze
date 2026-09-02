import '@/lib/i18n';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { enterMock, bulkMock, mintMock } = vi.hoisted(() => ({
  enterMock: vi.fn(),
  bulkMock: vi.fn(),
  mintMock: vi.fn(),
}));

vi.mock('../../services/deviceActions', () => ({
  enterMaintenanceMode: enterMock,
  bulkEnterMaintenanceMode: bulkMock,
}));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintMock,
  StepUpMintError: class StepUpMintError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));

import MaintenanceModeDialog from './MaintenanceModeDialog';

const DEVICE = { id: 'd1', hostname: 'host-a' };
const stepUpDenial = Object.assign(new Error('Step-up required'), {
  status: 403,
  code: 'STEP_UP_REQUIRED',
});

function renderDialog(
  props: Partial<React.ComponentProps<typeof MaintenanceModeDialog>> = {},
) {
  return render(
    <MaintenanceModeDialog
      open
      devices={[DEVICE]}
      onClose={vi.fn()}
      onCompleted={vi.fn()}
      {...props}
    />,
  );
}

describe('MaintenanceModeDialog (RMM-QA-176 D10)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('will not submit a reason shorter than the server minimum', async () => {
    renderDialog();
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'ab');
    expect(screen.getByTestId('maintenance-submit')).toBeDisabled();
  });

  it('will not submit a whitespace-padded reason that trims below the minimum', async () => {
    // maintenanceReasonSchema is .trim().min(3): '  a  ' trims to 'a' and the
    // server 400s it. The client must count what the server counts.
    renderDialog();
    await userEvent.type(screen.getByTestId('maintenance-reason'), '  a  ');
    expect(screen.getByTestId('maintenance-submit')).toBeDisabled();
  });

  it('submits WITHOUT a grant first, then reveals the factor step on 403 STEP_UP_REQUIRED', async () => {
    enterMock.mockRejectedValueOnce(stepUpDenial);
    renderDialog();
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'scheduled patching');
    await userEvent.click(screen.getByTestId('maintenance-submit'));

    await waitFor(() => expect(screen.getByTestId('maintenance-stepup-code')).toBeInTheDocument());
    // The client never decides whether a factor is needed — the SERVER did.
    expect(enterMock.mock.calls[0][1]).not.toHaveProperty('stepUpGrant');
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('mints against the SAME canonical resource it submitted, then resubmits carrying the grant', async () => {
    enterMock
      .mockRejectedValueOnce(stepUpDenial)
      .mockResolvedValueOnce({ success: true, action: 'enable' });
    mintMock.mockResolvedValueOnce('grant-1');
    const onCompleted = vi.fn();
    renderDialog({ onCompleted });
    // Padded on purpose: the digest is over the TRIMMED reason.
    await userEvent.type(screen.getByTestId('maintenance-reason'), '  scheduled patching  ');
    await userEvent.click(screen.getByTestId('maintenance-submit'));
    await userEvent.type(await screen.findByTestId('maintenance-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('maintenance-submit'));

    await waitFor(() => expect(enterMock).toHaveBeenCalledTimes(2));
    // A digest mismatch is indistinguishable from a missing grant (403), so the
    // minted resource MUST be the canonical form of the body — asserted, not
    // assumed. Whole-object equality, so an added or dropped field fails too.
    expect(mintMock).toHaveBeenCalledWith({
      operation: 'device_maintenance',
      resource: { deviceIds: ['d1'], reason: 'scheduled patching', durationHours: 4 },
      reauth: { method: 'totp', code: '123456' },
    });
    expect(enterMock.mock.calls[1]).toEqual([
      'd1',
      { reason: 'scheduled patching', durationHours: 4, stepUpGrant: 'grant-1' },
    ]);
    await waitFor(() =>
      expect(onCompleted).toHaveBeenCalledWith({ success: true, action: 'enable' }),
    );
  });

  it('shows the MFA copy, not the factor step, on 403 MFA_REQUIRED', async () => {
    enterMock.mockRejectedValueOnce(
      Object.assign(new Error('MFA required'), { status: 403, code: 'MFA_REQUIRED' }),
    );
    renderDialog();
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'scheduled patching');
    await userEvent.click(screen.getByTestId('maintenance-submit'));
    await waitFor(() => expect(screen.getByText(/complete mfa sign-in/i)).toBeInTheDocument());
    expect(screen.queryByTestId('maintenance-stepup-code')).not.toBeInTheDocument();
  });

  it('surfaces a 409 MAINTENANCE_STATE_CONFLICT message verbatim', async () => {
    enterMock.mockRejectedValueOnce(
      Object.assign(new Error('Cannot enter maintenance mode while the device is "decommissioned"'), {
        status: 409,
        code: 'MAINTENANCE_STATE_CONFLICT',
      }),
    );
    renderDialog();
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'scheduled patching');
    await userEvent.click(screen.getByTestId('maintenance-submit'));
    await waitFor(() =>
      expect(
        screen.getByText('Cannot enter maintenance mode while the device is "decommissioned"'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('maintenance-stepup-code')).not.toBeInTheDocument();
  });

  it('a password-only account gets the add-an-authenticator state and NO submit button', () => {
    // pickReauthTier returns 'password' for SMS-only/password-only accounts, and
    // there is no authenticated step-up SMS sender — so the dialog says so
    // instead of offering a submit that can only 403.
    renderDialog({ passkeyCount: 0, mfaMethod: 'sms' });
    expect(screen.getByText(/authenticator app or passkey/i)).toBeInTheDocument();
    expect(screen.queryByTestId('maintenance-submit')).not.toBeInTheDocument();
  });

  it('the bulk variant makes ONE call carrying every id', async () => {
    bulkMock.mockResolvedValueOnce({
      succeeded: [{ deviceId: 'd1' }, { deviceId: 'd2' }],
      failed: [],
    });
    renderDialog({ devices: [DEVICE, { id: 'd2', hostname: 'host-b' }] });
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'scheduled patching');
    await userEvent.click(screen.getByTestId('maintenance-submit'));

    await waitFor(() => expect(bulkMock).toHaveBeenCalledTimes(1));
    expect(bulkMock.mock.calls[0][0].deviceIds).toEqual(['d1', 'd2']);
    expect(enterMock).not.toHaveBeenCalled();
  });

  it('hands an all-failed bulk 200 to onCompleted UNCHANGED — a 200 is not a success', async () => {
    // POST /devices/bulk/maintenance answers 200 even when every device failed
    // preflight. The dialog must not translate "the request succeeded" into
    // "the operation succeeded"; the parent renders the honest outcome.
    const result = {
      succeeded: [],
      failed: [{ deviceId: 'd1', code: 'STATE_CONFLICT', message: 'nope' }],
    };
    bulkMock.mockResolvedValueOnce(result);
    const onCompleted = vi.fn();
    renderDialog({ devices: [DEVICE, { id: 'd2', hostname: 'host-b' }], onCompleted });
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'scheduled patching');
    await userEvent.click(screen.getByTestId('maintenance-submit'));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith(result));
  });
});
