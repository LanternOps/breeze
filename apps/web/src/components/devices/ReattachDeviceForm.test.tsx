import '@/lib/i18n';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchMock, mintMock, toastMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mintMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintMock,
  StepUpMintError: class StepUpMintError extends Error {},
}));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import ReattachDeviceForm from './ReattachDeviceForm';
import type { ReattachCandidate, ReinstallCandidatesView } from '../../lib/deviceReattach';
import {
  SOURCE_ID,
  TARGET_ID,
  TARGET_VERSION,
  json,
  reattachCandidate,
  reattachSource,
  requestedIntent,
} from './__tests__/reattachFixtures';

function renderForm(opts: {
  source?: ReinstallCandidatesView['source'];
  candidate?: ReattachCandidate;
} = {}) {
  const onRequested = vi.fn();
  const onTargetChanged = vi.fn();
  const onConflict = vi.fn();
  const onBusyChange = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ReattachDeviceForm
      source={opts.source ?? reattachSource()}
      candidate={opts.candidate ?? reattachCandidate()}
      passkeyCount={0}
      mfaMethod="totp"
      onClose={onClose}
      onRequested={onRequested}
      onTargetChanged={onTargetChanged}
      onConflict={onConflict}
      onBusyChange={onBusyChange}
    />,
  );
  return { onRequested, onTargetChanged, onConflict, onBusyChange, onClose, rerender: view.rerender };
}

const submitButton = () => screen.getByTestId('reattach-submit') as HTMLButtonElement;

async function fillGates(user: ReturnType<typeof userEvent.setup>, name = 'LAPTOP-OLD') {
  await user.click(screen.getByTestId('reattach-possession'));
  await user.type(screen.getByTestId('reattach-confirm-name'), name);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mintMock.mockResolvedValue('33333333-3333-4333-8333-333333333333');
});

