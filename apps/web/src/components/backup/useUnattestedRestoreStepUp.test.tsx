import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { runAction } from '@/lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import {
  suppressUnattestedRestoreStepUpToast,
  useUnattestedRestoreStepUp,
  type UnattestedRestoreExtras,
} from './useUnattestedRestoreStepUp';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (input: unknown) => showToastMock(input) }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const RESOURCE = {
  snapshotId: '11111111-1111-4111-8111-111111111111',
  targetDeviceId: '22222222-2222-4222-8222-222222222222',
  commandType: 'backup_restore',
};
const stepUpBody = (method: 'mfa' | 'confirm', reason = 'unattested_legacy') => ({
  error: 'Confirm the restore.',
  code: 'STEP_UP_REQUIRED',
  stepUp: { operation: 'backup_unattested_restore', method, reason, resource: RESOURCE },
});
const enrolBody = (reason = 'unattested_legacy') => ({
  error: 'Enrol a second factor to confirm this restore.',
  code: 'MFA_ENROLLMENT_REQUIRED',
  stepUp: { operation: 'backup_unattested_restore', method: 'enrol', reason, resource: RESOURCE },
});

/** A restore button whose submit goes through runAction, as every wired component does. */
function Harness({ onError }: { onError?: (err: unknown) => void }) {
  const stepUp = useUnattestedRestoreStepUp();
  const [done, setDone] = useState(false);
  const submit = async (extras: UnattestedRestoreExtras) => {
    await runAction({
      request: () => fetchWithAuth('/backup/restore', { method: 'POST', body: JSON.stringify({ snapshotId: 's', ...extras }) }),
      errorFallback: 'Failed to start restore',
      suppressErrorToast: suppressUnattestedRestoreStepUpToast,
    });
    setDone(true);
  };
  return (
    <div>
      <button onClick={() => void stepUp.run(submit).catch((err) => onError?.(err))}>Start restore</button>
      {stepUp.prompt}
      {done && <p>restore started</p>}
    </div>
  );
}

function restoreBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => url === '/backup/restore')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe('useUnattestedRestoreStepUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('turns a step-up request into a two-factor prompt and resubmits with the minted grant', async () => {
    let restoreCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/backup/restore') {
        restoreCalls += 1;
        return restoreCalls === 1 ? json(stepUpBody('mfa'), 403) : json({ id: 'restore-1' }, 201);
      }
      if (url === '/users/me') return json({ mfaMethod: 'totp' });
      if (url === '/auth/passkeys') return json([]);
      if (url === '/auth/mfa/step-up' && init?.method === 'POST') return json({ stepUpGrantId: 'grant-1' });
      return json({}, 404);
    });

    render(<Harness />);
    fireEvent.click(screen.getByText('Start restore'));

    const prompt = await screen.findByTestId('unattested-restore-stepup');
    expect(prompt.textContent).toMatch(/no integrity attestation/i);
    // The 403 is the prompt, not a failure.
    expect(showToastMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('unattested-restore-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('unattested-restore-stepup-confirm'));

    await screen.findByText('restore started');
    const mint = fetchMock.mock.calls.find(([url]) => url === '/auth/mfa/step-up')!;
    expect(JSON.parse(String((mint[1] as RequestInit).body))).toEqual({
      method: 'totp',
      code: '123456',
      operation: 'backup_unattested_restore',
      resource: RESOURCE,
    });
    expect(restoreBodies()).toEqual([{ snapshotId: 's' }, { snapshotId: 's', stepUpGrant: 'grant-1' }]);
    await waitFor(() => expect(screen.queryByTestId('unattested-restore-stepup')).toBeNull());
  });

  it('on a deployment without two-factor authentication, an explicit confirmation resubmits the restore', async () => {
    let restoreCalls = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/backup/restore') {
        restoreCalls += 1;
        return restoreCalls === 1 ? json(stepUpBody('confirm'), 403) : json({ id: 'restore-1' }, 201);
      }
      return json({}, 404);
    });

    render(<Harness />);
    fireEvent.click(screen.getByText('Start restore'));
    await screen.findByTestId('unattested-restore-stepup');
    expect(screen.queryByTestId('unattested-restore-stepup-code')).toBeNull();

    fireEvent.click(screen.getByTestId('unattested-restore-stepup-confirm'));
    await screen.findByText('restore started');
    expect(restoreBodies()).toEqual([{ snapshotId: 's' }, { snapshotId: 's', confirmUnattestedRestore: true }]);
    expect(fetchMock.mock.calls.some(([url]) => url === '/auth/mfa/step-up')).toBe(false);
  });

  it('explains a device-local backup restored onto another device', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/backup/restore' ? json(stepUpBody('confirm', 'producer_only_other_target'), 403) : json({}, 404));
    render(<Harness />);
    fireEvent.click(screen.getByText('Start restore'));
    const prompt = await screen.findByTestId('unattested-restore-stepup');
    expect(prompt.textContent).toMatch(/only the original device can check/i);
  });

  it('cancel closes the prompt without resubmitting', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/backup/restore' ? json(stepUpBody('confirm'), 403) : json({}, 404));
    render(<Harness />);
    fireEvent.click(screen.getByText('Start restore'));
    await screen.findByTestId('unattested-restore-stepup');
    fireEvent.click(screen.getByTestId('unattested-restore-stepup-cancel'));
    await waitFor(() => expect(screen.queryByTestId('unattested-restore-stepup')).toBeNull());
    expect(restoreBodies()).toHaveLength(1);
  });

  it('any other failure is passed back to the caller, which already surfaced it', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'This backup is still being checked.', code: 'attestation_pending' }, 409));
    const onError = vi.fn();
    render(<Harness onError={onError} />);
    fireEvent.click(screen.getByText('Start restore'));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('unattested-restore-stepup')).toBeNull();
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('a user without a second factor is sent to enrol one, then Retry resumes with the two-factor step-up', async () => {
    let restoreCalls = 0;
    let enrolled = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/backup/restore') {
        restoreCalls += 1;
        if (restoreCalls === 1) return json(enrolBody(), 403);
        if (restoreCalls === 2) return json(stepUpBody('mfa'), 403);
        return json({ id: 'restore-1' }, 201);
      }
      if (url === '/users/me') return json({ mfaMethod: enrolled ? 'totp' : null });
      if (url === '/auth/passkeys') return json([]);
      if (url === '/auth/mfa/step-up' && init?.method === 'POST') return json({ stepUpGrantId: 'grant-1' });
      return json({}, 404);
    });

    render(<Harness />);
    fireEvent.click(screen.getByText('Start restore'));

    const prompt = await screen.findByTestId('unattested-restore-stepup');
    expect(prompt.textContent).toMatch(/your account has none yet/i);
    // The 403 is the enrolment prompt, not a failure.
    expect(showToastMock).not.toHaveBeenCalled();
    const link = screen.getByTestId('unattested-restore-stepup-enrol') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/profile');
    expect(link.getAttribute('target')).toBe('_blank');
    // Nothing to confirm with until a factor exists.
    expect(screen.queryByTestId('unattested-restore-stepup-confirm')).toBeNull();
    expect(screen.queryByTestId('unattested-restore-stepup-code')).toBeNull();

    enrolled = true;
    fireEvent.click(screen.getByTestId('unattested-restore-stepup-retry'));
    fireEvent.change(await screen.findByTestId('unattested-restore-stepup-code'), { target: { value: '123456' } });
    expect(screen.queryByTestId('unattested-restore-stepup-enrol')).toBeNull();
    fireEvent.click(screen.getByTestId('unattested-restore-stepup-confirm'));

    await screen.findByText('restore started');
    const mint = fetchMock.mock.calls.find(([url]) => url === '/auth/mfa/step-up')!;
    expect(JSON.parse(String((mint[1] as RequestInit).body))).toEqual({
      method: 'totp',
      code: '123456',
      operation: 'backup_unattested_restore',
      resource: RESOURCE,
    });
    expect(restoreBodies()).toEqual([{ snapshotId: 's' }, { snapshotId: 's' }, { snapshotId: 's', stepUpGrant: 'grant-1' }]);
    expect(showToastMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('unattested-restore-stepup')).toBeNull());
  });

  it('Retry before a factor is enrolled keeps the enrolment prompt and says so', async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === '/backup/restore' ? json(enrolBody('producer_only_other_target'), 403) : json({}, 404));
    render(<Harness />);
    fireEvent.click(screen.getByText('Start restore'));
    const prompt = await screen.findByTestId('unattested-restore-stepup');
    expect(prompt.textContent).toMatch(/only the original device can check/i);

    fireEvent.click(screen.getByTestId('unattested-restore-stepup-retry'));
    expect(await screen.findByText(/still has no second factor/i)).toBeTruthy();
    expect(screen.getByTestId('unattested-restore-stepup-enrol')).toBeTruthy();
    expect(restoreBodies()).toEqual([{ snapshotId: 's' }, { snapshotId: 's' }]);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('when two-factor is asked for but the account has no factor, it offers enrolment instead of a dead end', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/restore') return json(stepUpBody('mfa'), 403);
      if (url === '/users/me') return json({ mfaMethod: null });
      if (url === '/auth/passkeys') return json([]);
      return json({}, 404);
    });
    render(<Harness />);
    fireEvent.click(screen.getByText('Start restore'));
    await screen.findByTestId('unattested-restore-stepup');
    expect(screen.getByTestId('unattested-restore-stepup-enrol').getAttribute('href')).toBe('/settings/profile');
    expect(screen.getByTestId('unattested-restore-stepup-retry')).toBeTruthy();
    expect(screen.queryByTestId('unattested-restore-stepup-confirm')).toBeNull();
  });

  it('the enrolment answer is not shown as an error toast', () => {
    expect(suppressUnattestedRestoreStepUpToast(403, 'MFA_ENROLLMENT_REQUIRED')).toBe(true);
    expect(suppressUnattestedRestoreStepUpToast(403, 'STEP_UP_REQUIRED')).toBe(true);
    expect(suppressUnattestedRestoreStepUpToast(403, 'ACCESS_DENIED')).toBe(false);
    expect(suppressUnattestedRestoreStepUpToast(409, 'MFA_ENROLLMENT_REQUIRED')).toBe(false);
  });
});
