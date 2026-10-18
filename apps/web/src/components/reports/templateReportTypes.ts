/**
 * Curated report types created from a template dialog with their own options
 * form (#8796). The freeform builder cannot represent any of them
 * (`reportTypeSurvivesBuilder` is false), so:
 * - their create dialog carries the shared Covers + delivery block
 *   (`TemplateDeliveryFields`), and
 * - their edit page renders that options form plus the builder's delivery
 *   section only, never the custom-builder sections or its live preview.
 * The business types have their own options forms too but a different
 * ownership and delivery model (partner-owned, email-only), so they are not
 * listed here; see `isBusinessReportType`.
 */
export const TEMPLATE_OPTIONS_FORM_REPORT_TYPES: ReadonlySet<string> = new Set([
  'security_compliance_posture',
  'hardware_lifecycle',
  'backup_status',
  'threat_detection_review',
  'endpoint_management_review',
  'vulnerability_management',
  'identity_access_review',
]);

export function hasTemplateOptionsForm(type: string | undefined): boolean {
  return !!type && TEMPLATE_OPTIONS_FORM_REPORT_TYPES.has(type);
}
