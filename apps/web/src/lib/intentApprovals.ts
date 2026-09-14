import type { AiApprovalScope } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import {
  AssertionChallengeError,
  getApprovalAssertion,
  getBatchApprovalAssertion,
} from '../stores/authenticator';
import { i18n } from './i18n';
import { ActionError, runAction } from './runAction';
import { showToast } from '../components/shared/Toast';

export type IntentDecisionOutcome = 'decided' | 'needs_device' | 'not_sole_approver';

/** One row's outcome inside a batch decide. `httpStatus < 300` means that row
 *  was actually decided; anything else is a per-row failure (409 lost race,
 *  410 expired, 403 lost authority) that did NOT stop the others. */
export interface BatchRowResult {
  id: string;
  httpStatus: number;
  body?: { error?: unknown } | null;
}

/**
 * Outcome of a batch decide. The three non-`decided` variants are WHOLE-batch
 * refusals: nothing was decided, so the caller must leave every row in place.
 */
export type IntentBatchOutcome =
  | { outcome: 'decided'; results: BatchRowResult[] }
  | { outcome: 'needs_device' }
  | { outcome: 'batch_step_up' }
  | { outcome: 'batch_not_homogeneous'; offending: string[] }
  | { outcome: 'batch_too_large' };

/**
 * Wraps any failure of the WebAuthn (Touch ID / Windows Hello) ceremony.
 *
 * Discriminating on WHERE the failure happened — not on the error's class — is
 * deliberate. `@simplewebauthn/browser` funnels every ceremony error through
 * `identifyAuthenticationError`, which returns a `WebAuthnError extends Error`;
 * the most common failure of all (user dismisses the sheet → `NotAllowedError`)
 * is therefore NOT a DOMException, so class-based checks miss it. Anything
 * thrown as a CeremonyError is guaranteed to have happened BEFORE any POST.
 */
export class CeremonyError extends Error {
  cause: unknown;
  constructor(cause: unknown) {
    super('Approval verification ceremony failed');
    this.name = 'CeremonyError';
    this.cause = cause;
  }
}

/**
 * True when the assertion ceremony failed because the viewer has no registered
 * approver device (the challenge carried no allowCredentials). That error is
 * raised by getApprovalAssertion itself, before `startAuthentication` runs, and
 * carries an exact `name`; a genuine cancelled/timed-out ceremony carries the
 * library's own name (`NotAllowedError`, `AbortError`, …) and must NOT match —
 * the caller aborts instead. Mirrors PamRespondModal's helper of the same name;
 * the outcome here is a "register a device" CTA rather than an L1 fallback,
 * because the sole-operator self-approve gate on the server (approvals.ts)
 * REQUIRES an L3 proof and refuses a proofless approve.
 */
export function isNoApproverDeviceError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'NoApproverDeviceError';
}

/** Reads the route's bare machine token out of an ActionError body. The decide
 *  route answers `{ error: '<token>' }` with no `code`, which is also the field
 *  runAction's `friendly` hook is handed when `code` is absent. */
function errorToken(err: unknown): string | undefined {
  if (!(err instanceof ActionError)) return undefined;
  const body = err.body as { error?: unknown } | null | undefined;
  return typeof body?.error === 'string' ? body.error : undefined;
}

/** The server's L3 self-approve rejection (approvals.ts, 403). Same remedy as
 *  a missing authenticator: register a device — so it drives the same CTA. */
export function isStepUpRequired(err: unknown): boolean {
  return errorToken(err) === 'step_up_required';
}

/**
 * The decide handler re-derives sole-operator status at decide time (#2685) and
 * answers 403 `not_sole_approver` once the org has gained another eligible
 * approver since the intent was created. Unlike `step_up_required` there is no
 * remedy the viewer can apply: they are no longer allowed to decide their own
 * request at all, so this is terminal for this card — somebody else has to
 * approve it on the /approvals surface. The submission itself worked, so it
 * must never surface as the generic `decideFailed` copy.
 */
