/**
 * #5601: `decideIntentApproval` can spend a step-up grant minted by a prior
 * approve response instead of running the WebAuthn ceremony again. These
 * tests focus purely on the grant lifecycle (mint → cache → spend → expire →
 * refuse-and-retry-once); the pre-existing ceremony/deny/error-mapping
 * behaviour is covered by the sibling `../intentApprovals.test.ts`.
 *
 * SUPERVISED ONLY (Todd, 2026-09-11): the grant is filled by, and spent on,
 * supervised approves alone. A `four_eyes` approve always runs the passkey
 * ceremony and never sends a grant — it is the high-trust path.
 *
 * Two request paths exist after the #5600 merge, and the tests below have to
 * know which one they are looking at:
 *
 *  - **four_eyes / unknown scope** — the ceremony runs up front and the POST
 *    is made by the `runAction` request thunk. `runAction` is mocked, so the
 *    thunk is never invoked automatically; `invokeRequest(i)` runs it to
 *    inspect the body.
 *  - **supervised** — the POST is the OPTIMISTIC attempt (#5600's machinery):
 *    `fetchWithAuth` is called directly, outside `runAction`, so a 403
 *    `step_up_required` can be retried without toasting a refusal that is
 *    about to be resolved. That call is visible in `fetchWithAuth.mock.calls`
 *    immediately, with no thunk to invoke. With a live grant the optimistic
 *    body carries `stepUpGrantId`; without one it is proofless (`{}`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getApprovalAssertion = vi.fn();
const runAction = vi.fn();
const fetchWithAuth = vi.fn();
const showToast = vi.fn();

vi.mock('../../stores/authenticator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/authenticator')>()),
  getApprovalAssertion: (...args: unknown[]) => getApprovalAssertion(...args),
}));
vi.mock('../runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runAction')>();
  return { ...actual, runAction: (...args: unknown[]) => runAction(...args) };
});
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock('../../components/shared/Toast', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));

import { decideIntentApproval, __resetStepUpGrantCacheForTests } from '../intentApprovals';
import { ActionError } from '../runAction';

const PROOF = { type: 'webauthn_platform', credentialId: 'c1' };
const STEP_UP_REQUIRED = () =>
  new ActionError('Forbidden', 403, undefined, { error: 'step_up_required' });
/** The server's refusal of an optimistic attempt (proofless, or a presented
 *  grant), as that attempt sees it: a real 403 Response carrying the token. */
const stepUpRequiredResponse = () =>
  new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 });

beforeEach(() => {
  vi.clearAllMocks();
  __resetStepUpGrantCacheForTests();
  fetchWithAuth.mockResolvedValue(new Response('{}', { status: 200 }));
});

/** Invoke the `request` thunk a given runAction call was handed, so the
 *  actual HTTP call it would make is inspectable. */
async function invokeRequest(callIndex: number): Promise<void> {
  const opts = runAction.mock.calls[callIndex][0] as { request: () => Promise<unknown> };
  await opts.request();
}

