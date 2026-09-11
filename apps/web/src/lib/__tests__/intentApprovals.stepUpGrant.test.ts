/**
 * #5601: `decideIntentApproval` can spend a step-up grant minted by a prior
 * approve response instead of running the WebAuthn ceremony again. These
 * tests focus purely on the grant lifecycle (mint → cache → spend → expire →
 * refuse-and-retry-once); the pre-existing ceremony/deny/error-mapping
 * behaviour is covered by the sibling `../intentApprovals.test.ts`.
 *
 * Two request paths exist after the #5600 merge, and the tests below have to
 * know which one they are looking at:
 *
 *  - **No grant** — the ceremony runs up front and the POST is made by the
 *    `runAction` request thunk. `runAction` is mocked, so the thunk is never
 *    invoked automatically; `invokeRequest(i)` runs it to inspect the body.
 *  - **With a grant** — the POST is the OPTIMISTIC attempt (#5600's machinery,
 *    reused): `fetchWithAuth` is called directly, outside `runAction`, so a
 *    403 `step_up_required` can be retried without toasting a refusal that is
 *    about to be resolved. That call is visible in `fetchWithAuth.mock.calls`
 *    immediately, with no thunk to invoke.
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
/** The server's refusal of a presented grant, as the OPTIMISTIC attempt sees
 *  it: a real 403 Response whose body carries the token. */
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
 * Approves once with no cached grant and lets the response mint `grantId`,
 * then clears the mocks' call counts so the assertions in each test start
 * from zero. Mirrors "cache on success" as a setup step.
 *
 * The priming approve takes the NO-GRANT path, so its POST lives in an
 * un-invoked `runAction` thunk and never reaches `fetchWithAuth` — which is
 * why clearing leaves a clean slate for the grant attempt that follows.
 */
async function primeGrant(grantId = 'grant-1'): Promise<void> {
  getApprovalAssertion.mockResolvedValueOnce(PROOF);
  runAction.mockResolvedValueOnce({ stepUpGrantId: grantId });
  const outcome = await decideIntentApproval('priming-request', 'approve');
  expect(outcome).toBe('decided');
  getApprovalAssertion.mockClear();
  runAction.mockClear();
  fetchWithAuth.mockClear();
}

describe('decideIntentApproval — step-up grant (#5601)', () => {
  it('with no cached grant, runs the ceremony and POSTs proof, not a grant', async () => {
    getApprovalAssertion.mockResolvedValueOnce(PROOF);
    runAction.mockResolvedValueOnce(undefined);

    const outcome = await decideIntentApproval('ap-1', 'approve');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).toHaveBeenCalledTimes(1);
    await invokeRequest(0);
    const body = lastRequestBody();
    expect(body).toEqual({ proof: PROOF });
    expect(body).not.toHaveProperty('stepUpGrantId');
  });

  it('caches a minted grant and spends it on the next approve without a ceremony', async () => {
    await primeGrant('grant-1');

    runAction.mockResolvedValueOnce(undefined);
    const outcome = await decideIntentApproval('ap-2', 'approve');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).not.toHaveBeenCalled();
    // The grant attempt is the optimistic POST — made directly, not via a thunk.
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const body = bodyOfFetch(0);
    expect(body).toEqual({ stepUpGrantId: 'grant-1' });
    expect(body).not.toHaveProperty('proof');
  });

  it('a grant past its TTL is not spent — a fresh ceremony runs instead', async () => {
    const now = 1_000_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await primeGrant('grant-1');

      // 300_000ms TTL — one tick past it must count as expired.
      dateNowSpy.mockReturnValue(now + 300_001);
      getApprovalAssertion.mockResolvedValueOnce(PROOF);
      runAction.mockResolvedValueOnce(undefined);

      const outcome = await decideIntentApproval('ap-2', 'approve');

      expect(outcome).toBe('decided');
      expect(getApprovalAssertion).toHaveBeenCalledTimes(1);
      await invokeRequest(0);
      const body = lastRequestBody();
      expect(body).toEqual({ proof: PROOF });
      expect(body).not.toHaveProperty('stepUpGrantId');
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

    const outcome = await decideIntentApproval('ap-2', 'approve');

    expect(outcome).toBe('decided');
    // Exactly one ceremony for the retry — none for the (skipped) grant
    // attempt, and no second retry.
    expect(getApprovalAssertion).toHaveBeenCalledTimes(1);
    // The refusal was handled BEFORE runAction, so the user never saw a toast
    // for a step-up that was immediately resolved.
    expect(runAction).toHaveBeenCalledTimes(1);
    // The retry POST must carry the fresh proof and NOT the refused grant —
    // sending a credential already known to be refused alongside the new proof
    // would be pointless at best.
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

    const outcome = await decideIntentApproval('ap-2', 'approve');

    expect(outcome).toBe('needs_device');
    // One ceremony for the one allowed retry — never a second.
    expect(getApprovalAssertion).toHaveBeenCalledTimes(1);
    // A second runAction call would mean the retry looped instead of
    // terminating on the fresh-ceremony refusal.
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it('a refused grant is dropped from the cache, so the NEXT approve does not retry it', async () => {
    await primeGrant('grant-1');

    fetchWithAuth.mockResolvedValueOnce(stepUpRequiredResponse());
    getApprovalAssertion.mockResolvedValueOnce(PROOF);
    runAction.mockResolvedValueOnce(undefined);
    await decideIntentApproval('ap-2', 'approve');

    getApprovalAssertion.mockClear();
    runAction.mockClear();
    fetchWithAuth.mockClear();

    // One refusal is enough to know the grant is spent: this approve must run
    // a ceremony rather than re-offering the dead credential.
    getApprovalAssertion.mockResolvedValueOnce(PROOF);
    runAction.mockResolvedValueOnce(undefined);
    const outcome = await decideIntentApproval('ap-3', 'approve');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).toHaveBeenCalledTimes(1);
    await invokeRequest(0);
    expect(lastRequestBody()).toEqual({ proof: PROOF });
  });

  // #5600 interop: a supervised approve goes PROOFLESSLY by design (the server
  // records it L1/session_tap under a non-enforcing partner). It must not be
  // turned back into a credentialed request by a grant lying in the cache —
  // that would re-run the assurance ladder #5600 exists to avoid.
  it('a supervised approve stays proofless and sends no grant, even with one cached', async () => {
    await primeGrant('grant-1');

    runAction.mockResolvedValueOnce(undefined);
    const outcome = await decideIntentApproval('ap-2', 'approve', undefined, 'supervised');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).not.toHaveBeenCalled();
    const body = bodyOfFetch(0);
    expect(body).toEqual({});
    expect(body).not.toHaveProperty('stepUpGrantId');
    expect(body).not.toHaveProperty('proof');
  });

  it('deny never runs the ceremony and never sends a grant, even with one cached', async () => {
    await primeGrant('grant-1');

    runAction.mockResolvedValueOnce(undefined);
    const outcome = await decideIntentApproval('ap-2', 'deny');

    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).not.toHaveBeenCalled();
    await invokeRequest(0);
    const body = lastRequestBody();
    expect(body).toEqual({});
    expect(body).not.toHaveProperty('stepUpGrantId');
    expect(body).not.toHaveProperty('proof');
  });
});
