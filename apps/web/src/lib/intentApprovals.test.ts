import { describe, it, expect, vi, beforeEach } from 'vitest';

const getApprovalAssertion = vi.fn();
const runAction = vi.fn();
const fetchWithAuth = vi.fn();
const showToast = vi.fn();
vi.mock('../stores/authenticator', () => ({
  getApprovalAssertion: (...args: unknown[]) => getApprovalAssertion(...args),
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

import { CeremonyError, decideIntentApproval } from './intentApprovals';
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
