import { notInArray, type AnyColumn, type SQL } from 'drizzle-orm';
import type { ReportType } from '@breeze/shared';
import { permissionGrantMatches } from './permissionMatching';
import { isMspStaffReportType, MSP_STAFF_REPORT_TYPES, reportTypeDef } from './reportRegistry';
// Type-only: `./permissions` imports `db`; this module stays pool-free so the
// report route suites that stub the permissions module wholesale still load it.
import type { Permission } from './permissions';

/**
 * #3198 W02 (spec §2, ruling P8). Business reports reveal money and HR-adjacent
 * data, so a report of that type also requires the UNDERLYING read permissions
 * its registry entry lists (`requiredPermissions`) — the billables-export
 * precedent (`routes/tickets/export.ts`). A route's reports:* grant is
 * necessary but not sufficient.
 *
 * Returns the first required permission `granted` does not satisfy, or null.
 * A type that lists none (every pre-#3198 type) is never refused, even when no
 * permission set was resolved — the route middleware already gated it.
 * Wildcards match through `permissionGrantMatches`, never plain equality
 * (#2874: the seeded Partner Admin holds a single `*|*` grant).
 */
export function missingReportTypePermission(
  type: ReportType,
  granted: { permissions: readonly Permission[] } | null | undefined,
): Permission | null {
  for (const required of reportTypeDef(type).requiredPermissions) {
    const held = granted?.permissions.some((grant) =>
      permissionGrantMatches(grant, required.resource, required.action),
    ) ?? false;
    if (!held) return required;
  }
  return null;
}

/** The route body for a `missingReportTypePermission` refusal. */
export const REPORT_TYPE_PERMISSION_DENIED = { error: 'Insufficient permissions' } as const;

/**
 * #3198 W02, ruling F1 (spec §2: margin, utilization, AR and SLA attainment
 * are internal to the MSP). An `audience: 'msp_staff'` type is invisible to an
 * ORGANIZATION-scope caller — a customer user, or an org API/MCP key. Writes
 * and generates refuse it (403, `REPORT_TYPE_PERMISSION_DENIED`); by-id reads
 * answer as if it did not exist. Partner and system callers are unaffected
 * here: their own gates (P8 type permissions, partner-wide access) decide.
 *
 * Takes a plain string so a stored `reports.type` can be passed straight in.
 * An unknown type is NOT hidden here: `reports.type` is a pg enum, so the only
 * way to get one is a mocked row, and every generate path refuses an unknown
 * type through `reportTypeDef` anyway. Never throws.
 */
export function reportTypeHiddenFromCaller(
  type: string,
  auth: { scope: string } | null | undefined,
): boolean {
  return auth?.scope === 'organization' && isMspStaffReportType(type);
}

/**
 * The SQL twin of `reportTypeHiddenFromCaller` for list and by-id queries:
 * `<typeColumn> NOT IN (<msp_staff types>)` for an organization-scope caller,
 * undefined (no predicate; `and()` drops it) for every other scope. The column
 * is a parameter so this module stays schema- and pool-free; callers pass
 * `reports.type`. partnerOwnedVisibility.scan.test.ts requires every org-scope
 * tenant predicate and every AI report reader to call it.
 */
export function reportAudienceCondition(
  auth: { scope: string },
  typeColumn: AnyColumn,
): SQL<unknown> | undefined {
  return auth.scope === 'organization'
    ? notInArray(typeColumn, [...MSP_STAFF_REPORT_TYPES])
    : undefined;
}