export function isNotSoleApprover(err: unknown): boolean {
  return errorToken(err) === 'not_sole_approver';
}

/** Bare machine tokens the decide route emits in `error` (no `code`), mapped to
 *  translated copy. Without this the user is shown the literal token. Keys are
 *  spelled out as literals so the i18n key-usage scanner can see them. */
export function decideErrorCopy(token: string): string | undefined {
  if (token === 'step_up_required') return i18n.t('ai:aiApprovalDialog.noApproverDevice');
  if (token === 'not_sole_approver') return i18n.t('ai:aiApprovalDialog.notSoleApprover');
  // W03 (#5612): the decide route's 422 refusals of a submitted
  // acknowledgedPatterns set — the server re-derives (submitted ∩
  // strict_hits) and refuses either when the viewer may not acknowledge at
  // all, or when the submitted set doesn't cover every current strict hit.
  if (token === 'strict_acknowledgement_not_permitted') {
    return i18n.t('ai:scriptProposal.acknowledgeRequirement');
  }
  if (token === 'strict_acknowledgement_incomplete') {
    return i18n.t('ai:scriptProposal.acknowledgeIncomplete');
  }
  return undefined;
}

/** The server's whole-batch refusal (422): the set is no longer one decision.
 *  Terminal for the batch, but NOT for the cards — each can still be decided
 *  on its own, so the caller must leave every row on screen. */
export function isBatchNotHomogeneous(err: unknown): boolean {
  return errorToken(err) === 'batch_not_homogeneous';
}

/** The server's 400 `batch_too_large` (services/approvals/batchDecide.ts's
 *  `BATCH_MAX`). The client mirrors this cap in `ApprovalsInbox` (#4460) so
 *  the request is normally never sent, but a stale client bundle or a second
 *  tab that grew a group past the cap between renders can still reach the
 *  server — this is that defense-in-depth path, not the primary one. */
export function isBatchTooLarge(err: unknown): boolean {
  return errorToken(err) === 'batch_too_large';
}

/**
 * The batch route's 401 `reauth_required`. On the SINGLE-card path this is a
 * WebAuthn proof rejection ("your scan failed, try again"); on the batch path
 * it is structural and permanent: `decideApprovalBatch` deliberately does not
 * plumb `reauthVerified`, so a set whose highest tier demands re-auth can never
 * clear the ladder no matter how many times it is retried. Same remedy as
 * `step_up_required` — decide the cards one at a time, where the re-auth is
 * collected per decision — so it maps to the same outcome and the same copy.
 * Without this it surfaced as "Verification was canceled or failed. Try again."
 * on a batch that can only ever fail: wrong blame, and a dead end.
 */
export function isBatchReauthRequired(err: unknown): boolean {
  return (
    err instanceof ActionError && err.status === 401 && errorToken(err) === 'reauth_required'
  );
}

/** Batch copy for the two whole-batch refusals, falling back to the single-card
 *  map. `step_up_required` MUST NOT reuse the single-card "register a device"
 *  copy: a batch 403s because the highest tier in the set outranks what one
 *  ceremony can clear, and the remedy is to decide the cards one at a time. */
export function batchDecideErrorCopy(token: string): string | undefined {
  // `reauth_required` shares the copy because it shares the remedy — see
  // isBatchReauthRequired.
  if (token === 'step_up_required' || token === 'reauth_required') {
    return i18n.t('approvals:errors.batchStepUp');
  }
  if (token === 'batch_not_homogeneous') return i18n.t('approvals:errors.batchNotHomogeneous');
  if (token === 'batch_too_large') return i18n.t('approvals:errors.batchTooLarge');
  return decideErrorCopy(token);
}

