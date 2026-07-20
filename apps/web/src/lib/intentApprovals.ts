import { fetchWithAuth } from '../stores/auth';
import { getApprovalAssertion } from '../stores/authenticator';
import { runAction } from './runAction';

export type IntentDecisionOutcome = 'decided' | 'needs_device';

/**
 * True when the assertion ceremony failed because the viewer has no registered
 * approver device (the challenge carried no allowCredentials). A genuine
 * cancelled/timed-out ceremony surfaces as a DOMException and must NOT match —
 * the caller aborts instead. Mirrors PamRespondModal's helper of the same
 * name; the outcome here is a "register a device" CTA rather than an L1
 * fallback, because the sole-operator self-approve gate on the server
 * (approvals.ts) REQUIRES an L3 proof and refuses a proofless approve.
 */
function isNoApproverDeviceError(err: unknown): boolean {
  if (err instanceof DOMException) return false;
  return (err as { name?: string } | null)?.name === 'NoApproverDeviceError';
}

/**
 * Decide the viewer's own fanned-out approval row for a Tier-3 action intent
 * (the inline chat self-approve, sole-operator case). Approve runs the
 * WebAuthn (Touch ID / Windows Hello) ceremony first — the server's L3
 * self-approve gate refuses a proofless approve — then POSTs the proof to the
 * existing decide endpoint. Deny needs no proof and skips the ceremony.
 *
 * Returns 'needs_device' (before any network write) when no approver device
 * is registered — the caller should show a "register a device" CTA rather
 * than retrying. Throws on a cancelled/failed ceremony and on server
 * rejection (runAction has already toasted the latter).
 *
 * Toast copy is plain English, not i18next: this is a non-component lib
 * helper (no `useTranslation` hook to draw from), the shared `i18n` singleton
 * (`./i18n`) exports a named `i18n` — not the default import the original
 * sketch assumed — and the `aiApprovalDialog.decideFailed` /
 * `.approvedToast` / `.deniedToast` keys it would need don't exist in
 * locales/en/ai.json yet. `apps/web/src/lib/i18n/keyUsage.test.ts` statically
 * flags any `t(...)` or `i18n.t(...)` call site whose literal key is missing
 * from the en catalog, repo-wide — so referencing not-yet-created keys here
 * would redden that unrelated contract test. Task 5 owns "+ i18n" for the
 * approval dialog; once it adds those keys, swap these literals for calls
 * through its `useTranslation('ai')` `t`.
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
      throw err;
    }
  }

  await runAction({
    request: () =>
      fetchWithAuth(`/mobile/approvals/${approvalRequestId}/${decision}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    errorFallback: 'Failed to submit the decision',
    successMessage: decision === 'approve' ? 'Action approved' : 'Action denied',
  });

  return 'decided';
}
