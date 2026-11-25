import '@/lib/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchMock, mintMock, toastMock, tierMock, capability } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mintMock: vi.fn(),
  toastMock: vi.fn(),
  tierMock: vi.fn(),
  capability: { canReview: true },
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintMock,
  StepUpMintError: class StepUpMintError extends Error {},
}));
vi.mock('../../lib/reauthTier', () => ({ discoverReauthTier: tierMock }));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));
vi.mock('../../lib/reattachCapability', () => ({ useCanReattachDevice: () => capability.canReview }));

import TpmKeyPanel, { parseTpmBaselineView } from './TpmKeyPanel';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const VERSION = 'v'.repeat(43);
const GRANT = '33333333-3333-4333-8333-333333333333';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const attested = { tpmAvailable: true, attested: true, attestedAt: '2027-02-01T10:00:00.000Z', mismatch: null };
const held = { ...attested, mismatch: { heldAt: '2027-02-03T09:00:00.000Z', version: VERSION } };

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const gets = () => fetchMock.mock.calls.filter(([, init]) => !init?.method);

beforeEach(() => {
  vi.clearAllMocks();
  mintMock.mockResolvedValue(GRANT);
  tierMock.mockResolvedValue('totp');
  capability.canReview = true;
});

async function openStepUp(user: ReturnType<typeof userEvent.setup>) {
  render(<TpmKeyPanel deviceId={DEVICE_ID} />);
  await user.click(await screen.findByTestId('tpm-key-accept'));
}

