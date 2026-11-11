import '@/lib/i18n';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  const onClose = vi.fn();
  render(
    <ReattachDeviceForm
      source={opts.source ?? reattachSource()}
      candidate={opts.candidate ?? reattachCandidate()}
      passkeyCount={0}
      mfaMethod="totp"
      onClose={onClose}
      onRequested={onRequested}
      onTargetChanged={onTargetChanged}
    />,
  );
  return { onRequested, onTargetChanged, onClose };
}

const submitButton = () => screen.getByTestId('reattach-submit') as HTMLButtonElement;

async function fillGates(user: ReturnType<typeof userEvent.setup>, name = 'LAPTOP-OLD') {
  await user.click(screen.getByTestId('reattach-possession'));
  await user.type(screen.getByTestId('reattach-confirm-name'), name);
}

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
    // The TPM sentence only for TPM evidence, which no request has until wave T2.
    expect(screen.queryByText(/endorsement key/i)).toBeNull();
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
    const { onTargetChanged } = renderForm();
    await fillGates(user);
    await user.click(submitButton());
    await waitFor(() => expect(onTargetChanged).toHaveBeenCalled());
    expect(screen.getByTestId('reattach-error').textContent).toMatch(/changed since it was shown/);
  });

  it('an agent without the rebind protocol cannot be reattached', async () => {
    const user = userEvent.setup();
    renderForm({ source: reattachSource({ rebindSupported: false }) });
    expect(screen.getByTestId('reattach-rebind-unsupported').textContent).toMatch(/too old/);
    await fillGates(user);
    expect(submitButton().disabled).toBe(true);
  });
});