/**
 * How long a step-up grant minted by a decide response stays worth trying
 * before a fresh ceremony (#5601). Mirrors the server's own
 * `APPROVAL_DECIDE_GRANT_TTL_MS` (120 s — Todd's call, 2026-09-11), but on
 * this side it is only a LATENCY hint: it saves us attempting a grant we can
 * locally tell has gone stale. The server is the sole authority on whether a
 * grant is good (scope, expiry, device liveness, partner floor); one that
 * survives this check can still be refused with `step_up_required`, which the
 * retry below handles.
 */
const STEP_UP_GRANT_TTL_MS = 120_000;

/**
 * The most recent step-up grant a decide response minted (#5601), so a
 * follow-up approve inside the window can skip the WebAuthn ceremony.
 *
 * A single slot, not keyed by approval id: the server binds a grant to a
 * CONVERSATION, org and risk tier rather than to one approval row, so a grant
 * earned deciding one card is usually good for the next card of the same
 * conversation — which is the whole point.
 *
 * It is NOT good for every card: another chat, another org or a higher risk
 * tier is refused server-side, and this cache cannot tell those apart. That is
 * deliberate — the client does not re-implement the scope rules, it tries the
 * grant and lets the `step_up_required` retry fall back to a real ceremony.
 * Never treat a cached id as authority.
 */
let stepUpGrant: { id: string; expiresAt: number } | null = null;

function cachedStepUpGrantId(): string | undefined {
  if (!stepUpGrant) return undefined;
  if (stepUpGrant.expiresAt <= Date.now()) {
    stepUpGrant = null;
    return undefined;
  }
  return stepUpGrant.id;
}

/** Test-only reset of the module-level grant cache (#5601): it lives for the
 *  lifetime of the module, so without this a grant minted in one test would
 *  leak into the next. */
export function __resetStepUpGrantCacheForTests(): void {
  stepUpGrant = null;
}

/**
 * Decide the viewer's own fanned-out approval row for a Tier-3 action intent
 * (the inline chat self-approve, sole-operator case).
 *
 * Approve runs the WebAuthn (Touch ID / Windows Hello) ceremony first and
 * POSTs the proof — EXCEPT when `approvalScope` is `'supervised'` (#5600). The
 * 2026-08-05 supervised/four-eyes split moved the L3 sole-operator requirement
 * to `four_eyes` only: `decideApprovalRequest.ts` skips the assurance ladder
 * for a supervised self-decide under a non-enforcing partner policy, but ONLY
 * when no proof is presented (a presented proof is always verified, never
 * discarded). So a client that always attaches a proof makes the server always
 * run the ladder — which is why every supervised chat approve was still paying
 * a passkey ceremony. Supervised therefore POSTs prooflessly first; an
 * enforcing partner policy answers 403 `step_up_required`, and that — and only
 * that — triggers exactly ONE retry with the ceremony. `four_eyes` and any
 * unknown/absent scope keep the always-ceremony behaviour.
 *
 * #5601 layers onto that SAME optimistic-attempt machinery, for SUPERVISED
 * rows only. A supervised approve that holds a live step-up grant sends
 * `stepUpGrantId` on the optimistic attempt instead of going proofless — the
 * server treats a valid grant as equivalent to a fresh proof, which is what an
 * ENFORCING partner's step-up floor demands. A refused grant takes the
 * identical 403 `step_up_required` path: drop it, run the ceremony, retry
 * exactly once. The grant is only ever tried on the FIRST attempt, so the
 * whole function stays bounded at two POSTs.
 *
 * `four_eyes` NEVER sends a grant (Todd, 2026-09-11): it is the high-trust
 * path and keeps its per-approval passkey ceremony, and the server refuses a
 * grant there anyway. The cache is therefore only ever filled by, and spent
 * on, supervised approves.
 *
 * Deny needs no proof under any scope, skips the ceremony, and may carry the
 * optional reason collected by the approvals inbox.
 *
 * Returns 'needs_device' when no approver device is registered (before any
 * network write) or when the server answers `step_up_required` — the caller
 * should show a "register a device" CTA rather than retrying. Returns
 * 'not_sole_approver' when the server answers that token: the org gained
 * another eligible approver, so self-approval is off the table for good and the
 * caller should settle the card terminally rather than re-offer a button.
 * Throws
 * CeremonyError on a cancelled/failed ceremony (nothing was POSTed) and
 * ActionError on server rejection (runAction has already toasted the latter).
 *
 * The POST opts out of two defaults that would otherwise hide failures: it
 * skips fetchWithAuth's 401 refresh-and-replay (the assertion is single-use, so
 * a replay can only burn it again) and asks runAction to treat the 401 as a
 * real, toastable error — the decide route answers 401 for `assertion_failed`
 * and `reauth_required`, which are proof rejections, not session expiry.
 *
 * Toast copy comes from the shared `i18n` singleton (`./i18n`, a named
 * export) rather than a `useTranslation` hook — this is a non-component lib
 * helper. The `ai:` namespace prefix routes `i18n.t` to the aiApprovalDialog
 * keys added by Task 5 (`decideFailed` / `approvedToast` / `deniedToast`).
 */
