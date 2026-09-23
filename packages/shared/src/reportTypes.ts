import { PERMISSION_GRANTS, type PermissionGrant } from './constants/permissions';

/**
 * THE canonical list of report types (#3198 spec §6). `reportTypeSchema`
 * (apps/api/src/routes/reports/schemas.ts), the API `ReportType` union
 * (apps/api/src/services/reportGenerationService.ts) and the web union
 * (apps/web/src/components/reports/ReportsList.tsx) all derive from this
 * tuple.
 *
 * The ONE place that still hand-lists the values is the Drizzle pgEnum
 * `reportTypeEnum` (apps/api/src/db/schema/reports.ts) — a pgEnum's value
 * order is a shipped database fact, so it cannot be spread from a tuple that
 * a later author might reorder. `reportGenerationService.test.ts` asserts the
 * two agree.
 *
 * ORDER IS LOAD-BEARING: this is `report_type` enum order. Append new types
 * at the end; never reorder.
 */
export const REPORT_TYPES = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  // P2-3 (#4190) / Fleet Designer W01 (#5651): STORED artifacts, never
  // generated on demand — their `report_runs` row is written once inside the
  // originating agent/design run's own transaction from a model-authored
  // narrative/design no query could reproduce. Members of this union (rather
  // than excluded from it) so every exhaustive switch is forced to say what
  // happens to them.
  'ai_org_narrative',
  'ai_fleet_design',
  // Hardware Lifecycle: device replacement plan from purchase + warranty
  // dates, generated on demand.
  'hardware_lifecycle',
  // Service-plan evidence (#5784 W02/W03/W04/W06): generated on demand and by
  // the managed-evidence system path.
  'threat_detection_review',
  'endpoint_management_review',
  'vulnerability_management',
  'identity_access_review',
  // #3198 Phase 1 business reports. Never portal-visible, never managed
  // evidence; the only types whose supportedScopes include 'partner'.
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
] as const satisfies readonly string[];

export type ReportType = (typeof REPORT_TYPES)[number];

/** The #3198 Phase 1 trio. Used by the registry's scope table and by W03's
 *  "Business" template grouping. */
export const BUSINESS_REPORT_TYPES = [
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
] as const satisfies readonly ReportType[];

export type BusinessReportType = (typeof BUSINESS_REPORT_TYPES)[number];

/**
 * The underlying read grants each business report type requires (#3198 W02,
 * ruling P8) — THE one source: the API registry's `requiredPermissions`
 * (apps/api/src/services/reportRegistry.ts) points at these entries, and the
 * web gallery's card gate (apps/web/src/components/reports/
 * businessReportAccess.ts) re-exports this object. Both pin identity in tests.
 */
export const BUSINESS_REPORT_REQUIRED_PERMISSIONS = {
  ticket_sla_attainment: [PERMISSION_GRANTS.TICKETS_READ],
  technician_time_billability: [PERMISSION_GRANTS.TIME_ENTRIES_READ, PERMISSION_GRANTS.TICKETS_READ],
  ar_aging: [PERMISSION_GRANTS.INVOICES_READ],
} as const satisfies Record<BusinessReportType, readonly PermissionGrant[]>;

const REPORT_TYPE_SET: ReadonlySet<string> = new Set(REPORT_TYPES);

export function isReportType(value: string): value is ReportType {
  return REPORT_TYPE_SET.has(value);
}