describe('TpmKeyPanel (#8318 wave T2)', () => {
  it('shows a recorded baseline, says key continuity, and offers no action without a held change', async () => {
    fetchMock.mockResolvedValueOnce(json(200, attested));
    render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByTestId('tpm-key-status').textContent).toMatch(/Key baseline recorded/));
    expect(fetchMock).toHaveBeenCalledWith(`/devices/${DEVICE_ID}/tpm-baseline`);
    expect(screen.getByTestId('tpm-key-panel').textContent).toMatch(/not a genuine TPM/);
    expect(screen.queryByTestId('tpm-key-accept')).toBeNull();
  });

  it('tells no TPM apart from no baseline yet', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tpmAvailable: false, attested: false, attestedAt: null, mismatch: null }));
    const { unmount } = render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByTestId('tpm-key-status').textContent).toMatch(/reports no TPM/));
    unmount();
    fetchMock.mockResolvedValueOnce(json(200, { tpmAvailable: null, attested: false, attestedAt: null, mismatch: null }));
    render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByTestId('tpm-key-status').textContent).toMatch(/No TPM key baseline/));
  });

  it('dismiss posts the reviewed version, needs no step-up, and re-reads the state', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, held))
      .mockResolvedValueOnce(json(200, { action: 'dismiss' }))
      .mockResolvedValueOnce(json(200, attested));
    render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    await user.click(await screen.findByTestId('tpm-key-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('tpm-key-mismatch')).toBeNull());
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toBe(`/devices/${DEVICE_ID}/tpm-baseline/mismatch`);
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ action: 'dismiss', version: VERSION });
    expect(mintMock).not.toHaveBeenCalled();
    expect(gets()).toHaveLength(2);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('accept asks for the step-up only when the server does, bound to exactly the device and the held version', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, held))
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(200, { action: 'accept' }))
      .mockResolvedValueOnce(json(200, attested));
    render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    await user.click(await screen.findByTestId('tpm-key-accept'));
    const codeInput = await screen.findByTestId('tpm-key-stepup-code');
    // The step-up request is not a failure: no error toast for it.
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect((screen.getByTestId('tpm-key-accept') as HTMLButtonElement).disabled).toBe(true);
    await user.type(codeInput, '123456');
    await user.click(screen.getByTestId('tpm-key-accept'));
    await waitFor(() => expect(screen.queryByTestId('tpm-key-mismatch')).toBeNull());
    expect(mintMock).toHaveBeenCalledWith({
      operation: 'device_tpm_baseline_accept',
      resource: { deviceId: DEVICE_ID, baselineVersion: VERSION },
      reauth: { method: 'totp', code: '123456' },
    });
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ action: 'accept', version: VERSION });
    expect(JSON.parse(String(posts()[1]![1]!.body))).toEqual({ action: 'accept', version: VERSION, stepUpGrant: GRANT });
  });

  it('accept with two-factor off goes straight through', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, held))
      .mockResolvedValueOnce(json(200, { action: 'accept' }))
      .mockResolvedValueOnce(json(200, attested));
    render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    await user.click(await screen.findByTestId('tpm-key-accept'));
    await waitFor(() => expect(screen.queryByTestId('tpm-key-mismatch')).toBeNull());
    expect(mintMock).not.toHaveBeenCalled();
    expect(tierMock).not.toHaveBeenCalled();
  });

  it('a hold that changed since it was shown says so and re-reads the state', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, held))
      .mockResolvedValueOnce(json(409, { error: 'changed', code: 'mismatch_changed' }))
      .mockResolvedValueOnce(json(200, attested));
    render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    await user.click(await screen.findByTestId('tpm-key-dismiss'));
    await waitFor(() => expect(screen.getByTestId('tpm-key-error').textContent).toMatch(/changed since it was shown/));
    await waitFor(() => expect(gets()).toHaveLength(2));
  });

  it('an open reattach is refused with its own words', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, held))
      .mockResolvedValueOnce(json(409, { error: 'in progress', code: 'reattach_in_progress' }));
    render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    await user.click(await screen.findByTestId('tpm-key-dismiss'));
    await waitFor(() => expect(screen.getByTestId('tpm-key-error').textContent).toMatch(/open reattach/));
    expect(screen.getByTestId('tpm-key-mismatch')).toBeTruthy();
  });

  it('someone the review route would refuse sees the held change but no action', async () => {
    capability.canReview = false;
    fetchMock.mockResolvedValueOnce(json(200, held));
    render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    const box = await screen.findByTestId('tpm-key-mismatch');
    expect(box.textContent).toMatch(/can edit and delete devices can review it/);
    expect(screen.queryByTestId('tpm-key-accept')).toBeNull();
    expect(screen.queryByTestId('tpm-key-dismiss')).toBeNull();
  });

  it('a passkey account accepts without a code', async () => {
    const user = userEvent.setup();
    tierMock.mockResolvedValue('passkey');
    fetchMock
      .mockResolvedValueOnce(json(200, held))
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(200, { action: 'accept' }))
      .mockResolvedValueOnce(json(200, attested));
    await openStepUp(user);
    await screen.findByTestId('tpm-key-stepup-passkey');
    expect((screen.getByTestId('tpm-key-accept') as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId('tpm-key-accept'));
    await waitFor(() => expect(screen.queryByTestId('tpm-key-mismatch')).toBeNull());
    expect(mintMock).toHaveBeenCalledWith(expect.objectContaining({ reauth: { method: 'passkey' } }));
  });

  it('an account with no step-up factor cannot accept but can still dismiss', async () => {
    const user = userEvent.setup();
    tierMock.mockResolvedValue('password');
    fetchMock
      .mockResolvedValueOnce(json(200, held))
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }));
    await openStepUp(user);
    await screen.findByTestId('tpm-key-no-factor');
    expect((screen.getByTestId('tpm-key-accept') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('tpm-key-dismiss') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a refused grant asks for a fresh code and mints again', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, held))
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(200, { action: 'accept' }))
      .mockResolvedValueOnce(json(200, attested));
    await openStepUp(user);
    await user.type(await screen.findByTestId('tpm-key-stepup-code'), '123456');
    await user.click(screen.getByTestId('tpm-key-accept'));
    await waitFor(() => expect(screen.getByTestId('tpm-key-error').textContent).toMatch(/expired or no longer matches/));
    const input = screen.getByTestId('tpm-key-stepup-code') as HTMLInputElement;
    expect(input.value).toBe('');
    await user.type(input, '654321');
    await user.click(screen.getByTestId('tpm-key-accept'));
    await waitFor(() => expect(screen.queryByTestId('tpm-key-mismatch')).toBeNull());
    expect(mintMock).toHaveBeenCalledTimes(2);
  });

  it('a grant left unspent by a refusal before the step-up is reused for the retry', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(200, held))
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(409, { error: 'in progress', code: 'reattach_in_progress' }))
      .mockResolvedValueOnce(json(200, { action: 'accept' }))
      .mockResolvedValueOnce(json(200, attested));
    await openStepUp(user);
    await user.type(await screen.findByTestId('tpm-key-stepup-code'), '123456');
    await user.click(screen.getByTestId('tpm-key-accept'));
    await waitFor(() => expect(screen.getByTestId('tpm-key-error').textContent).toMatch(/open reattach/));
    expect(screen.queryByTestId('tpm-key-stepup-code')).toBeNull();
    await user.click(screen.getByTestId('tpm-key-accept'));
    await waitFor(() => expect(screen.queryByTestId('tpm-key-mismatch')).toBeNull());
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(posts().at(-1)![1]!.body))).toEqual({ action: 'accept', version: VERSION, stepUpGrant: GRANT });
  });

  describe('a held grant that lapses (#12641 review)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function holdUnspentGrant(user: ReturnType<typeof userEvent.setup>) {
      fetchMock
        .mockResolvedValueOnce(json(200, held))
        .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
        .mockResolvedValueOnce(json(409, { error: 'in progress', code: 'reattach_in_progress' }));
      await openStepUp(user);
      await user.type(await screen.findByTestId('tpm-key-stepup-code'), '123456');
      await user.click(screen.getByTestId('tpm-key-accept'));
      await waitFor(() => expect(screen.getByTestId('tpm-key-error').textContent).toMatch(/open reattach/));
      expect(screen.queryByTestId('tpm-key-stepup-code')).toBeNull();
    }

    it('an idle panel shows the code field again once the grant can no longer be used', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await holdUnspentGrant(user);
      act(() => {
        vi.advanceTimersByTime(271_000);
      });
      expect(screen.getByTestId('tpm-key-stepup-code')).toBeTruthy();
      expect((screen.getByTestId('tpm-key-accept') as HTMLButtonElement).disabled).toBe(true);
    });

    it('a click after the grant lapsed sends nothing and asks for a fresh code, even if the timer ran late', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await holdUnspentGrant(user);
      const postsBefore = posts().length;
      // The clock moves on but the expiry timer has not run (a background tab).
      vi.setSystemTime(Date.now() + 271_000);
      await user.click(screen.getByTestId('tpm-key-accept'));
      await screen.findByTestId('tpm-key-stepup-code');
      expect(posts().length).toBe(postsBefore);
      expect(mintMock).toHaveBeenCalledTimes(1);
    });
  });

  it('a failed read says so', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: 'boom' }));
    render(<TpmKeyPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByTestId('tpm-key-load-error')).toBeTruthy());
  });
});

describe('parseTpmBaselineView', () => {
  it('drops a half-built hold and rejects a body without the attested flag', () => {
    expect(parseTpmBaselineView({ attested: true, attestedAt: 'x', mismatch: { heldAt: 'y' } })).toMatchObject({ mismatch: null, tpmAvailable: null });
    expect(parseTpmBaselineView({ tpmAvailable: true })).toBeNull();
    expect(parseTpmBaselineView(null)).toBeNull();
  });
});