export async function decideIntentApproval(
  approvalRequestId: string,
  decision: 'approve' | 'deny',
  reason?: string,
  approvalScope?: AiApprovalScope | null,
  /**
   * W03 (#5612): the STRICT pattern descriptions ticked on the
   * ScriptProposalApprovalCard. The server re-derives
   * (submitted ∩ strict_hits) itself — this is a request, not a grant — and
   * may answer 422 `strict_acknowledgement_not_permitted` /
   * `strict_acknowledgement_incomplete` (mapped by `decideErrorCopy` below).
   * A distinct 5th parameter, not folded into `approvalScope`: that slot is
   * already a heavily-tested positional argument (intentApprovals.test.ts,
   * intentApprovals.stepUpGrant.test.ts), so repurposing it would break both
   * suites for no reason — this is purely additive.
   */
  opts?: { acknowledgedPatterns?: string[] },
): Promise<IntentDecisionOutcome> {
  const body: Record<string, unknown> = {};
  if (opts?.acknowledgedPatterns?.length) {
    body.acknowledgedPatterns = opts.acknowledgedPatterns;
  }
  // Only an APPROVE of a supervised row may go prooflessly; deny never carries
  // a proof anyway, and an unknown scope must fall back to the strict path.
  const supervisedApprove = decision === 'approve' && approvalScope === 'supervised';
  // #5601: ONLY a supervised approve may spend a live step-up grant — it rides
  // the optimistic attempt in place of the proofless body, which is what lets
  // an enforcing partner's floor be met without a second passkey scan. Read
  // ONCE here so the retry below can never pick up a second grant and loop.
  const firstAttemptGrantId = supervisedApprove ? cachedStepUpGrantId() : undefined;

  /** Runs the ceremony into `body.proof`. Returns a terminal outcome when the
   *  viewer has no approver device; throws CeremonyError on a real failure. */
  const collectProof = async (): Promise<'needs_device' | null> => {
    try {
      body.proof = await getApprovalAssertion('/mobile/approvals', approvalRequestId);
      return null;
    } catch (err) {
      // No registered approver device → return the CTA signal instead of
      // POSTing. Unlike PamRespondModal, we do NOT submit without a proof:
      // the four_eyes self-approve gate requires L3.
      if (isNoApproverDeviceError(err)) return 'needs_device';
      throw new CeremonyError(err);
    }
  };

  if (decision === 'approve' && !supervisedApprove) {
    // four_eyes / unknown scope: always a fresh ceremony, never a grant.
    const noDevice = await collectProof();
    if (noDevice) return noDevice;
  } else if (firstAttemptGrantId) {
    // #5601: supervised with a live grant — present it instead of going
    // proofless, so an enforcing partner's floor is met without a scan.
    body.stepUpGrantId = firstAttemptGrantId;
  } else if (decision === 'deny' && reason?.trim()) {
    body.reason = reason.trim();
  }

  // The supervised optimistic attempt runs OUTSIDE runAction so a 403
  // `step_up_required` can be retried silently: runAction toasts every failure
  // it sees, and telling the user "register a device" a beat before the
  // approval succeeds would be a lie. Whatever response survives this block is
  // handed to runAction untouched (the token is read off a clone, so the body
  // is still unconsumed) — success toast, error toast and outcome mapping all
  // stay in exactly one place.
  let settledResponse: Response | undefined;
  if (supervisedApprove) {
    let firstAttempt: Response;
    try {
      // runaction-exempt: the optimistic proofless attempt (#5600). runAction
      // toasts every failure it sees, and a 403 `step_up_required` here is
      // RETRIED with the ceremony — toasting "register a device" a beat before
      // the approval succeeds would be a lie. Nothing is swallowed: every other
      // response is handed to the runAction call below untouched, and the catch
      // below reproduces runAction's own transport-error toast.
      firstAttempt = await fetchWithAuth(`/mobile/approvals/${approvalRequestId}/approve`, {
        method: 'POST',
        body: JSON.stringify(body),
        skipUnauthorizedRetry: true,
      });
    } catch {
      // A THROW (network failure, a lapsed refresh in fetchWithAuth) never
      // reaches runAction on this branch, so reproduce its own transport-error
      // shape here rather than letting the rejection escape untoasted — the
      // one failure mode this optimistic attempt could otherwise report only
      // as inline card text. Never retried: the POST may have been received.
      const message = i18n.t('ai:aiApprovalDialog.decideFailed');
      showToast({ message, type: 'error' });
      throw new ActionError(message, 0);
    }
    if (firstAttempt.status === 403) {
      const token = await firstAttempt
        .clone()
        .json()
        .then((data: unknown) =>
          data && typeof data === 'object' ? (data as { error?: unknown }).error : undefined,
        )
        .catch(() => undefined);
      if (token === 'step_up_required') {
        // Enforcing partner authenticator policy (#5600), or a grant the
        // server refused — expired, out of scope, or minted by a since-revoked
        // device (#5601). Either way the step-up floor stands and the viewer
        // can satisfy it: exactly one retry, with a real ceremony.
        //
        // The grant is dropped from BOTH the cache and the body. Leaving it on
        // the body would send a credential we already know is refused
        // alongside the new proof, and leaving it cached would re-offer it on
        // the next card — one refusal is enough to know it is spent.
        if (firstAttemptGrantId) {
          stepUpGrant = null;
          delete body.stepUpGrantId;
        }
        const noDevice = await collectProof();
        if (noDevice) return noDevice;
      } else {
        settledResponse = firstAttempt;
      }
    } else {
      settledResponse = firstAttempt;
    }
  }

  try {
    const data = await runAction<{ stepUpGrantId?: unknown } | null>({
      // Kept inline rather than hoisted: the no-silent-mutations guard walks
      // parents for an enclosing runAction call, so a hoisted thunk reads as an
      // unwrapped mutation even when passed straight in. `settledResponse` is
      // the optimistic attempt above, already made and still unread.
      request: () =>
        settledResponse
          ? Promise.resolve(settledResponse)
          : fetchWithAuth(`/mobile/approvals/${approvalRequestId}/${decision}`, {
              method: 'POST',
              body: JSON.stringify(body),
              skipUnauthorizedRetry: true,
            }),
      errorFallback: i18n.t('ai:aiApprovalDialog.decideFailed'),
      // NO onUnauthorized here, deliberately. `treatUnauthorizedAsError` makes
      // runAction skip its 401 branch entirely, so the callback would be dead
      // code — and worse than dead: this route answers 401 for `assertion_failed`
      // and `reauth_required`, which are WebAuthn PROOF rejections, not session
      // expiry. Wiring a /login redirect here would bounce a user out of the app
      // because their fingerprint scan failed.
      treatUnauthorizedAsError: true,
      friendly: decideErrorCopy,
      successMessage:
        decision === 'approve'
          ? i18n.t('ai:aiApprovalDialog.approvedToast')
          : i18n.t('ai:aiApprovalDialog.deniedToast'),
    });
    // #5601: a genuine ceremony on a SUPERVISED decide (an enforcing partner
    // forced one via the retry above) may have minted a reusable grant. Cache
    // it so the NEXT card of this conversation skips the scan. A supervised
    // L1 decide mints none, and a four_eyes decide never mints one — the
    // server does not, and even if it did the cache must stay supervised-only.
    if (supervisedApprove && typeof data?.stepUpGrantId === 'string') {
      stepUpGrant = { id: data.stepUpGrantId, expiresAt: Date.now() + STEP_UP_GRANT_TTL_MS };
    }
  } catch (err) {
    // Whatever authority we were relying on is no good any more — never let a
    // cached grant outlive it.
    if (err instanceof ActionError && (err.status === 401 || err.status === 403)) {
      stepUpGrant = null;
    }
    if (isStepUpRequired(err)) return 'needs_device';
    if (isNotSoleApprover(err)) return 'not_sole_approver';
    throw err;
  }

  return 'decided';
}

