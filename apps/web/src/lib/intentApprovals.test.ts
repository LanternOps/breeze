import { describe, it, expect, vi, beforeEach } from 'vitest';

const getApprovalAssertion = vi.fn();
const getBatchApprovalAssertion = vi.fn();
const runAction = vi.fn();
const fetchWithAuth = vi.fn();
const showToast = vi.fn();
// Spreads the ACTUAL module so `AssertionChallengeError` is the real class:
// `decideIntentApprovalBatch` narrows a refused challenge with `instanceof`,
// and a bare object mock leaves that export undefined, so the branch could
// never be reached and its tests would pass for the wrong reason.
vi.mock('../stores/authenticator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stores/authenticator')>()),
  getApprovalAssertion: (...args: unknown[]) => getApprovalAssertion(...args),
  getBatchApprovalAssertion: (...args: unknown[]) => getBatchApprovalAssertion(...args),
}));
vi.mock('./runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runAction')>();
  return { ...actual, runAction: (...args: unknown[]) => runAction(...args) };
});
vi.mock('../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock('../components/shared/Toast', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));

import {
  CeremonyError,
  decideIntentApproval,
  decideIntentApprovalBatch,
} from './intentApprovals';
import { AssertionChallengeError } from '../stores/authenticator';
import { ActionError } from './runAction';

// The un-mocked implementation, used by the server-rejection tests below so the
// 401/403 handling is exercised for real rather than asserted against a stub.
const actualRunAction = (await vi.importActual<typeof import('./runAction')>('./runAction')).runAction;

const PROOF = { type: 'webauthn_platform', credentialId: 'c1' };

/** The shape @simplewebauthn/browser@13 actually throws for a dismissed Touch ID
 *  sheet: `WebAuthnError extends Error` with name 'NotAllowedError' — NOT a
 *  DOMException. Tests that reject with a DOMException pass for the wrong
 *  reason (the library never delivers one). */
function makeWebAuthnError(): Error {
  return Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
}

/** Invoke the `request` thunk runAction was handed, so the actual HTTP call is
 *  asserted rather than merely "runAction was called". */
async function invokeCapturedRequest(): Promise<void> {
  const opts = runAction.mock.calls[0][0] as { request: () => Promise<unknown> };
  await opts.request();
}

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockResolvedValue(undefined);
  getBatchApprovalAssertion.mockResolvedValue(PROOF);
  fetchWithAuth.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('decideIntentApproval', () => {
  it('approve: POSTs the proof to /mobile/approvals/:id/approve', async () => {
    getApprovalAssertion.mockResolvedValue(PROOF);
    const outcome = await decideIntentApproval('ap-1', 'approve');
    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).toHaveBeenCalledWith('/mobile/approvals', 'ap-1');

    await invokeCapturedRequest();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit & { skipUnauthorizedRetry?: boolean }];
    expect(url).toBe('/mobile/approvals/ap-1/approve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ proof: PROOF });
    // The assertion is single-use: fetchWithAuth must not refresh-and-replay it.
    expect(init.skipUnauthorizedRetry).toBe(true);
  });

  it('approve: opts the 401 out of runAction’s silent session-expiry branch', async () => {
    getApprovalAssertion.mockResolvedValue(PROOF);
    await decideIntentApproval('ap-1', 'approve');
    const opts = runAction.mock.calls[0][0] as { treatUnauthorizedAsError?: boolean };
    expect(opts.treatUnauthorizedAsError).toBe(true);
  });

  it('approve: returns needs_device (no POST) when no approver device is registered', async () => {
    const err = new Error('No registered approver device');
    err.name = 'NoApproverDeviceError';
    getApprovalAssertion.mockRejectedValue(err);
    const outcome = await decideIntentApproval('ap-1', 'approve');
    expect(outcome).toBe('needs_device');
    expect(runAction).not.toHaveBeenCalled();
  });

  it('approve: a cancelled ceremony throws CeremonyError without POSTing', async () => {
    getApprovalAssertion.mockRejectedValue(makeWebAuthnError());
    const rejection = await decideIntentApproval('ap-1', 'approve').catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(CeremonyError);
    expect((rejection as CeremonyError).cause).toMatchObject({ name: 'NotAllowedError' });
    expect(runAction).not.toHaveBeenCalled();
  });

  it('deny: POSTs to /deny with no proof and no ceremony', async () => {
    const outcome = await decideIntentApproval('ap-1', 'deny');
    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).not.toHaveBeenCalled();

    await invokeCapturedRequest();
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/mobile/approvals/ap-1/deny');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({});
    expect(body).not.toHaveProperty('proof');
  });

  it('deny: includes the optional trimmed reason', async () => {
    await decideIntentApproval('ap-1', 'deny', '  Unexpected customer impact  ');

    await invokeCapturedRequest();
    const [, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      reason: 'Unexpected customer impact',
    });
  });
});

