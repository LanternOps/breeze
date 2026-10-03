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
  cap_currency_mismatch:'autopay.reasons.cap_currency_mismatch',ach_currency_unsupported:'autopay.reasons.ach_currency_unsupported',
  excluded_contract:'autopay.reasons.excluded_contract',excluded_invoice:'autopay.reasons.excluded_invoice',
  charging_disabled:'autopay.reasons.charging_disabled',stripe_unavailable:'autopay.reasons.stripe_unavailable',
  skip:'autopay.reasons.skip',exclude:'autopay.reasons.exclude',stop:'autopay.reasons.stop',
  no_billing_contact:'autopay.reasons.no_billing_contact',delivery_failed:'autopay.reasons.delivery_failed',
};
export function autopayReasonKey(reason: string): string {
  for (const [marker,key] of Object.entries(pendingKeys)) if(reason===`control_pending:${marker}`)return key;
  return reasonKeys[reason] ?? 'autopay.attention';
}