/**
 * Decide MANY approval cards with ONE WebAuthn ceremony (P2-2, #4189).
 *
 * A scheduled sweep proposes one intent — and one card — per device, so a
 * fleet-wide finding lands in the inbox as N identical cards. Approving them
 * one at a time means N Touch ID / Windows Hello prompts for what is, to the
 * human, a single decision.
 *
 * Safety rests entirely on the server's homogeneity rule
 * (`services/approvals/batchDecide.ts`): every row must still be pending,
 * fanned out to this user, linked to a SUPERVISED agent-originated intent, and
 * in the same `(orgId, actionToolName, action)` group. The caller must only
 * ever offer a batch the server would accept — the UI grouping predicate
 * mirrors that rule — but the server re-derives it from fresh rows regardless,
 * and answers 422 for the whole set rather than partially deciding one the
 * approver may have misread.
 *
 * Returns per-row outcomes on a 200; the four refusal variants mean NOTHING
 * was decided:
 *   - `needs_device`      — no registered approver device (no POST happened)
 *   - `batch_step_up`     — 403 `step_up_required` OR 401 `reauth_required`:
 *                           the tier ceiling this batch would have to clear is
 *                           above what one ceremony can, so these cards must be
 *                           decided individually (where re-auth is collected
 *                           per decision)
 *   - `batch_not_homogeneous` — 422: the set drifted (a row was decided
 *                           elsewhere, an intent settled); the cards remain
 *                           individually decidable
 *   - `batch_too_large`   — 400: the set exceeds `BATCH_MAX`. The caller
 *                           (`ApprovalsInbox`) mirrors this cap client-side
 *                           (#4460) and refuses before calling in, so this
 *                           only fires on a stale bundle or a drifted group —
 *                           the cards remain individually decidable
 *
 * Deny skips the ceremony (no proof required) and carries the ONE reason the
 * group collected. Throws CeremonyError on a cancelled/failed ceremony (nothing
 * was POSTed) and ActionError on any other server rejection.
 */