describe('decideIntentApproval server rejections', () => {
  beforeEach(() => {
    runAction.mockImplementation((opts: Parameters<typeof actualRunAction>[0]) => actualRunAction(opts));
    getApprovalAssertion.mockResolvedValue(PROOF);
  });

  it('surfaces a 401 assertion_failed to the user instead of swallowing it', async () => {
    fetchWithAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: 'assertion_failed' }), { status: 401 }),
    );
    const rejection = await decideIntentApproval('ap-1', 'approve').catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(ActionError);
    expect((rejection as ActionError).status).toBe(401);
    expect((rejection as ActionError).message).toBe('assertion_failed');
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'assertion_failed' }),
    );
  });

  it('maps a 403 step_up_required to needs_device with translated copy, not the raw token', async () => {
    fetchWithAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: 'step_up_required', requiredLevel: 3 }), { status: 403 }),
    );
    const outcome = await decideIntentApproval('ap-1', 'approve');
    expect(outcome).toBe('needs_device');
    const toasted = showToast.mock.calls[0][0] as { message: string };
    expect(toasted.message).not.toBe('step_up_required');
    expect(toasted.message).toMatch(/Touch ID/i);
  });

  it('maps a 403 not_sole_approver to its own outcome and copy, not decideFailed', async () => {
    // #2685: the decide handler re-derives sole-operator status at decide time.
    // The POST succeeded — the answer was "somebody else has to approve now" —
    // so the generic "Failed to submit the decision" fallback would be a lie.
    fetchWithAuth.mockResolvedValue(
      new Response(JSON.stringify({ error: 'not_sole_approver' }), { status: 403 }),
    );
    const outcome = await decideIntentApproval('ap-1', 'approve');
    expect(outcome).toBe('not_sole_approver');
    const toasted = showToast.mock.calls[0][0] as { message: string };
    expect(toasted.message).not.toBe('not_sole_approver');
    expect(toasted.message).not.toMatch(/failed to submit the decision/i);
    expect(toasted.message).toMatch(/another approver is now required/i);
  });
});

/**
 * The batch client runs the REAL runAction throughout: every case here turns on
 * how a specific status/token is classified, and a stubbed runAction would
 * assert the stub rather than the classification.
 */
