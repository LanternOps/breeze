import { fetchWithAuth } from '../stores/auth';
import { getApprovalAssertion } from '../stores/authenticator';
import { i18n } from './i18n';
import { ActionError, runAction } from './runAction';

export type IntentDecisionOutcome = 'decided' | 'needs_device' | 'not_sole_approver';

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
  return undefined;
}

/**
 * Decide the viewer's own fanned-out approval row for a Tier-3 action intent
 * (the inline chat self-approve, sole-operator case). Approve runs the
 * WebAuthn (Touch ID / Windows Hello) ceremony first — the server's L3
 * self-approve gate refuses a proofless approve — then POSTs the proof to the
 * existing decide endpoint. Deny needs no proof, skips the ceremony, and may
 * carry the optional reason collected by the approvals inbox.
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
): Promise<IntentDecisionOutcome> {
  const body: Record<string, unknown> = {};

  if (decision === 'approve') {
    try {
      body.proof = await getApprovalAssertion('/mobile/approvals', approvalRequestId);
    } catch (err) {
      // No registered approver device → return the CTA signal instead of
      // POSTing. Unlike PamRespondModal, we do NOT submit without a proof:
      // the self-approve gate requires L3.
      if (isNoApproverDeviceError(err)) return 'needs_device';
      throw new CeremonyError(err);
    }
  } else if (reason?.trim()) {
    body.reason = reason.trim();
  }

  try {
    await runAction({
      // Kept inline rather than hoisted: the no-silent-mutations guard walks
      // parents for an enclosing runAction call, so a hoisted thunk reads as an
      // unwrapped mutation even when passed straight in.
      request: () =>
        fetchWithAuth(`/mobile/approvals/${approvalRequestId}/${decision}`, {
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
  } catch (err) {
    if (isStepUpRequired(err)) return 'needs_device';
    if (isNotSoleApprover(err)) return 'not_sole_approver';
    throw err;
  }

  return 'decided';
}