function bodyOfFetch(callIndex: number): Record<string, unknown> {
  const [, init] = fetchWithAuth.mock.calls[callIndex] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

function lastRequestBody(): Record<string, unknown> {
  const [, init] = fetchWithAuth.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(init.body as string);
}

/**
 * Primes the cache the way production does: a SUPERVISED approve under an
 * enforcing partner — the proofless optimistic attempt is refused, the
 * one-shot ceremony retry succeeds, and the decide response mints `grantId`.
 * Then clears the mocks' call counts so each test's assertions start at zero.
 */
async function primeGrant(grantId = 'grant-1'): Promise<void> {
  fetchWithAuth.mockResolvedValueOnce(stepUpRequiredResponse());
  getApprovalAssertion.mockResolvedValueOnce(PROOF);
  runAction.mockResolvedValueOnce({ stepUpGrantId: grantId });
  const outcome = await decideIntentApproval('priming-request', 'approve', undefined, 'supervised');
  expect(outcome).toBe('decided');
  getApprovalAssertion.mockClear();
  runAction.mockClear();
  fetchWithAuth.mockClear();
}

describe('decideIntentApproval — step-up grant (#5601)', () => {
  it('supervised with no cached grant goes proofless (the #5600 path, unchanged)', async () => {
    runAction.mockResolvedValueOnce(undefined);

    const outcome = await decideIntentApproval('ap-1', 'approve', undefined, 'supervised');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(bodyOfFetch(0)).toEqual({});
  });

  it('caches a grant minted by a supervised ceremony and spends it on the next supervised approve instead of going proofless', async () => {
    await primeGrant('grant-1');

    runAction.mockResolvedValueOnce(undefined);
    const outcome = await decideIntentApproval('ap-2', 'approve', undefined, 'supervised');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).not.toHaveBeenCalled();
    // The grant rides the optimistic POST — made directly, not via a thunk.
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const body = bodyOfFetch(0);
    expect(body).toEqual({ stepUpGrantId: 'grant-1' });
    expect(body).not.toHaveProperty('proof');
  });

  it('the window is 120 s: a grant 119 s old is spent, one 121 s old is not', async () => {
    const now = 1_000_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await primeGrant('grant-1');

      dateNowSpy.mockReturnValue(now + 119_000);
      runAction.mockResolvedValueOnce(undefined);
      await decideIntentApproval('ap-2', 'approve', undefined, 'supervised');
      expect(bodyOfFetch(0)).toEqual({ stepUpGrantId: 'grant-1' });
      fetchWithAuth.mockClear();

      dateNowSpy.mockReturnValue(now + 121_000);
      runAction.mockResolvedValueOnce(undefined);
      await decideIntentApproval('ap-3', 'approve', undefined, 'supervised');
      // Expired locally: back to the proofless optimistic attempt, no grant.
      expect(bodyOfFetch(0)).toEqual({});
      expect(getApprovalAssertion).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('a refused grant retries EXACTLY ONCE with a fresh ceremony, and succeeds', async () => {
    await primeGrant('grant-1');

    // The optimistic grant attempt is refused by the server...
    fetchWithAuth.mockResolvedValueOnce(stepUpRequiredResponse());
    getApprovalAssertion.mockResolvedValueOnce(PROOF);
    runAction.mockResolvedValueOnce(undefined);

    const outcome = await decideIntentApproval('ap-2', 'approve', undefined, 'supervised');

    expect(outcome).toBe('decided');
    // Exactly one ceremony for the retry — none for the grant attempt, and no
    // second retry.
    expect(getApprovalAssertion).toHaveBeenCalledTimes(1);
    // The refusal was handled BEFORE runAction, so the user never saw a toast
    // for a step-up that was immediately resolved.
    expect(runAction).toHaveBeenCalledTimes(1);
    // The retry POST must carry the fresh proof and NOT the refused grant.
    await invokeRequest(0);
    const body = lastRequestBody();
    expect(body).toEqual({ proof: PROOF });
    expect(body).not.toHaveProperty('stepUpGrantId');
  });

  it('a refused grant whose retry ALSO fails returns needs_device, with no further loop', async () => {
    await primeGrant('grant-1');

    fetchWithAuth.mockResolvedValueOnce(stepUpRequiredResponse());
    getApprovalAssertion.mockResolvedValueOnce(PROOF);
    runAction.mockRejectedValueOnce(STEP_UP_REQUIRED());

    const outcome = await decideIntentApproval('ap-2', 'approve', undefined, 'supervised');

    expect(outcome).toBe('needs_device');
    expect(getApprovalAssertion).toHaveBeenCalledTimes(1);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it('a refused grant is dropped from the cache, so the NEXT approve does not retry it', async () => {
    await primeGrant('grant-1');

    fetchWithAuth.mockResolvedValueOnce(stepUpRequiredResponse());
    getApprovalAssertion.mockResolvedValueOnce(PROOF);
    runAction.mockResolvedValueOnce(undefined);
    await decideIntentApproval('ap-2', 'approve', undefined, 'supervised');

    getApprovalAssertion.mockClear();
    runAction.mockClear();
    fetchWithAuth.mockClear();

    // One refusal is enough to know the grant is spent: this approve goes
    // back to the proofless attempt rather than re-offering the dead grant.
    runAction.mockResolvedValueOnce(undefined);
    const outcome = await decideIntentApproval('ap-3', 'approve', undefined, 'supervised');

    expect(outcome).toBe('decided');
    expect(bodyOfFetch(0)).toEqual({});
  });

  // Todd's call (2026-09-11): four_eyes keeps its per-approval passkey. Even
  // with a live grant cached by a supervised approve, a four_eyes approve
  // must run the ceremony and must not present the grant.
  it('a four_eyes approve runs the ceremony and never sends a grant, even with one cached', async () => {
    await primeGrant('grant-1');

    getApprovalAssertion.mockResolvedValueOnce(PROOF);
    runAction.mockResolvedValueOnce(undefined);
    const outcome = await decideIntentApproval('ap-2', 'approve', undefined, 'four_eyes');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).toHaveBeenCalledTimes(1);
    // No optimistic attempt at all for four_eyes: the POST lives in the
    // runAction thunk.
    expect(fetchWithAuth).not.toHaveBeenCalled();
    await invokeRequest(0);
    const body = lastRequestBody();
    expect(body).toEqual({ proof: PROOF });
    expect(body).not.toHaveProperty('stepUpGrantId');
  });

  it('a grant returned on a four_eyes decide is NOT cached: the next supervised approve goes proofless', async () => {
    // Defensive: the server never mints for four_eyes, but the client must
    // not trust a stray field into the cache either.
    getApprovalAssertion.mockResolvedValueOnce(PROOF);
    runAction.mockResolvedValueOnce({ stepUpGrantId: 'grant-stray' });
    await decideIntentApproval('ap-1', 'approve', undefined, 'four_eyes');
    fetchWithAuth.mockClear();

    runAction.mockResolvedValueOnce(undefined);
    await decideIntentApproval('ap-2', 'approve', undefined, 'supervised');
    expect(bodyOfFetch(0)).toEqual({});
  });

  it('an approve with no scope runs the ceremony and never sends a grant, even with one cached', async () => {
    await primeGrant('grant-1');

    getApprovalAssertion.mockResolvedValueOnce(PROOF);
    runAction.mockResolvedValueOnce(undefined);
    const outcome = await decideIntentApproval('ap-2', 'approve');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).toHaveBeenCalledTimes(1);
    await invokeRequest(0);
    expect(lastRequestBody()).toEqual({ proof: PROOF });
  });

  it('deny never runs the ceremony and never sends a grant, even with one cached', async () => {
    await primeGrant('grant-1');

    runAction.mockResolvedValueOnce(undefined);
    const outcome = await decideIntentApproval('ap-2', 'deny', undefined, 'supervised');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).not.toHaveBeenCalled();
    await invokeRequest(0);
    const body = lastRequestBody();
    expect(body).toEqual({});
    expect(body).not.toHaveProperty('stepUpGrantId');
    expect(body).not.toHaveProperty('proof');
  });
});
