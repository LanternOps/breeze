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
const ORG = '33333333-3333-4333-8333-333333333333';
const stepUpBody = (method: 'mfa' | 'confirm' | 'typed', reason = 'unattested_legacy') => ({
  error: 'Confirm the restore.',
  code: 'STEP_UP_REQUIRED',
  stepUp: {
    operation: 'backup_unattested_restore',
    method,
    reason,
    resource: RESOURCE,
    ...(method === 'typed' ? { confirmation: { phrase: 'Front Desk PC', orgId: ORG } } : {}),
  },
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

  it('typed confirmation: the user types the device name, the grant is minted for the restore org, and the restore resubmits', async () => {
    let restoreCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/backup/restore') {
        restoreCalls += 1;
        return restoreCalls === 1 ? json(stepUpBody('typed'), 403) : json({ id: 'restore-1' }, 201);
      }
      if (url === '/backup/restore-confirmations' && init?.method === 'POST') return json({ stepUpGrant: 'typed-grant-1' });
      return json({}, 404);
    });

    render(<Harness />);
    fireEvent.click(screen.getByText('Start restore'));
    const prompt = await screen.findByTestId('unattested-restore-stepup');
    expect(prompt.textContent).toContain('Front Desk PC');
    // No factor discovery: a typed confirmation needs none.
    expect(fetchMock.mock.calls.some(([url]) => url === '/users/me')).toBe(false);

    const confirm = screen.getByTestId('unattested-restore-stepup-confirm') as HTMLButtonElement;
    const input = screen.getByTestId('unattested-restore-stepup-phrase');
    fireEvent.change(input, { target: { value: 'Front Desk' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: ' front desk pc ' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await screen.findByText('restore started');
    const mint = fetchMock.mock.calls.find(([url]) => url === '/backup/restore-confirmations')!;
    expect(mint[1]).toMatchObject({ method: 'POST', orgIdOverride: ORG });
    expect(JSON.parse(String((mint[1] as RequestInit).body))).toEqual({ ...RESOURCE, confirmationText: ' front desk pc ' });
    expect(restoreBodies()).toEqual([{ snapshotId: 's' }, { snapshotId: 's', stepUpGrant: 'typed-grant-1' }]);
    expect(fetchMock.mock.calls.some(([url]) => url === '/auth/mfa/step-up')).toBe(false);
  });

  it('typed confirmation: a refused phrase shows the server message and does not resubmit', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/restore') return json(stepUpBody('typed'), 403);
      if (url === '/backup/restore-confirmations') {
        return json({ error: 'The name you typed does not match the device being restored.', code: 'confirmation_mismatch' }, 400);
      }
      return json({}, 404);
    });
    render(<Harness />);
    fireEvent.click(screen.getByText('Start restore'));
    await screen.findByTestId('unattested-restore-stepup');
    fireEvent.change(screen.getByTestId('unattested-restore-stepup-phrase'), { target: { value: 'Front Desk PC' } });
    fireEvent.click(screen.getByTestId('unattested-restore-stepup-confirm'));
    expect(await screen.findByText('The name you typed does not match the device being restored.')).toBeTruthy();
    expect(restoreBodies()).toHaveLength(1);
  });
});
