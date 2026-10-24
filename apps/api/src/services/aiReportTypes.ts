/**
 * The `reportType` values the `generate_report` AI tool accepts (#9222).
 *
 * Leaf module (no db, no registry) so the three input-schema surfaces —
 * the registry `definition.input_schema`, `aiToolSchemasFleet.ts` and the SDK
 * `tool()` shape in `aiAgentSdkTools.ts` — share one list.
 *
 * The six legacy types, then the business types that exist today
 * (`BUSINESS_REPORT_TYPES`: audience 'msp_staff', gated per type by
 * `BUSINESS_REPORT_REQUIRED_PERMISSIONS`). Types added to the shared list later
 * (#6830) reach this tool only when that list grows; the handler gates them
 * through the registry either way.
 */
import { BUSINESS_REPORT_TYPES } from '@breeze/shared';

export const LEGACY_GENERATE_REPORT_TYPES = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
] as const;

export const GENERATE_REPORT_TYPES = [
  ...LEGACY_GENERATE_REPORT_TYPES,
  ...BUSINESS_REPORT_TYPES,
] as const;

export type GenerateReportType = (typeof GENERATE_REPORT_TYPES)[number];

export function isBusinessReportType(type: unknown): type is (typeof BUSINESS_REPORT_TYPES)[number] {
  return typeof type === 'string' && (BUSINESS_REPORT_TYPES as readonly string[]).includes(type);
}
