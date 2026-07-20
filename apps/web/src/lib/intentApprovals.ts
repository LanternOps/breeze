import { fetchWithAuth } from '../stores/auth';
import { getApprovalAssertion } from '../stores/authenticator';
import { i18n } from './i18n';
import { ActionError, runAction } from './runAction';

export type IntentDecisionOutcome = 'decided' | 'needs_device';

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
function isNoApproverDeviceError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'NoApproverDeviceError';
}

/** The server's L3 self-approve rejection (approvals.ts, 403). Same remedy as
 *  a missing authenticator: register a device — so it drives the same CTA. */
function isStepUpRequired(err: unknown): boolean {
  if (!(err instanceof ActionError)) return false;
  const body = err.body as { error?: unknown } | null | undefined;
  return body?.error === 'step_up_required';
}

/**
 * Decide the viewer's own fanned-out approval row for a Tier-3 action intent
 * (the inline chat self-approve, sole-operator case). Approve runs the
 * WebAuthn (Touch ID / Windows Hello) ceremony first — the server's L3
 * self-approve gate refuses a proofless approve — then POSTs the proof to the
 * existing decide endpoint. Deny needs no proof and skips the ceremony.
 *
 * Returns 'needs_device' when no approver device is registered (before any
 * network write) or when the server answers `step_up_required` — the caller
 * should show a "register a device" CTA rather than retrying. Throws
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
  }

  try {
    await runAction({
      request: () =>
        fetchWithAuth(`/mobile/approvals/${approvalRequestId}/${decision}`, {
          method: 'POST',
          body: JSON.stringify(body),
          skipUnauthorizedRetry: true,
        }),
      errorFallback: i18n.t('ai:aiApprovalDialog.decideFailed'),
      treatUnauthorizedAsError: true,
      // The route emits bare machine tokens in `error` with no `code`; without
      // this the user is shown the literal string "step_up_required".
      friendly: (token) =>
        token === 'step_up_required'
          ? i18n.t('ai:aiApprovalDialog.noApproverDevice')
          : undefined,
      successMessage:
        decision === 'approve'
          ? i18n.t('ai:aiApprovalDialog.approvedToast')
          : i18n.t('ai:aiApprovalDialog.deniedToast'),
    });
  } catch (err) {
    if (isStepUpRequired(err)) return 'needs_device';
    throw err;
  }

  return 'decided';
}
