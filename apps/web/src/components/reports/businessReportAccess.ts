import type { PermissionAction, PermissionResource } from '@breeze/shared';
import { BUSINESS_REPORT_TYPES, type BusinessReportType } from '@breeze/shared';
import { usePermissions } from '@/lib/permissions';

/**
 * Permission(s) required for a user to use each curated business report
 * template (#3198). Source of truth: `requiredPermissions` in
 * `apps/api/src/services/reportRegistry.ts` — keep this map in sync with that
 * registry. This is a client-side UX gate only (hides a card the user cannot
 * use); the server re-checks every permission on create/generate/read.
 */
export const BUSINESS_REPORT_REQUIRED_PERMISSIONS: Record<
  BusinessReportType,
  readonly [PermissionResource, PermissionAction][]
> = {
  ticket_sla_attainment: [['tickets', 'read']],
  technician_time_billability: [
    ['time_entries', 'read'],
    ['tickets', 'read'],
  ],
  ar_aging: [['invoices', 'read']],
};

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
    return BUSINESS_REPORT_REQUIRED_PERMISSIONS[type].every(([resource, action]) => can(resource, action));
  };
}
