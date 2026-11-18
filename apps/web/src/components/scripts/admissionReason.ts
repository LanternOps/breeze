import type { TFunction } from 'i18next';

/** Reason codes the admission step can attach to a denied/excluded target. */
export const ADMISSION_REASON_CODES = [
  'not_found_or_inaccessible',
  'site_access_denied',
  'script_org_mismatch',
  'os_incompatible',
  'device_decommissioned',
  'maintenance_suppressed',
] as const;

const KNOWN = new Set<string>(ADMISSION_REASON_CODES);

/** Operator-facing message for a reason code; unknown codes fall back to the raw code. */
export function admissionReasonMessage(t: TFunction, code: string): string {
  if (!KNOWN.has(code)) return code;
  return t(/* i18n-dynamic */ `scripts:scriptExecutionModal.admission.reasons.${code}`);
}