describe('ReattachDeviceForm', () => {
  it('shows both rows side by side with the evidence stated honestly', () => {
    renderForm();
    expect(screen.getByTestId('reattach-compare-hostname-source').textContent).toBe('LAPTOP-NEW');
    expect(screen.getByTestId('reattach-compare-hostname-target').textContent).toBe('LAPTOP-OLD');
    expect(screen.getByTestId('reattach-compare-place-target').textContent).toBe('Acme / HQ');
    expect(screen.getByTestId('reattach-evidence-notice').textContent)
      .toBe('Hardware identifiers reported by the device. Not verified.');
    expect(screen.getByTestId('reattach-evidence').textContent).toMatch(/system UUID/);
    // The TPM sentence only for TPM evidence.
    expect(screen.queryByText(/endorsement key/i)).toBeNull();
    expect(screen.queryByTestId('reattach-evidence-gap')).toBeNull();
    const consequences = screen.getByTestId('reattach-consequences').textContent ?? '';
    expect(consequences).toMatch(/rebuilds the inventory of LAPTOP-OLD/);
    expect(consequences).toMatch(/queued work, grants and sessions of the old install are cancelled/i);
  });

  it('keeps submit disabled until possession is confirmed and the exact name is typed', async () => {
    const user = userEvent.setup();
    renderForm();
    expect(submitButton().disabled).toBe(true);
    await user.click(screen.getByTestId('reattach-possession'));
    expect(submitButton().disabled).toBe(true);
    await user.type(screen.getByTestId('reattach-confirm-name'), 'LAPTOP-OL');
    expect(submitButton().disabled).toBe(true);
    await user.type(screen.getByTestId('reattach-confirm-name'), 'D');
    expect(submitButton().disabled).toBe(false);
  });

  it('accepts the typed name trimmed and in any case, as the server compares it', async () => {
    const user = userEvent.setup();
    renderForm();
    await fillGates(user, '  laptop-old ');
    expect(submitButton().disabled).toBe(false);
  });

  it('requires the OS change to be acknowledged when the two installs differ', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(202, { intent: requestedIntent }));
    renderForm({ candidate: reattachCandidate({ osType: 'linux', osChanged: true }) });
    await fillGates(user);
    expect(submitButton().disabled).toBe(true);
    await user.click(screen.getByTestId('reattach-ack-os'));
    expect(submitButton().disabled).toBe(false);
    await user.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ acknowledgeOsChange: true });
  });

  it('requires the restore to be explicit for a removed record and binds it in the step-up', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(202, { intent: { ...requestedIntent, restoreDecommissioned: true } }));
    renderForm({ candidate: reattachCandidate({ status: 'decommissioned', requiresRestore: true }) });
    await fillGates(user);
    expect(submitButton().disabled).toBe(true);
    await user.click(screen.getByTestId('reattach-restore'));
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    await user.type(screen.getByTestId('reattach-stepup-code'), '123456');
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-pending')).toBeTruthy());
    expect(mintMock).toHaveBeenCalledWith(expect.objectContaining({
      resource: expect.objectContaining({ restoreDecommissioned: true }),
    }));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ restoreDecommissioned: true });
  });

  it('two-factor off: the first submit is accepted with no grant and the request shows as pending', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(202, { intent: requestedIntent }));
    const { onRequested } = renderForm();
    await fillGates(user);
    await user.click(submitButton());

    await waitFor(() => expect(screen.getByTestId('reattach-pending')).toBeTruthy());
    expect(fetchMock.mock.calls[0]![0]).toBe(`/devices/${SOURCE_ID}/reattach`);
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      targetDeviceId: TARGET_ID,
      targetVersion: TARGET_VERSION,
      possessionConfirmed: true,
      confirmTargetName: 'LAPTOP-OLD',
      restoreDecommissioned: false,
      acknowledgeOsChange: false,
      expectedEvidenceLevel: 'hint',
    });
    expect(mintMock).not.toHaveBeenCalled();
    expect(onRequested).toHaveBeenCalledWith(requestedIntent);
    expect(screen.getByTestId('reattach-pending-message').textContent).toMatch(/next time its agent checks in/);
  });

  it('asks for step-up only when the server does, then mints a device_reattach grant bound to what is shown', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(202, { intent: requestedIntent }));
    const { onRequested } = renderForm();
    await fillGates(user);
    await user.click(submitButton());

    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    // The step-up request is not a failure: no error toast.
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(submitButton().disabled).toBe(true);
    await user.type(screen.getByTestId('reattach-stepup-code'), '123456');
    await user.click(submitButton());

    await waitFor(() => expect(onRequested).toHaveBeenCalled());
    expect(mintMock).toHaveBeenCalledWith({
      operation: 'device_reattach',
      resource: {
        sourceDeviceId: SOURCE_ID,
        targetDeviceId: TARGET_ID,
        targetVersion: TARGET_VERSION,
        evidenceLevel: 'hint',
        restoreDecommissioned: false,
      },
      reauth: { method: 'totp', code: '123456' },
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({
      stepUpGrant: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('a grant the server refuses asks for a fresh code', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }));
    renderForm();
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    await user.type(screen.getByTestId('reattach-stepup-code'), '123456');
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-error').textContent).toMatch(/new code/i));
    expect((screen.getByTestId('reattach-stepup-code') as HTMLInputElement).value).toBe('');
  });

  it.each([
    ['target_alive', 409, /LAPTOP-OLD is still in use/],
    ['liveness_unknown', 409, /could not be checked/],
    ['device_in_open_intent', 409, /already in a pending reattach/],
    ['full_admin_required', 403, /full partner administrator/],
    ['device_not_found', 404, /no longer exists or is outside your access/],
    ['MFA_REQUIRED', 403, /two-factor authentication/],
    ['confirm_target_name_mismatch', 400, /does not match LAPTOP-OLD/],
  ])('explains the %s refusal', async (code, status, message) => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(status, { error: 'server words', code }));
    const { onRequested } = renderForm();
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-error').textContent).toMatch(message));
    expect(onRequested).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reattach-stepup-code')).toBeNull();
  });

  it('shows the server message for a refusal it has no words for', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(409, { error: 'Something new went wrong', code: 'brand_new_code' }));
    renderForm();
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-error').textContent).toBe('Something new went wrong'));
  });

  it('a target that changed since it was shown asks the parent to re-read', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(409, { error: 'changed', code: 'target_changed' }));
    const { onTargetChanged, onConflict } = renderForm();
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(onTargetChanged).toHaveBeenCalled());
    expect(onConflict).toHaveBeenCalledWith('target_changed');
    expect(screen.getByTestId('reattach-error').textContent).toMatch(/changed since it was shown/);
  });

  it('any 409 refusal asks the parent to re-read; a 400 does not', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(409, { error: 'removed', code: 'target_decommissioned' }))
      .mockResolvedValueOnce(json(400, { error: 'mismatch', code: 'confirm_target_name_mismatch' }));
    const { onConflict } = renderForm();
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(onConflict).toHaveBeenCalledWith('target_decommissioned'));
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-error').textContent).toMatch(/does not match/));
    expect(onConflict).toHaveBeenCalledTimes(1);
  });

  it('holds the minted grant: a retry after a 409 refusal reuses it without a new code', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(409, { error: 'unknown', code: 'liveness_unknown' }))
      .mockResolvedValueOnce(json(202, { intent: requestedIntent }));
    const { onRequested } = renderForm();
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    await user.type(screen.getByTestId('reattach-stepup-code'), '123456');
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-error').textContent).toMatch(/could not be checked/));

    // The code was spent on the mint; the held grant is offered instead.
    expect(screen.getByTestId('reattach-stepup-held')).toBeTruthy();
    expect(submitButton().disabled).toBe(false);
    await user.click(submitButton());
    await waitFor(() => expect(onRequested).toHaveBeenCalled());
    expect(mintMock).toHaveBeenCalledTimes(1);
    const grant = '33333333-3333-4333-8333-333333333333';
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).stepUpGrant).toBe(grant);
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body).stepUpGrant).toBe(grant);
  });

  /** Up to the 409 that leaves a minted grant held, with the "verified" note shown. */
  async function holdAGrant(user: ReturnType<typeof userEvent.setup>) {
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    await user.type(screen.getByTestId('reattach-stepup-code'), '123456');
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-held')).toBeTruthy());
  }

  // #8318 2-3 review: the grant's age was only checked at render, so a dialog
  // left idle past it kept saying "verified" and sent a lapsed grant.
  it('an idle dialog drops the held grant when it lapses and asks for a code again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(409, { error: 'unknown', code: 'liveness_unknown' }));
    renderForm();
    await holdAGrant(user);
    act(() => { vi.advanceTimersByTime(270_000); });
    expect(screen.queryByTestId('reattach-stepup-held')).toBeNull();
    expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it('a grant that lapsed before its timer ran is not sent: the submit asks for a code', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(409, { error: 'unknown', code: 'liveness_unknown' }));
    renderForm();
    await holdAGrant(user);
    // A throttled background tab: the clock moved on, the timer has not fired.
    const later = Date.now() + 280_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mintMock).toHaveBeenCalledTimes(1);
  });

  it('drops the held grant when the server refuses it and mints a new one', async () => {
    const user = userEvent.setup();
    mintMock.mockResolvedValueOnce('44444444-4444-4444-8444-444444444444');
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(409, { error: 'unknown', code: 'liveness_unknown' }))
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(202, { intent: requestedIntent }));
    const { onRequested } = renderForm();
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    await user.type(screen.getByTestId('reattach-stepup-code'), '123456');
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-held')).toBeTruthy());
    await user.click(submitButton());
    // Refused: back to asking for a code.
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    expect(submitButton().disabled).toBe(true);
    await user.type(screen.getByTestId('reattach-stepup-code'), '654321');
    await user.click(submitButton());
    await waitFor(() => expect(onRequested).toHaveBeenCalled());
    expect(mintMock).toHaveBeenCalledTimes(2);
    expect(mintMock).toHaveBeenLastCalledWith(expect.objectContaining({ reauth: { method: 'totp', code: '654321' } }));
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body).stepUpGrant).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('a change to a bound field (the restore) drops the held grant', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(409, { error: 'unknown', code: 'liveness_unknown' }));
    renderForm({ candidate: reattachCandidate({ status: 'decommissioned', requiresRestore: true }) });
    await fillGates(user);
    await user.click(screen.getByTestId('reattach-restore'));
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    await user.type(screen.getByTestId('reattach-stepup-code'), '123456');
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-held')).toBeTruthy());
    await user.click(screen.getByTestId('reattach-restore'));
    await user.click(screen.getByTestId('reattach-restore'));
    // Same value again, same key: still held. Untick: the grant no longer matches.
    expect(screen.getByTestId('reattach-stepup-held')).toBeTruthy();
    await user.click(screen.getByTestId('reattach-restore'));
    expect(screen.queryByTestId('reattach-stepup-held')).toBeNull();
  });

  it('a TPM key candidate needs no typed name and binds tpm_continuity in the step-up and the body (#8318 wave T2)', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(202, { intent: requestedIntent }));
    renderForm({ candidate: reattachCandidate({ evidence: 'tpm_ek', evidenceLevel: 'tpm_continuity' }) });
    expect(screen.getByTestId('reattach-evidence').textContent).toMatch(/TPM endorsement key/);
    expect(screen.getByTestId('reattach-evidence-notice').textContent).toMatch(/endorsement key/);
    // Key continuity, never a genuine TPM.
    expect(screen.getByTestId('reattach-evidence-notice').textContent).not.toMatch(/genuine/i);
    expect(screen.queryByTestId('reattach-confirm-name')).toBeNull();
    await user.click(screen.getByTestId('reattach-possession'));
    expect(submitButton().disabled).toBe(false);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    await user.type(screen.getByTestId('reattach-stepup-code'), '123456');
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-pending')).toBeTruthy());
    expect(mintMock).toHaveBeenCalledWith(expect.objectContaining({
      resource: expect.objectContaining({ evidenceLevel: 'tpm_continuity' }),
    }));
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body));
    expect(body).toMatchObject({ expectedEvidenceLevel: 'tpm_continuity' });
  });

  it('a hint candidate whose TPM key did not count says why and still asks for the name', () => {
    renderForm({ candidate: reattachCandidate({ evidenceLevel: 'hint', evidenceGap: 'key_shared' }) });
    expect(screen.getByTestId('reattach-evidence-gap').textContent).toMatch(/another device of your partner/);
    expect(screen.getByTestId('reattach-confirm-name')).toBeTruthy();
  });

  it('a candidate read from the TPM key that the server still rates hint keeps the name gate (#12641 review)', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(202, { intent: requestedIntent }));
    renderForm({ candidate: reattachCandidate({ evidence: 'tpm_ek', evidenceLevel: 'hint', evidenceGap: 'key_shared' }) });
    await user.click(screen.getByTestId('reattach-possession'));
    expect(submitButton().disabled).toBe(true);
    await user.type(screen.getByTestId('reattach-confirm-name'), 'LAPTOP-OLD');
    expect(submitButton().disabled).toBe(false);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-pending')).toBeTruthy());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({
      confirmTargetName: 'LAPTOP-OLD',
      expectedEvidenceLevel: 'hint',
    });
  });

  it('an evidence level it does not know falls back to hint: the name is asked for and hint is sent (#12641 review)', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(202, { intent: requestedIntent }));
    renderForm({
      candidate: reattachCandidate({
        evidence: 'tpm_ek',
        evidenceLevel: 'hardware_attested' as unknown as ReattachCandidate['evidenceLevel'],
      }),
    });
    await user.click(screen.getByTestId('reattach-possession'));
    expect(submitButton().disabled).toBe(true);
    await user.type(screen.getByTestId('reattach-confirm-name'), 'LAPTOP-OLD');
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-pending')).toBeTruthy());
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({ expectedEvidenceLevel: 'hint' });
  });

  it('no gap line when a device simply has no TPM key', () => {
    renderForm({ candidate: reattachCandidate({ evidenceLevel: 'hint', evidenceGap: 'target_no_key' }) });
    expect(screen.queryByTestId('reattach-evidence-gap')).toBeNull();
  });

  it('evidence_changed shows its own words and has the parent re-read the candidates', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(409, { error: 'Evidence changed', code: 'evidence_changed' }));
    const { onConflict } = renderForm({ candidate: reattachCandidate({ evidence: 'tpm_ek', evidenceLevel: 'tpm_continuity' }) });
    await user.click(screen.getByTestId('reattach-possession'));
    await user.click(submitButton());
    await waitFor(() => expect(onConflict).toHaveBeenCalledWith('evidence_changed'));
    expect(screen.getByText(/TPM key evidence for LAPTOP-OLD changed/)).toBeTruthy();
  });

  it('reports itself busy while submitting and in the step-up', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }));
    const { onBusyChange } = renderForm();
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('reattach-stepup-code')).toBeTruthy());
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
  });

  it('an answer for a previous candidate never lands on the current one', async () => {
    const user = userEvent.setup();
    let resolvePost: (r: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    const { onRequested, rerender } = renderForm();
    await fillGates(user);
    await user.click(submitButton());
    rerender(
      <ReattachDeviceForm
        source={reattachSource()}
        candidate={reattachCandidate({ deviceId: '55555555-5555-4555-8555-555555555555', hostname: 'OTHER' })}
        passkeyCount={0}
        mfaMethod="totp"
        onClose={vi.fn()}
        onRequested={onRequested}
      />,
    );
    resolvePost(json(202, { intent: requestedIntent }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(onRequested).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reattach-pending')).toBeNull();
    expect(screen.getByTestId('reattach-compare-hostname-target').textContent).toBe('OTHER');
  });

  it('an agent without the rebind protocol cannot be reattached', async () => {
    const user = userEvent.setup();
    renderForm({ source: reattachSource({ rebindSupported: false }) });
    expect(screen.getByTestId('reattach-rebind-unsupported').textContent).toMatch(/too old/);
    await fillGates(user);
    expect(submitButton().disabled).toBe(true);
  });
});