describe('decideIntentApprovalBatch', () => {
  const IDS = ['ap-1', 'ap-2'];

  beforeEach(() => {
    runAction.mockImplementation((opts: Parameters<typeof actualRunAction>[0]) =>
      actualRunAction(opts),
    );
  });

  const batchPosts = () =>
    fetchWithAuth.mock.calls.filter(([url]) => String(url).includes('/batch/decide'));

  const respond = (payload: unknown, status = 200) =>
    fetchWithAuth.mockResolvedValue(new Response(JSON.stringify(payload), { status }));

  const toastMessages = () =>
    showToast.mock.calls.map(([toast]) => toast as { type: string; message: string });

  it('approve: one ceremony, one POST to /batch/decide, per-row outcomes back', async () => {
    const results = [
      { id: 'ap-1', httpStatus: 200, body: { status: 'approved' } },
      { id: 'ap-2', httpStatus: 409, body: { error: 'already_decided' } },
    ];
    respond({ results });

    const outcome = await decideIntentApprovalBatch(IDS, 'approve');

    expect(outcome).toEqual({ outcome: 'decided', results });
    // ONE ceremony for the whole set — the entire point of batching.
    expect(getBatchApprovalAssertion).toHaveBeenCalledTimes(1);
    expect(getBatchApprovalAssertion).toHaveBeenCalledWith('/mobile/approvals', IDS, 'approved');
    expect(getApprovalAssertion).not.toHaveBeenCalled();

    expect(batchPosts()).toHaveLength(1);
    const [url, init] = batchPosts()[0] as [string, RequestInit & { skipUnauthorizedRetry?: boolean }];
    expect(url).toBe('/mobile/approvals/batch/decide');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      approvalRequestIds: IDS,
      decision: 'approved',
      proof: PROOF,
    });
    // The batch assertion is single-use, exactly like the single-card one.
    expect(init.skipUnauthorizedRetry).toBe(true);
  });

  it('approve: a PARTIAL result never toasts success', async () => {
    respond({
      results: [
        { id: 'ap-1', httpStatus: 200, body: {} },
        { id: 'ap-2', httpStatus: 410, body: { error: 'expired' } },
      ],
    });

    await decideIntentApprovalBatch(IDS, 'approve');

    expect(toastMessages().filter((toast) => toast.type === 'success')).toEqual([]);
  });

  it('approve: a FULLY successful batch does toast', async () => {
    respond({
      results: [
        { id: 'ap-1', httpStatus: 200, body: {} },
        { id: 'ap-2', httpStatus: 200, body: {} },
      ],
    });

    await decideIntentApprovalBatch(IDS, 'approve');

    expect(toastMessages().filter((toast) => toast.type === 'success')).toHaveLength(1);
  });

  // Paper cut from the pre-release sweep: this toast used to read the
  // singular "Action denied"/"Action approved" no matter how many cards the
  // batch decided.
  it('deny: a fully successful batch of 3 toasts a message naming the count', async () => {
    respond({
      results: [
        { id: 'ap-1', httpStatus: 200, body: {} },
        { id: 'ap-2', httpStatus: 200, body: {} },
        { id: 'ap-3', httpStatus: 200, body: {} },
      ],
    });

    await decideIntentApprovalBatch(['ap-1', 'ap-2', 'ap-3'], 'deny', 'Wrong window');

    const toasts = toastMessages().filter((toast) => toast.type === 'success');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('3');
  });

  it('deny: no ceremony, and the group’s single trimmed reason rides along', async () => {
    respond({ results: [{ id: 'ap-1', httpStatus: 200, body: {} }] });

    await decideIntentApprovalBatch(IDS, 'deny', '  Wrong maintenance window  ');

    expect(getBatchApprovalAssertion).not.toHaveBeenCalled();
    expect(JSON.parse(batchPosts()[0][1].body as string)).toEqual({
      approvalRequestIds: IDS,
      decision: 'denied',
      reason: 'Wrong maintenance window',
    });
  });

  it('returns needs_device with NO POST when no approver device is registered', async () => {
    const err = new Error('No registered approver device');
    err.name = 'NoApproverDeviceError';
    getBatchApprovalAssertion.mockRejectedValue(err);

    const outcome = await decideIntentApprovalBatch(IDS, 'approve');

    expect(outcome).toEqual({ outcome: 'needs_device' });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  describe('refused at the CHALLENGE, before anything is minted', () => {
    it('maps a 422 batch_not_homogeneous to its own outcome, not a ceremony failure', async () => {
      // The batch challenge route re-validates the set before minting, so a
      // set that drifted is refused HERE. Reporting it as CeremonyError would
      // tell the approver their fingerprint scan failed when the cards moved.
      getBatchApprovalAssertion.mockRejectedValue(
        new AssertionChallengeError('batch_not_homogeneous', 422, 'batch_not_homogeneous'),
      );

      const outcome = await decideIntentApprovalBatch(IDS, 'approve');

      // No `offending` on the error itself (defensive fallback) -> empty.
      expect(outcome).toEqual({ outcome: 'batch_not_homogeneous', offending: [] });
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('issue #4459 — carries the challenge route\'s offending ids through, not just the token', async () => {
      // The challenge route is where an APPROVE's drift is usually caught
      // (before proof, before the decide POST), so this is the common path
      // for the inbox to learn which cards to deselect — not the decide-time
      // 422 tested below.
      getBatchApprovalAssertion.mockRejectedValue(
        new AssertionChallengeError('batch_not_homogeneous', 422, 'batch_not_homogeneous', ['ap-2']),
      );

      const outcome = await decideIntentApprovalBatch(IDS, 'approve');

      expect(outcome).toEqual({ outcome: 'batch_not_homogeneous', offending: ['ap-2'] });
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('maps a 403 step_up_required to batch_step_up', async () => {
      getBatchApprovalAssertion.mockRejectedValue(
        new AssertionChallengeError('step_up_required', 403, 'step_up_required'),
      );

      const outcome = await decideIntentApprovalBatch(IDS, 'approve');

      expect(outcome).toEqual({ outcome: 'batch_step_up' });
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('maps a 400 batch_too_large to its own outcome, not a ceremony failure', async () => {
      // #4460: ApprovalsInbox's client-side APPROVAL_BATCH_MAX guard refuses
      // an oversized group before this ever runs, so this only fires on a
      // stale bundle or a group that grew between render and submit — but it
      // must still be reported honestly rather than as a fingerprint failure.
      getBatchApprovalAssertion.mockRejectedValue(
        new AssertionChallengeError('batch_too_large', 400, 'batch_too_large'),
      );

      const outcome = await decideIntentApprovalBatch(IDS, 'approve');

      expect(outcome).toEqual({ outcome: 'batch_too_large' });
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });

    it('still throws CeremonyError for any OTHER challenge failure', async () => {
      // The two branches above must be narrow: a 500 is a real outage and has
      // to stay a ceremony failure, not be laundered into a tidy outcome.
      getBatchApprovalAssertion.mockRejectedValue(
        new AssertionChallengeError('Could not start verification (500).', 500),
      );

      const rejection = await decideIntentApprovalBatch(IDS, 'approve').catch((e: unknown) => e);

      expect(rejection).toBeInstanceOf(CeremonyError);
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });
  });

  describe('refused at the DECIDE', () => {
    it('maps a 401 reauth_required to batch_step_up with "one at a time" copy', async () => {
      // decideApprovalBatch deliberately does not plumb reauthVerified, so a
      // set demanding re-auth can NEVER clear the ladder in a batch. Treating
      // it as a proof rejection ("Verification was canceled or failed. Try
      // again.") blamed the user for a permanent dead end.
      respond({ error: 'reauth_required' }, 401);

      const outcome = await decideIntentApprovalBatch(IDS, 'approve');

      expect(outcome).toEqual({ outcome: 'batch_step_up' });
      const toasted = toastMessages()[0];
      expect(toasted.message).not.toBe('reauth_required');
      expect(toasted.message).toMatch(/one at a time/i);
    });

    it('maps a 403 step_up_required to batch_step_up, not the single-card copy', async () => {
      respond({ error: 'step_up_required', requiredLevel: 4 }, 403);

      const outcome = await decideIntentApprovalBatch(IDS, 'approve');

      expect(outcome).toEqual({ outcome: 'batch_step_up' });
      const toasted = toastMessages()[0];
      // The single-card remedy ("register a device") is the WRONG advice here.
      expect(toasted.message).toMatch(/one at a time/i);
      expect(toasted.message).not.toMatch(/Touch ID/i);
    });

    it('maps a 422 batch_not_homogeneous and reports the offending ids', async () => {
      respond({ error: 'batch_not_homogeneous', offending: ['ap-2'] }, 422);

      const outcome = await decideIntentApprovalBatch(IDS, 'approve');

      expect(outcome).toEqual({ outcome: 'batch_not_homogeneous', offending: ['ap-2'] });
      expect(toastMessages()[0].message).toMatch(/no longer be decided together/i);
    });

    it('maps a 400 batch_too_large to its own outcome with actionable copy', async () => {
      respond({ error: 'batch_too_large', max: 50 }, 400);

      const outcome = await decideIntentApprovalBatch(IDS, 'approve');

      expect(outcome).toEqual({ outcome: 'batch_too_large' });
      expect(toastMessages()[0].message).toMatch(/too many/i);
    });

    it('rethrows a 401 assertion_failed — a real proof rejection is not a step-up', async () => {
      respond({ error: 'assertion_failed' }, 401);

      const rejection = await decideIntentApprovalBatch(IDS, 'approve').catch((e: unknown) => e);

      expect(rejection).toBeInstanceOf(ActionError);
      expect((rejection as ActionError).status).toBe(401);
    });
  });
});
