import {
  BUSINESS_REPORT_REQUIRED_PERMISSIONS,
  BUSINESS_REPORT_TYPES,
  REPORT_TYPE_REQUIRED_PERMISSIONS,
  type BusinessReportType,
  type ReportType,
} from '@breeze/shared';
import { usePermissions } from '@/lib/permissions';

/**
 * Permission(s) required for a user to use each curated business report
 * template (#3198). Re-exported from `@breeze/shared` — the same object the API
 * registry's `requiredPermissions` points at, so the two cannot drift. This is
 * a client-side UX gate only (hides a card the user cannot use); the server
 * re-checks every permission on create/generate/read.
 */
export { BUSINESS_REPORT_REQUIRED_PERMISSIONS };

export function isBusinessReportType(type: string | undefined): type is BusinessReportType {
  return !!type && (BUSINESS_REPORT_TYPES as readonly string[]).includes(type);
}

/**
 * Returns a `canUse(type)` checker: true for a type that requires no underlying
 * read grant, and otherwise only when the current user holds every permission
 * the type requires (the business types, plus ticket_sla_performance).
 */
export function useCanUseBusinessReportType(): (type: string | undefined) => boolean {
  const { can } = usePermissions();
  return (type: string | undefined) => {
    const required = type ? REPORT_TYPE_REQUIRED_PERMISSIONS[type as ReportType] : undefined;
    return !required || required.every(({ resource, action }) => can(resource, action));
  };
}
