import { BUSINESS_REPORT_REQUIRED_PERMISSIONS, BUSINESS_REPORT_TYPES, type BusinessReportType } from '@breeze/shared';
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
 * Returns a `canUse(type)` checker: true for any non-business type (nothing to
 * gate), and for a business type only when the current user holds every
 * permission that type requires.
 */
export function useCanUseBusinessReportType(): (type: string | undefined) => boolean {
  const { can } = usePermissions();
  return (type: string | undefined) => {
    if (!isBusinessReportType(type)) return true;
    return BUSINESS_REPORT_REQUIRED_PERMISSIONS[type].every(({ resource, action }) => can(resource, action));
  };
}
