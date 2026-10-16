import type { ControlMarker } from '@breeze/shared';
const pendingKeys = {
  skip: 'autopay.reasons.control_pending:skip',
  exclude: 'autopay.reasons.control_pending:exclude',
  stop: 'autopay.reasons.control_pending:stop',
  renotice: 'autopay.reasons.control_pending:renotice',
} satisfies Record<ControlMarker, string>;
const reasonKeys: Record<string, string> = {
  not_enrolled:'autopay.reasons.not_enrolled', enrolled_after_issue:'autopay.reasons.enrolled_after_issue',
  consent_required:'autopay.reasons.consent_required',
  method_not_usable:'autopay.reasons.method_not_usable', over_cap:'autopay.reasons.over_cap',
  above_authorized_cap:'autopay.reasons.above_authorized_cap',
  issued_before_authorization:'autopay.reasons.issued_before_authorization',
  cap_currency_mismatch:'autopay.reasons.cap_currency_mismatch',ach_currency_unsupported:'autopay.reasons.ach_currency_unsupported',
  excluded_contract:'autopay.reasons.excluded_contract',excluded_invoice:'autopay.reasons.excluded_invoice',
  charging_disabled:'autopay.reasons.charging_disabled',stripe_unavailable:'autopay.reasons.stripe_unavailable',
  bank_unverified:'autopay.reasons.bank_unverified',charging_on_hold:'autopay.reasons.charging_on_hold',
  service_unavailable:'autopay.reasons.service_unavailable',
  skip:'autopay.reasons.skip',exclude:'autopay.reasons.exclude',stop:'autopay.reasons.stop',
  no_billing_contact:'autopay.reasons.no_billing_contact',delivery_failed:'autopay.reasons.delivery_failed',
};
export function autopayReasonKey(reason: string): string {
  for (const [marker,key] of Object.entries(pendingKeys)) if(reason===`control_pending:${marker}`)return key;
  return reasonKeys[reason] ?? 'autopay.attention';
}

// Charge now (staff invoice detail). Every response maps to staff copy; never a raw code.
const ATTEMPTED_OUTCOMES = new Set(['failed', 'canceled', 'requires_action', 'unapplied']);
const declineKeys: Record<string, string> = {
  card_declined: 'autopay.chargeOutcome.cardDeclined', expired_card: 'autopay.chargeOutcome.expiredCard',
  insufficient_funds: 'autopay.chargeOutcome.insufficientFunds', R01: 'autopay.chargeOutcome.insufficientFunds',
};
const refusedKeys: Record<string, string> = {
  notice_lead: 'autopay.chargeRefused.notice_lead', renotice_required: 'autopay.chargeRefused.renotice_required',
  collection_in_progress: 'autopay.chargeRefused.collection_in_progress',
  checkout_session_unrevoked: 'autopay.chargeRefused.checkout_session_unrevoked',
  retry_not_due: 'autopay.chargeRefused.retry_not_due', not_payable: 'autopay.chargeRefused.not_payable',
  nothing_to_pay: 'autopay.chargeRefused.nothing_to_pay', enrollment_inactive: 'autopay.chargeRefused.enrollment_inactive',
  schedule_inactive: 'autopay.chargeRefused.schedule_inactive', schedule_required: 'autopay.chargeRefused.schedule_inactive',
  excluded_contract: 'autopay.chargeRefused.excluded_contract', no_eligible_notice: 'autopay.chargeRefused.no_eligible_notice',
  // The route's own fence answers INVALID_STATE with this message as `error`.
  'Invoice has no eligible notice': 'autopay.chargeRefused.no_eligible_notice',
};
function chargeBody(body: unknown): { outcome?: string; reason: string; code?: string } {
  const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof value.code === 'string' ? value.code : undefined;
  const error = typeof value.error === 'string' ? value.error : '';
  return { outcome: typeof value.outcome === 'string' ? value.outcome : undefined,
    reason: code && code !== 'INVALID_STATE' ? code : error, code };
}
/** FP-17: why a disabled Charge now is disabled (the API's chargeBlockedReason), or null. */
export function chargeBlockedKey(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return refusedKeys[reason] ?? reasonKeys[reason] ?? null;
}
/** A decline, confirmation request, cancellation or capture changed the invoice: refresh it. */
export function chargeNowAttempted(body: unknown): boolean {
  const { outcome } = chargeBody(body);
  return !!outcome && ATTEMPTED_OUTCOMES.has(outcome);
}
/** No usable answer from Charge now (network failure, 5xx, unreadable or missing body): whether
 * the provider charged is unknown, so the caller must not suggest retrying and must refresh. */
/** The second-factor check could not run (routes/billingStepUp.ts): refused before any provider call. */
export const STEP_UP_UNAVAILABLE = 'STEP_UP_UNAVAILABLE';
export function chargeNowResultUnknown(error: { status: number; body?: unknown }): boolean {
  if ((error.body as { code?: unknown } | null | undefined)?.code === STEP_UP_UNAVAILABLE) return false;
  return error.status !== 401 && (error.status === 0 || error.status >= 500 || error.body == null);
}
export function chargeNowSuccessKey(body: unknown): string {
  const state = (body as { data?: { state?: unknown } } | null)?.data?.state;
  return state === 'succeeded' ? 'autopay.chargeOutcome.succeeded'
    : state === 'processing' ? 'autopay.chargeOutcome.processing' : 'autopay.chargeStarted';
}
/** undefined = not a charge outcome (auth, permission, validation): keep the default message. */
export function chargeNowFailureKey(body: unknown): string | undefined {
  const { outcome, reason, code } = chargeBody(body);
  // Stripe reports 3DS as requires_payment_method + authentication_required.
  if (outcome === 'requires_action' || reason === 'authentication_required') return 'autopay.chargeOutcome.requiresAction';
  if (outcome === 'failed') return declineKeys[reason] ?? 'autopay.chargeOutcome.declined';
  // A cancel before confirm carries its reason (a cap or authorization check): name it (R3).
  if (outcome === 'canceled') return refusedKeys[reason] ?? reasonKeys[reason] ?? 'autopay.chargeOutcome.canceled';
  if (outcome === 'unapplied') return 'autopay.chargeOutcome.unapplied';
  if (refusedKeys[reason]) return refusedKeys[reason];
  if (reasonKeys[reason]) return reasonKeys[reason];
  if (outcome === 'deferred' || outcome === 'refused' || code === 'INVALID_STATE') return 'autopay.chargeRefused.generic';
  return undefined;
}
