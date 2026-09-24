import { notInArray, type AnyColumn, type SQL } from 'drizzle-orm';
import type { ReportType } from '@breeze/shared';
import { permissionGrantMatches } from './permissionMatching';
import {
  isMspStaffReportType,
  MSP_STAFF_REPORT_TYPES,
  REPORT_GENERATORS,
  reportTypeDef,
} from './reportRegistry';
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
/** A caller's resolved permission set (`c.get('permissions')` on a route,
 *  `getUserPermissions(...)` elsewhere). null/undefined = nothing resolved. */
export type GrantedReportPermissions = { permissions: readonly Permission[] } | null | undefined;

export function missingReportTypePermission(
  type: ReportType,
  granted: GrantedReportPermissions,
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

/** The types that list extra read permissions (the business types). Derived
 *  from the registry so there is no second list to keep in step. */
const PERMISSION_GATED_REPORT_TYPES: readonly ReportType[] = Object.freeze(
  Object.values(REPORT_GENERATORS)
    .filter((d) => d.requiredPermissions.length > 0)
    .map((d) => d.type),
);

/**
 * #3198 W02, ruling P8b. The per-type permission gate (ruling P8) extends to
 * READS: a caller who lacks a type's underlying read permissions never sees
 * that type's definitions or runs, on ANY scope — by-id reads answer as if
 * the row did not exist (404), lists exclude it. The types `granted` does not
 * cover; empty when it covers them all.
 */
export function reportTypesMissingPermission(granted: GrantedReportPermissions): ReportType[] {
  return PERMISSION_GATED_REPORT_TYPES.filter(
    (type) => missingReportTypePermission(type, granted) !== null,
  );
}

/**
 * Ruling P8b, the row-level belt: is this stored type hidden from a caller
 * holding `granted`? Takes a plain string (a `reports.type` value); an unknown
 * type is not hidden here (same reasoning as `reportTypeHiddenFromCaller`).
 * Never throws.
 */
/** Ruling P8b: does this stored type list extra read permissions at all?
 *  Lets a caller skip resolving a permission set for every legacy type. */
export function reportTypeRequiresPermissions(type: string): boolean {
  return (PERMISSION_GATED_REPORT_TYPES as readonly string[]).includes(type);
}

export function reportTypeHiddenByPermission(
  type: string,
  granted: GrantedReportPermissions,
): boolean {
  if (!reportTypeRequiresPermissions(type)) return false;
  return missingReportTypePermission(type as ReportType, granted) !== null;
}

/**
 * Ruling P8b, the SQL twin of `reportTypeHiddenByPermission` (as
 * `reportAudienceCondition` is of `reportTypeHiddenFromCaller`):
 * `<typeColumn> NOT IN (<types the caller lacks permission for>)`, or
 * undefined (no predicate; `and()` drops it) when the caller holds them all.
 * partnerOwnedVisibility.scan.test.ts requires every scope that applies
 * `reportAudienceCondition` to apply this too.
 */
export function reportTypePermissionCondition(
  granted: GrantedReportPermissions,
  typeColumn: AnyColumn,
): SQL<unknown> | undefined {
  const missing = reportTypesMissingPermission(granted);
  return missing.length > 0 ? notInArray(typeColumn, missing) : undefined;
}