export async function decideIntentApprovalBatch(
  approvalRequestIds: string[],
  decision: 'approve' | 'deny',
  reason?: string,
): Promise<IntentBatchOutcome> {
  // The server's spelling: the decision is part of what the batch challenge is
  // cryptographically bound to, not a UI label.
  const serverDecision = decision === 'approve' ? 'approved' : 'denied';
  const body: Record<string, unknown> = {
    approvalRequestIds,
    decision: serverDecision,
  };

  if (decision === 'approve') {
    try {
      body.proof = await getBatchApprovalAssertion(
        '/mobile/approvals',
        approvalRequestIds,
        serverDecision,
      );
    } catch (err) {
      // Same CTA signal as the single-card path — the self-approve gate
      // requires an L3 proof, so we never POST a proofless approve.
      if (isNoApproverDeviceError(err)) return { outcome: 'needs_device' };
      // The batch challenge route re-validates the set BEFORE minting, so a
      // drifted set is refused here rather than at the decide call. Reporting
      // it as a ceremony failure would tell the approver their fingerprint
      // scan failed when in fact the cards moved.
      if (err instanceof AssertionChallengeError) {
        if (err.token === 'batch_not_homogeneous') {
          // Issue #4459: the challenge route re-validates BEFORE minting, so
          // an approve's drift is usually caught here rather than at decide —
          // `err.offending` is the same server-computed id list, now carried
          // through `AssertionChallengeError` instead of being discarded.
          return { outcome: 'batch_not_homogeneous', offending: err.offending ?? [] };
        }
        if (err.token === 'step_up_required') return { outcome: 'batch_step_up' };
        // Same BATCH_MAX check the decide call would hit (loadHomogeneousBatch
        // runs it before minting a challenge too) — reported here rather than
        // falling through to CeremonyError below, which would tell the
        // approver their fingerprint scan failed when no ceremony ran at all.
        if (err.token === 'batch_too_large') return { outcome: 'batch_too_large' };
      }
      throw new CeremonyError(err);
    }
  } else if (reason?.trim()) {
    body.reason = reason.trim();
  }

  try {
    const data = await runAction<{ results?: BatchRowResult[] } | null>({
      // Inline, not hoisted: the no-silent-mutations guard walks parents for an
      // enclosing runAction call, so a hoisted thunk reads as an unwrapped
      // mutation even when passed straight in.
      request: () =>
        fetchWithAuth('/mobile/approvals/batch/decide', {
          method: 'POST',
          body: JSON.stringify(body),
          skipUnauthorizedRetry: true,
        }),
      errorFallback: i18n.t('ai:aiApprovalDialog.decideFailed'),
      // Same reasoning as the single-card decide: this route answers 401 for
      // `assertion_failed` / `reauth_required`, which are proof rejections, not
      // session expiry — a /login redirect here would bounce a user out of the
      // app because their fingerprint scan failed.
      treatUnauthorizedAsError: true,
      friendly: batchDecideErrorCopy,
      // A 200 can still carry per-row failures, and those are reported INLINE
      // on the rows that survived. Toasting "Approved" over a partial result
      // would overstate what happened, so the toast fires only when every row
      // was decided; an empty string is runAction's own "no toast" signal.
      successMessage: (result) => {
        const rows = result?.results ?? [];
        if (rows.length === 0 || rows.some((row) => row.httpStatus >= 300)) return '';
        // Paper cut: this toast used to read the singular "Action
        // approved"/"Action denied" no matter how many cards the batch
        // decided. Passing `count` selects the `_one`/`_other` plural form
        // (see ai.json) — the base key with no `count` is unaffected, so the
        // single-card `decideIntentApproval` path above keeps its original
        // copy.
        return decision === 'approve'
          ? i18n.t('ai:aiApprovalDialog.approvedToast', { count: rows.length })
          : i18n.t('ai:aiApprovalDialog.deniedToast', { count: rows.length });
      },
    });
    return {
      outcome: 'decided',
      results: Array.isArray(data?.results) ? data.results : [],
    };
  } catch (err) {
    if (isBatchNotHomogeneous(err)) {
      const offending = (err as ActionError).body as { offending?: unknown } | null | undefined;
      return {
        outcome: 'batch_not_homogeneous',
        offending: Array.isArray(offending?.offending)
          ? offending.offending.filter((id): id is string => typeof id === 'string')
          : [],
      };
    }
    if (isStepUpRequired(err) || isBatchReauthRequired(err)) {
      return { outcome: 'batch_step_up' };
    }
    if (isBatchTooLarge(err)) {
      return { outcome: 'batch_too_large' };
    }
    throw err;
  }
}
