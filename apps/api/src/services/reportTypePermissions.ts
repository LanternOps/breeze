import type { ReportType } from '@breeze/shared';
import { permissionGrantMatches } from './permissionMatching';
import { reportTypeDef } from './reportRegistry';
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
